'use strict';
import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
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
  getStats, getSystemConfig, setSystemConfig, listProblemCatalog, setProblemCatalogEntry, listLessonAssets,
  createAiJob, createAiImageDraft, getAiImageDraft, updateAiImageDraft
} from './db.js';
import { publicUser, validateRegisterPayload, normalizeRole, ROLES, isAdmin, isTeacher } from './services/rbac.js';
import { listSkills, getSkill, getProblemType, skillsInstalled } from './services/skillCatalog.js';
import { healthCheck as sub2apiHealthCheck } from './services/llm/sub2apiClient.js';
import { getAiRuntimeConfig, publicAiConfig, roleAllowedForAi, quotaLimitForRole } from './services/ai/config.js';
import { getQuotaStatus, consumeAiQuota, quotaDate } from './services/ai/quota.js';
import { recognizeProblemFromImage, saveImageAsset, stripDataUrl, buildConfirmSourceText } from './services/ai/image/recognize.js';

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
app.use(express.json({ limit: '8mb' }));
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
app.get('/health', async (_req, res) => {
  const ai = await getAiRuntimeConfig();
  res.json({ ok: true, skillsInstalled: skillsInstalled(), ai: { enabled: ai.enabled, sub2apiConfigured: ai.sub2api.configured } });
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
  const kind = req.query.kind ? String(req.query.kind) : '';
  if (kind && !['ai', 'fixed'].includes(kind)) return res.status(400).json({ error: 'kind 仅支持 ai 或 fixed' });
  const jobs = await listJobs({ userId: req.user.id, isAdmin: isAdmin(req.user), kind: kind || undefined });
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
  if (job.kind === 'ai') {
    try { await consumeAiQuota(req.user); }
    catch (error) {
      if (error.code === 'QUOTA_EXCEEDED') return res.status(429).json({ error: error.message, code: error.code, quota: error.quota });
      if (error.code === 'AI_DISABLED' || error.code === 'AI_ROLE_FORBIDDEN') return res.status(403).json({ error: error.message, code: error.code });
      throw error;
    }
  }
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


// ---------- AI (M0 skeleton) ----------
const AI_SKILL_HINTS = new Set(['edu-chem-reaction', 'edu-analytic-geometry', 'edu-solid-geometry']);

app.get('/api/ai/quota', auth(true), async (req, res) => {
  res.json({ quota: await getQuotaStatus(req.user) });
});

app.get('/api/ai/health', auth(true), requireRole(ROLES.ADMIN, ROLES.TEACHER), async (_req, res) => {
  const ai = await getAiRuntimeConfig();
  const health = await sub2apiHealthCheck({ baseUrl: ai.sub2api.baseUrl, model: ai.sub2api.model });
  res.json({ ai: publicAiConfig(ai), sub2api: health });
});

app.post('/api/ai/jobs', auth(true), rateLimit('ai_jobs', 20, 60_000), async (req, res) => {
  const ai = await getAiRuntimeConfig();
  if (!ai.enabled) return res.status(403).json({ error: 'AI 生成未启用', code: 'AI_DISABLED' });
  if (!roleAllowedForAi(ai, req.user.role)) return res.status(403).json({ error: '当前角色不允许使用 AI 生成', code: 'AI_ROLE_FORBIDDEN' });

  const inputMode = String(req.body?.inputMode || '').trim();
  if (!['text', 'equation'].includes(inputMode)) {
    return res.status(400).json({ error: 'inputMode 仅支持 text 或 equation（图片请走 /api/ai/image-drafts）' });
  }
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content 不能为空' });
  if (content.length > 8000) return res.status(400).json({ error: 'content 过长' });

  const skillHint = req.body?.skillHint ? String(req.body.skillHint).trim() : '';
  if (skillHint && !AI_SKILL_HINTS.has(skillHint)) return res.status(400).json({ error: 'skillHint 不合法' });

  const idempotencyKey = req.body?.idempotencyKey ? String(req.body.idempotencyKey).trim().slice(0, 128) : '';
  let created;
  try {
    created = await createAiJob({
      userId: req.user.id,
      quotaLimit: quotaLimitForRole(ai, req.user.role),
      usageDate: quotaDate(),
      skillId: skillHint || '',
      problemType: 'ai_dynamic',
      params: { options: req.body?.options || {} },
      title: String(req.body?.options?.title || req.body?.title || '').slice(0, 200),
      inputMode,
      sourceText: content,
      skillHint: skillHint || null,
      idempotencyKey: idempotencyKey || null,
      aiMeta: { provider: 'sub2api', pipeline: 'm0_skeleton', requestedAt: new Date().toISOString() }
    });
  }
  catch (error) {
    if (error.code === 'QUOTA_EXCEEDED') return res.status(429).json({ error: error.message, code: error.code, quota: error.quota });
    if (error.code === 'AI_DISABLED' || error.code === 'AI_ROLE_FORBIDDEN') return res.status(403).json({ error: error.message, code: error.code });
    throw error;
  }
  res.status(created.reused ? 200 : 202).json({ job: created.job, reused: created.reused, quota: created.quota });
});

app.post('/api/ai/image-drafts', auth(true), rateLimit('ai_drafts', 30, 60_000), imageUpload.single('file'), async (req, res) => {
  const ai = await getAiRuntimeConfig();
  if (!ai.enabled) return res.status(403).json({ error: 'AI 生成未启用', code: 'AI_DISABLED' });
  if (!roleAllowedForAi(ai, req.user.role)) return res.status(403).json({ error: '当前角色不允许使用 AI 生成', code: 'AI_ROLE_FORBIDDEN' });

  const skillHint = req.body?.skillHint ? String(req.body.skillHint).trim() : '';
  if (skillHint && !AI_SKILL_HINTS.has(skillHint)) return res.status(400).json({ error: 'skillHint 不合法' });
  const note = String(req.body?.note || req.body?.content || '').trim();
  const imageUrl = String(req.body?.imageUrl || req.body?.url || '').trim();
  const rawImage = req.file?.buffer
    ? req.file.buffer.toString('base64')
    : (req.body?.imageBase64 || req.body?.image || req.body?.base64 || '');

  if (!imageUrl && !rawImage) {
    return res.status(400).json({ error: '请提供 multipart 文件、imageBase64 或 imageUrl' });
  }

  let mimeType = String(req.file?.mimetype || req.body?.mimeType || 'image/png');
  let base64 = '';
  if (rawImage) {
    const parsed = stripDataUrl(rawImage);
    base64 = parsed.base64;
    if (parsed.mimeType) mimeType = parsed.mimeType;
  }

  // create draft id first for asset naming via temporary draft then update? save after draft create
  let recognition = null;
  let warnings = [];
  let editable = { skillId: skillHint || '', problemText: note || '', equation: '', conditions: '', ask: '' };
  let confidence = 0;
  let assetPath = imageUrl;

  if (imageUrl || base64) {
    try {
      recognition = await recognizeProblemFromImage({
        imageBase64: base64 || undefined,
        imageUrl: imageUrl || undefined,
        mimeType,
        skillHint,
        note,
        model: ai.sub2api?.visionModel || ai.sub2api?.model || process.env.SUB2API_VISION_MODEL || process.env.SUB2API_MODEL
      });
      editable = {
        skillId: recognition.skillId || skillHint || '',
        problemText: recognition.editable.problemText || note || '',
        equation: recognition.editable.equation || '',
        conditions: recognition.editable.conditions || '',
        ask: recognition.editable.ask || '',
        language: recognition.editable.language || 'zh-CN'
      };
      confidence = recognition.confidence;
      warnings = recognition.warnings || [];
      if (recognition.degraded) warnings.push('已降级识别（视觉模型不可用）');
    } catch (error) {
      warnings = [`识图失败: ${error.message}`, '请手工填写 editable 后确认'];
      confidence = 0;
      recognition = { error: error.message, code: error.code || 'VISION_FAILED' };
    }
  }

  const draft = await createAiImageDraft({
    userId: req.user.id,
    skillHint: editable.skillId || skillHint,
    assetPath,
    editable,
    rawRecognition: recognition,
    confidence,
    warnings
  });

  // persist image after draft id known
  if (base64) {
    try {
      const saved = saveImageAsset({ draftId: draft.id, base64, mimeType });
      assetPath = saved.relPath || saved.absPath;
      await updateAiImageDraft(draft.id, { assetPath });
    } catch (error) {
      warnings = [...(warnings || []), `图片落盘失败: ${error.message}`];
      await updateAiImageDraft(draft.id, { warnings });
    }
  }

  res.status(201).json({ draft: await getAiImageDraft(draft.id), recognitionMeta: recognition ? {
    model: recognition.model,
    usage: recognition.usage,
    degraded: recognition.degraded || false
  } : null });
});

app.get('/api/ai/image-drafts/:id', auth(true), async (req, res) => {
  const draft = await getAiImageDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: '草稿不存在' });
  if (!isAdmin(req.user) && draft.userId !== req.user.id) return res.status(403).json({ error: '无权查看' });
  res.json({ draft });
});

