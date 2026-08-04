'use strict';
import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  initDb, runStartupMaintenance,
  hashPassword, verifyPassword,
  createUser, getUserByEmail, getUserById, listUsers, updateUser,
  createSession, getSessionUser, deleteSession, deleteUserSessions,
  createJob, listJobs, getJob, cancelJob, retryJob,
  createLesson, listLessons, getLesson, updateLesson, deleteLesson, incrementLessonViews, getLessonByJobId,
  getStats, getSystemConfig, setSystemConfig, listProblemCatalog, setProblemCatalogEntry, listLessonAssets
} from './db.js';
import { publicUser, validateRegisterPayload, normalizeRole, ROLES, isAdmin, isTeacher } from './services/rbac.js';
import { listSkills, getSkill, getProblemType, skillsInstalled } from './services/skillCatalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3002);

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'lessons'), { recursive: true });

for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (...args) => {
    if (method === 'get' && args.length === 1) return register(args[0]);
    return register(args[0], ...args.slice(1).map(handler => {
      if (typeof handler !== 'function' || handler.length >= 4) return handler;
      return (req, res, next) => {
        try {
          const returned = handler(req, res, next);
          if (returned?.catch) returned.catch(next);
        } catch (error) { next(error); }
      };
    }));
  };
}

process.on('unhandledRejection', reason => console.error('[api] unhandled rejection', reason));

const corsOrigins = String(process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const corsOptions = corsOrigins.length
  ? { origin: corsOrigins }
  : (process.env.NODE_ENV === 'production' ? { origin: false } : undefined);
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

const rateBuckets = new Map();
function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || req.socket.remoteAddress || 'unknown'}:${req.user?.id || ''}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.started >= windowMs) rateBuckets.set(key, { started: now, count: 1 });
    else if (++bucket.count > limit) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    next();
  };
}

function auth(required = true) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const user = await getSessionUser(token);
      if (!user && required) return res.status(401).json({ error: '未登录' });
      if (user && user.status && user.status !== 'active') return res.status(401).json({ error: '账号已禁用' });
      req.user = user;
      req.token = token;
      next();
    } catch (error) { next(error); }
  };
}

function requireRole(...roles) {
  const allowed = new Set(roles.map(normalizeRole));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!allowed.has(normalizeRole(req.user.role))) return res.status(403).json({ error: '权限不足' });
    next();
  };
}

function stripLessonPath(lesson) {
  if (!lesson) return lesson;
  const { htmlPath, ...publicLesson } = lesson;
  return publicLesson;
}

const previewSecret = process.env.PREVIEW_SIGNING_SECRET || process.env.SESSION_SIGNING_SECRET || 'change-this-preview-secret';
function signPreview(lessonId, expiresAt) {
  return crypto.createHmac('sha256', previewSecret).update(`${lessonId}.${expiresAt}`).digest('base64url');
}
function validPreviewSignature(lessonId, expiresAt, signature) {
  if (!signature || !/^\d+$/.test(String(expiresAt)) || Number(expiresAt) < Date.now()) return false;
  const expected = signPreview(lessonId, Number(expiresAt));
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))); } catch { return false; }
}

// ---------- Health ----------
app.get('/health', (_req, res) => {
  res.json({ ok: true, skillsInstalled: skillsInstalled() });
});

// ---------- Auth ----------
app.post('/api/auth/register', rateLimit('register', 5, 10 * 60_000), async (req, res) => {
  const { email, password, nickname } = req.body || {};
  const { errors } = validateRegisterPayload({ email, password, nickname });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const normalizedEmail = email.trim().toLowerCase();
  if (await getUserByEmail(normalizedEmail)) return res.status(409).json({ error: '邮箱已注册' });
  let user;
  try {
    user = await createUser({ email: normalizedEmail, nickname: nickname.trim(), passwordHash: hashPassword(password), role: ROLES.STUDENT });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '邮箱已注册' });
    throw error;
  }
  const token = await createSession(user.id);
  res.json({ user: publicUser(user), token });
});

app.post('/api/auth/login', rateLimit('login', 20, 10 * 60_000), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });
  const user = await getUserByEmail(String(email).trim().toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: '邮箱或密码错误' });
  if (user.status !== 'active') return res.status(401).json({ error: '账号已禁用' });
  const token = await createSession(user.id);
  res.json({ user: publicUser(user), token });
});