app.patch('/api/ai/image-drafts/:id', auth(true), async (req, res) => {
  const draft = await getAiImageDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: '草稿不存在' });
  if (!isAdmin(req.user) && draft.userId !== req.user.id) return res.status(403).json({ error: '无权修改' });
  if (draft.status !== 'pending_confirm') return res.status(400).json({ error: '草稿不可编辑' });
  const editable = req.body?.editable && typeof req.body.editable === 'object' ? { ...draft.editable, ...req.body.editable } : draft.editable;
  const skillHint = req.body?.skillHint != null ? String(req.body.skillHint) : draft.skillHint;
  if (skillHint && !AI_SKILL_HINTS.has(skillHint)) return res.status(400).json({ error: 'skillHint 不合法' });
  res.json({ draft: await updateAiImageDraft(draft.id, { editable, skillHint }) });
});

app.post('/api/ai/image-drafts/:id/confirm', auth(true), rateLimit('ai_jobs', 20, 60_000), async (req, res) => {
  const ai = await getAiRuntimeConfig();
  if (!ai.enabled) return res.status(403).json({ error: 'AI 生成未启用', code: 'AI_DISABLED' });
  if (!roleAllowedForAi(ai, req.user.role)) return res.status(403).json({ error: '当前角色不允许使用 AI 生成', code: 'AI_ROLE_FORBIDDEN' });

  const draft = await getAiImageDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: '草稿不存在' });
  if (!isAdmin(req.user) && draft.userId !== req.user.id) return res.status(403).json({ error: '无权操作' });
  if (draft.status !== 'pending_confirm') return res.status(400).json({ error: '草稿状态不可确认' });
  if (draft.expiresAt && new Date(draft.expiresAt).getTime() < Date.now()) {
    await updateAiImageDraft(draft.id, { status: 'expired' });
    return res.status(400).json({ error: '草稿已过期' });
  }

  const editable = req.body?.editable && typeof req.body.editable === 'object' ? { ...draft.editable, ...req.body.editable } : draft.editable;
  const skillHint = String(editable.skillId || draft.skillHint || '').trim();
  if (skillHint && !AI_SKILL_HINTS.has(skillHint)) return res.status(400).json({ error: 'skillHint 不合法' });
  const content = buildConfirmSourceText(editable);
  if (!content) return res.status(400).json({ error: '确认前请填写题干/方程等关键字段' });
  if (skillHint === 'edu-solid-geometry') {
    return res.status(400).json({ error: '立体几何图片生成将在 M4b 支持，请先改 skillId 为化学或解析几何', code: 'SOLID_IMAGE_PENDING' });
  }

  let created;
  try {
    created = await createAiJob({
      userId: req.user.id,
      quotaLimit: quotaLimitForRole(ai, req.user.role),
      usageDate: quotaDate(),
      skillId: skillHint || '',
      problemType: 'ai_dynamic',
      params: { editable, fromDraftId: draft.id },
      title: String(editable.ask || editable.problemText || '图片识别生成').slice(0, 200),
      inputMode: 'image',
      sourceText: content,
      sourceAssetId: draft.assetPath || null,
      draftId: draft.id,
      skillHint: skillHint || null,
      idempotencyKey: `image-draft:${draft.id}`,
      aiMeta: { provider: 'sub2api', pipeline: 'm4_image', fromDraft: true, requestedAt: new Date().toISOString() }
    });
  } catch (error) {
    if (error.code === 'QUOTA_EXCEEDED') return res.status(429).json({ error: error.message, code: error.code, quota: error.quota });
    throw error;
  }
  await updateAiImageDraft(draft.id, { editable, skillHint, status: 'confirmed', confirmedJobId: created.job.id });
  res.status(created.reused ? 200 : 202).json({ job: created.job, reused: created.reused, quota: created.quota, draft: await getAiImageDraft(draft.id) });
});