app.post('/api/auth/logout', auth(false), async (req, res) => {
  if (req.token) await deleteSession(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth(true), (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.patch('/api/me/profile', auth(true), async (req, res) => {
  const { nickname } = req.body || {};
  const patch = {};
  if (nickname && nickname.trim()) patch.nickname = nickname.trim();
  if (req.body?.password) {
    if (String(req.body.password).length < 6 || String(req.body.password).length > 128) return res.status(400).json({ error: '密码长度必须为 6-128 位' });
    patch.passwordHash = hashPassword(req.body.password);
  }
  const user = await updateUser(req.user.id, patch);
  if (patch.passwordHash) await deleteUserSessions(req.user.id);
  res.json({ user: publicUser(user) });
});

// ---------- Catalog ----------
app.get('/api/catalog/skills', auth(false), async (_req, res) => {
  const catalog = await listProblemCatalog();
  const enabled = new Set(catalog.filter(item => Number(item.enabled) !== 0).map(item => `${item.skill_id}:${item.problem_type}`));
  const skills = listSkills().map(skill => ({ ...skill, problemTypes: skill.problemTypes.filter(problem => enabled.size === 0 || enabled.has(`${skill.id}:${problem.key}`)) })).filter(skill => skill.problemTypes.length);
  res.json({ skills, installed: skillsInstalled() });
});

// ---------- Jobs ----------
app.post('/api/jobs', auth(true), rateLimit('jobs', 10, 60_000), async (req, res) => {
  const { skillId, problemType, params, title } = req.body || {};
  if (!skillId || !problemType) return res.status(400).json({ error: '请选择学科和题型' });
  if (!getSkill(skillId)) return res.status(400).json({ error: '未知学科: ' + skillId });
  if (!getProblemType(skillId, problemType)) return res.status(400).json({ error: '未知题型: ' + problemType });
  const catalogEntry = (await listProblemCatalog()).find(item => item.skill_id === skillId && item.problem_type === problemType);
  if (catalogEntry && Number(catalogEntry.enabled) === 0) return res.status(400).json({ error: '该题型暂未开放' });
  if (title != null && (typeof title !== 'string' || title.length > 512)) return res.status(400).json({ error: '标题长度不能超过 512 个字符' });
  if (params != null && (typeof params !== 'object' || Array.isArray(params))) return res.status(400).json({ error: 'params 必须是对象' });
  if (params != null && JSON.stringify(params).length > 64 * 1024) return res.status(400).json({ error: 'params 过大' });
  const userJobs = await listJobs({ userId: req.user.id });
  if (userJobs.filter(job => ['queued', 'running'].includes(job.status)).length >= 3) return res.status(429).json({ error: '当前任务过多，请等待已有任务完成' });
  if (!skillsInstalled()) return res.status(503).json({ error: 'edulab 技能未安装，请先 npm install @wy51ai/edulab' });
  const job = await createJob({ userId: req.user.id, skillId, problemType, params: params || {}, title: title || '' });
  res.json({ job });
});

app.get('/api/jobs', auth(true), async (req, res) => {
  const jobs = await listJobs({ userId: req.user.id, isAdmin: isAdmin(req.user) });
  res.json({ jobs });
});

app.get('/api/jobs/:id', auth(true), async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.userId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: '无权访问' });
  const lesson = job.resultLessonId ? await getLesson(job.resultLessonId) : null;
  res.json({ job, lesson: lesson ? stripLessonPath(lesson) : null });
});

app.post('/api/jobs/:id/cancel', auth(true), async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.userId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: '无权操作' });
  const updated = await cancelJob(job.id);
  res.json({ job: updated });
});

app.post('/api/jobs/:id/retry', auth(true), async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.userId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: '无权操作' });
  if (!['failed', 'cancelled'].includes(job.status)) return res.status(409).json({ error: '只有失败或已取消的任务可以重试' });
  res.json({ job: await retryJob(job.id) });
});

// ---------- Lessons ----------
app.get('/api/lessons', auth(false), async (req, res) => {
  const userId = req.user?.id;
  const admin = isAdmin(req.user);
  const visibility = req.query.visibility || null;
  const publishStatus = req.query.publishStatus || null;
  const lessons = await listLessons({ userId, isAdmin: admin, visibility, publishStatus });
  res.json({ lessons: lessons.map(lesson => stripLessonPath(lesson)) });
});

app.get('/api/me/lessons', auth(true), async (req, res) => {
  const lessons = await listLessons({ userId: req.user.id, isAdmin: false });
  res.json({ lessons: lessons.map(lesson => stripLessonPath(lesson)) });
});

app.get('/api/lessons/:id', auth(false), async (req, res) => {
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  const publicAccess = lesson.visibility === 'public' && lesson.publishStatus === 'approved';
  if (!publicAccess && (!req.user || (req.user.id !== lesson.userId && !isAdmin(req.user)))) {
    return res.status(403).json({ error: '无权访问' });
  }
  res.json({ lesson: stripLessonPath(lesson) });
});

app.get('/api/lessons/:id/assets', auth(false), async (req, res) => {
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  const publicAccess = lesson.visibility === 'public' && lesson.publishStatus === 'approved';
  if (!publicAccess && (!req.user || (req.user.id !== lesson.userId && !isAdmin(req.user)))) return res.status(403).json({ error: '无权访问' });
  res.json({ assets: await listLessonAssets(lesson.id) });
});

app.patch('/api/lessons/:id', auth(true), async (req, res) => {
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  if (lesson.userId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: '无权操作' });
  const admin = isAdmin(req.user);
  const patch = {};
  if (req.body?.title != null) {
    if (typeof req.body.title !== 'string' || req.body.title.length > 512) return res.status(400).json({ error: '标题长度不能超过 512 个字符' });
    patch.title = req.body.title;
  }
  if (req.body?.summary != null) {
    if (typeof req.body.summary !== 'string' || req.body.summary.length > 5000) return res.status(400).json({ error: '摘要长度不能超过 5000 个字符' });
    patch.summary = req.body.summary;
  }
  if (req.body?.visibility != null && !['private', 'public'].includes(req.body.visibility)) return res.status(400).json({ error: 'visibility 无效' });
  if (req.body?.publishStatus != null && !['draft', 'pending', 'approved', 'rejected'].includes(req.body.publishStatus)) return res.status(400).json({ error: 'publishStatus 无效' });
  if (admin) {
    if (req.body?.visibility != null) patch.visibility = req.body.visibility;
    if (req.body?.publishStatus != null) patch.publishStatus = req.body.publishStatus;
  } else {
    if (req.body?.visibility != null) {
      patch.visibility = req.body.visibility;
      patch.publishStatus = req.body.visibility === 'public' ? 'pending' : 'draft';
    }
    if (req.body?.publishStatus === 'pending' || req.body?.publishStatus === 'draft') patch.publishStatus = req.body.publishStatus;
    if (['approved', 'rejected'].includes(req.body?.publishStatus)) return res.status(403).json({ error: '审核状态只能由管理员设置' });
  }
  const updated = await updateLesson(lesson.id, patch);
  res.json({ lesson: stripLessonPath(updated) });
});

app.post('/api/lessons/:id/submit', auth(true), async (req, res) => {
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  if (lesson.userId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: '无权操作' });
  res.json({ lesson: stripLessonPath(await updateLesson(lesson.id, { publishStatus: 'pending', visibility: 'public' })) });
});

app.post('/api/lessons/:id/preview-url', auth(true), async (req, res) => {
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  if (lesson.userId !== req.user.id && !isAdmin(req.user) && !(lesson.visibility === 'public' && lesson.publishStatus === 'approved')) {
    return res.status(403).json({ error: '无权访问' });
  }
  const expiresAt = Date.now() + 2 * 60_000;
  res.json({ url: `/lessons/${encodeURIComponent(lesson.id)}/view?exp=${expiresAt}&sig=${signPreview(lesson.id, expiresAt)}`, expiresAt });
});

app.delete('/api/lessons/:id', auth(true), async (req, res) => {
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  if (lesson.userId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: '无权操作' });
  await deleteLesson(lesson.id);
  try { fs.rmSync(path.dirname(lesson.htmlPath), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// ---------- Lesson HTML serving ----------
app.get('/lessons/:id/view', auth(false), async (req, res) => {
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).send('课件不存在');
  const publicAccess = lesson.visibility === 'public' && lesson.publishStatus === 'approved';
  const signedAccess = validPreviewSignature(lesson.id, req.query.exp, req.query.sig);
  if (!publicAccess && !signedAccess && (!req.user || (req.user.id !== lesson.userId && !isAdmin(req.user)))) {
    return res.status(403).send('无权访问');
  }
  const htmlPath = lesson.htmlPath;
  if (!fs.existsSync(htmlPath)) return res.status(404).send('课件文件已丢失');
  await incrementLessonViews(lesson.id);
  res.sendFile(htmlPath);
});

// ---------- Admin ----------
app.get('/api/admin/stats', auth(true), requireRole(ROLES.ADMIN), async (_req, res) => {
  const stats = await getStats();
  res.json(stats);
});

app.get('/api/admin/config', auth(true), requireRole(ROLES.ADMIN), async (_req, res) => {
  const config = await getSystemConfig();
  res.json({ config: {
    worker_concurrency: config.worker_concurrency,
    python_bin: config.python_bin,
    lesson_artifacts_root: config.lesson_artifacts_root
  } });
});

app.patch('/api/admin/config', auth(true), requireRole(ROLES.ADMIN), async (req, res) => {
  const allowed = ['worker_concurrency', 'python_bin', 'lesson_artifacts_root'];
  for (const key of allowed) {
    if (req.body?.[key] == null) continue;
    const value = String(req.body[key]);
    if (key === 'worker_concurrency' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 16)) {
      return res.status(400).json({ error: 'worker_concurrency 必须是 1-16 的整数' });
    }
    if (value.length > 512) return res.status(400).json({ error: `${key} 长度过长` });
    await setSystemConfig(key, value);
  }
  res.json({ config: await getSystemConfig() });
});

app.get('/api/admin/catalog', auth(true), requireRole(ROLES.ADMIN), async (_req, res) => {
  res.json({ catalog: await listProblemCatalog() });
});

app.patch('/api/admin/catalog/:skillId/:problemType', auth(true), requireRole(ROLES.ADMIN), async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔值' });
  if (!getProblemType(req.params.skillId, req.params.problemType)) return res.status(404).json({ error: '题型不存在' });
  await setProblemCatalogEntry(req.params.skillId, req.params.problemType, enabled);
  res.json({ catalog: await listProblemCatalog() });
});