app.post('/api/ai/image-drafts/:id/discard', auth(true), async (req, res) => {
  const draft = await getAiImageDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: '草稿不存在' });
  if (!isAdmin(req.user) && draft.userId !== req.user.id) return res.status(403).json({ error: '无权操作' });
  res.json({ draft: await updateAiImageDraft(draft.id, { status: 'discarded' }) });
});

// ---------- Admin ----------
app.get('/api/admin/stats', auth(true), requireRole(ROLES.ADMIN), async (_req, res) => {
  const stats = await getStats();
  res.json(stats);
});

app.get('/api/admin/config', auth(true), requireRole(ROLES.ADMIN), async (_req, res) => {
  const config = await getSystemConfig();
  const ai = publicAiConfig(await getAiRuntimeConfig());
  res.json({
    config: {
      worker_concurrency: config.worker_concurrency,
      python_bin: config.python_bin,
      lesson_artifacts_root: config.lesson_artifacts_root,
      ai_enabled: config.ai_enabled,
      ai_allow_roles: config.ai_allow_roles,
      ai_quota_student: config.ai_quota_student,
      ai_quota_teacher: config.ai_quota_teacher,
      ai_quota_admin: config.ai_quota_admin,
      ai_model: config.ai_model,
      ai_vision_model: config.ai_vision_model,
      ai_sub2api_base_url: config.ai_sub2api_base_url,
      ai_max_repair_attempts: config.ai_max_repair_attempts,
      ai_image_confirm_required: config.ai_image_confirm_required
    },
    ai
  });
});