app.get('/api/admin/users', auth(true), requireRole(ROLES.ADMIN), async (_req, res) => {
  const users = await listUsers();
  res.json({ users: users.map(u => publicUser(u)) });
});

app.patch('/api/admin/users/:id', auth(true), requireRole(ROLES.ADMIN), async (req, res) => {
  const patch = {};
  if (req.body?.role && ![ROLES.STUDENT, ROLES.TEACHER, ROLES.ADMIN].includes(req.body.role)) return res.status(400).json({ error: '角色无效' });
  if (req.body?.status && !['active', 'disabled'].includes(req.body.status)) return res.status(400).json({ error: '状态无效' });
  if (req.body?.role) patch.role = req.body.role;
  if (req.body?.status) patch.status = req.body.status;
  if (req.params.id === req.user.id && (patch.role && patch.role !== ROLES.ADMIN || patch.status === 'disabled')) {
    return res.status(400).json({ error: '不能移除或禁用当前管理员账号' });
  }
  const user = await updateUser(req.params.id, patch);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: publicUser(user) });
});

app.get('/api/admin/jobs', auth(true), requireRole(ROLES.ADMIN), async (_req, res) => {
  const jobs = await listJobs({ isAdmin: true });
  res.json({ jobs });
});

app.get('/api/admin/lessons', auth(true), requireRole(ROLES.ADMIN), async (req, res) => {
  const lessons = await listLessons({ isAdmin: true, publishStatus: req.query.publishStatus || null });
  res.json({ lessons: lessons.map(stripLessonPath) });
});

app.post('/api/admin/lessons/:id/review', auth(true), requireRole(ROLES.ADMIN), async (req, res) => {
  const { action } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action 必须是 approve 或 reject' });
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  const updated = await updateLesson(lesson.id, {
    publishStatus: action === 'approve' ? 'approved' : 'rejected',
    visibility: action === 'approve' ? 'public' : 'private'
  });
  res.json({ lesson: stripLessonPath(updated) });
});

app.get('/api/teacher/lessons', auth(true), requireRole(ROLES.TEACHER, ROLES.ADMIN), async (_req, res) => {
  const lessons = await listLessons({ isAdmin: true, publishStatus: 'pending' });
  res.json({ lessons: lessons.map(stripLessonPath) });
});

app.post('/api/teacher/lessons/:id/review', auth(true), requireRole(ROLES.TEACHER, ROLES.ADMIN), async (req, res) => {
  const { action } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action 必须是 approve 或 reject' });
  const lesson = await getLesson(req.params.id);
  if (!lesson) return res.status(404).json({ error: '课件不存在' });
  const updated = await updateLesson(lesson.id, { publishStatus: action === 'approve' ? 'approved' : 'rejected', visibility: action === 'approve' ? 'public' : 'private' });
  res.json({ lesson: stripLessonPath(updated) });
});

// Keep unknown API calls machine-readable even when the SPA is served.
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

// ---------- Static frontend (production) ----------
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ---------- Start ----------
initDb().then(async () => {
  const maint = await runStartupMaintenance();
  if (maint.droppedSessions) console.log('[api] dropped', maint.droppedSessions, 'legacy sessions');
  app.listen(PORT, () => {
    console.log(`[api] EduLab server listening on http://localhost:${PORT}`);
    console.log('[api] skills installed:', skillsInstalled());
  });
}).catch(err => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