app.patch('/api/admin/config', auth(true), requireRole(ROLES.ADMIN), async (req, res) => {
  const allowed = [
    'worker_concurrency', 'python_bin', 'lesson_artifacts_root',
    'ai_enabled', 'ai_allow_roles', 'ai_quota_student', 'ai_quota_teacher', 'ai_quota_admin',
    'ai_model', 'ai_vision_model', 'ai_sub2api_base_url', 'ai_max_repair_attempts', 'ai_image_confirm_required'
  ];
  for (const key of allowed) {
    if (req.body?.[key] == null) continue;
    const value = String(req.body[key]);
    if (key === 'worker_concurrency' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 16)) {
      return res.status(400).json({ error: 'worker_concurrency 必须是 1-16 的整数' });
    }
    if (key.startsWith('ai_quota_') && (!/^\d+$/.test(value) || Number(value) > 100000)) {
      return res.status(400).json({ error: `${key} 必须是非负整数` });
    }
    if (value.length > 512) return res.status(400).json({ error: `${key} 长度过长` });
    await setSystemConfig(key, value);
  }
  res.json({ config: await getSystemConfig(), ai: publicAiConfig(await getAiRuntimeConfig()) });
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
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '图片超过 5MB 限制' : '图片上传格式或字段无效', code: err.code });
  }
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
