import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { ROLES, normalizeRole } from './services/rbac.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

dotenv.config({ path: join(__dirname, '.env') });
dotenv.config({ path: join(projectRoot, '.env') });

const useMysql = String(process.env.USE_MYSQL || 'false').toLowerCase() === 'true';
const sessionTtlHours = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 168));
const staleJobMs = Math.max(60_000, Number(process.env.JOB_STALE_AFTER_MS || 3_600_000));
const memoryLockWaitMs = Math.max(50, Number(process.env.MEMORY_DB_LOCK_WAIT_MS || 2_000));

const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'ai_teaching_edulab',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
};

const memory = {
  users: [],
  sessions: [],
  jobs: [],
  lessons: [],
  assets: [],
  catalog: [],
  aiQuota: [],
  aiImageDrafts: [],
  config: {
    worker_concurrency: process.env.WORKER_CONCURRENCY || '1',
    python_bin: process.env.PYTHON_BIN || 'python3',
    lesson_artifacts_root: process.env.LESSON_ARTIFACTS_ROOT || join(__dirname, 'uploads', 'lessons'),
    ai_enabled: process.env.AI_ENABLED || 'true',
    ai_allow_roles: process.env.AI_ALLOW_ROLES || 'student,teacher,admin',
    ai_quota_student: process.env.AI_QUOTA_STUDENT || '10',
    ai_quota_teacher: process.env.AI_QUOTA_TEACHER || '50',
    ai_quota_admin: process.env.AI_QUOTA_ADMIN || '200',
    ai_image_confirm_required: 'true',
    ai_max_repair_attempts: process.env.AI_MAX_REPAIR_ATTEMPTS || '3'
  }
};

function memoryDataFile() {
  return process.env.MEMORY_DB_FILE || join(__dirname, 'data', 'memory-db.json');
}

function memoryLockFile() { return `${memoryDataFile()}.lock`; }

function acquireMemoryLock() {
  const lock = memoryLockFile();
  const started = Date.now();
  fs.mkdirSync(dirname(lock), { recursive: true });
  while (true) {
    try { return fs.openSync(lock, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() - started >= memoryLockWaitMs) throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > memoryLockWaitMs) fs.unlinkSync(lock);
      } catch {}
    }
  }
}

function releaseMemoryLock(fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(memoryLockFile()); } catch {}
}

function loadMemory() {
  try {
    const dataFile = memoryDataFile();
    if (fs.existsSync(dataFile)) {
      Object.assign(memory, JSON.parse(fs.readFileSync(dataFile, 'utf8')));
    }
  } catch (e) {
    console.warn('memory load failed', e.message);
  }
  if (!memory.config || typeof memory.config !== 'object') memory.config = {};
  for (const arr of ['users', 'sessions', 'jobs', 'lessons', 'assets', 'catalog', 'aiQuota', 'aiImageDrafts']) {
    if (!Array.isArray(memory[arr])) memory[arr] = [];
  }
}

function saveMemory(existingLockFd = null) {
  const dataFile = memoryDataFile();
  fs.mkdirSync(dirname(dataFile), { recursive: true });
  const lockFd = existingLockFd || acquireMemoryLock();
  try {
    const tempFile = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(memory, null, 2), 'utf8');
    fs.renameSync(tempFile, dataFile);
  } finally { if (!existingLockFd) releaseMemoryLock(lockFd); }
}

loadMemory();

function memReload() {
  if (!useMysql) loadMemory();
}

let pool = null;
let bootstrapPool = null;
if (useMysql) {
  pool = mysql.createPool(dbConfig);
  bootstrapPool = mysql.createPool({ ...dbConfig, database: undefined });
}

export function generateId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

export function verifyPassword(password, encoded) {
  if (!encoded) return false;
  if (!encoded.startsWith('scrypt$')) return false;
  const [, salt, expectedHex] = encoded.split('$');
  if (!salt || !expectedHex || !/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
  const actual = crypto.scryptSync(String(password), salt, 32);
  return crypto.timingSafeEqual(Buffer.from(actual.toString('hex'), 'hex'), Buffer.from(expectedHex, 'hex'));
}

export function needsPasswordRehash() {
  return false;
}

async function initMysqlSchema() {
  await bootstrapPool.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    nickname VARCHAR(128) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'student',
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(128) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS generation_jobs (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    progress INT NOT NULL DEFAULT 0,
    current_stage VARCHAR(255) DEFAULT '',
    skill_id VARCHAR(64) NOT NULL,
    problem_type VARCHAR(64) NOT NULL,
    params JSON,
    title VARCHAR(512) DEFAULT '',
    error_message TEXT,
    result_lesson_id VARCHAR(64),
    worker_token VARCHAR(128),
    lease_until DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_jobs_user (user_id),
    INDEX idx_jobs_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const statement of [
    "ALTER TABLE generation_jobs ADD COLUMN worker_token VARCHAR(128) NULL",
    "ALTER TABLE generation_jobs ADD COLUMN lease_until DATETIME NULL",
    "ALTER TABLE generation_jobs ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'fixed'",
    "ALTER TABLE generation_jobs ADD COLUMN input_mode VARCHAR(32) NOT NULL DEFAULT 'catalog'",
    "ALTER TABLE generation_jobs ADD COLUMN source_text MEDIUMTEXT NULL",
    "ALTER TABLE generation_jobs ADD COLUMN source_asset_id VARCHAR(64) NULL",
    "ALTER TABLE generation_jobs ADD COLUMN draft_id VARCHAR(64) NULL",
    "ALTER TABLE generation_jobs ADD COLUMN skill_hint VARCHAR(64) NULL",
    "ALTER TABLE generation_jobs ADD COLUMN idempotency_key VARCHAR(128) NULL",
    "ALTER TABLE generation_jobs ADD COLUMN error_code VARCHAR(64) NULL",
    "ALTER TABLE generation_jobs ADD COLUMN spec JSON NULL",
    "ALTER TABLE generation_jobs ADD COLUMN validation_trace JSON NULL",
    "ALTER TABLE generation_jobs ADD COLUMN molecule_extensions JSON NULL",
    "ALTER TABLE generation_jobs ADD COLUMN ai_meta JSON NULL",
    "CREATE UNIQUE INDEX uq_jobs_idempotency ON generation_jobs (user_id, idempotency_key)"
  ]) { try { await pool.query(statement); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_KEYNAME') throw error; } }
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_daily_quota (
    user_id VARCHAR(64) NOT NULL,
    usage_date CHAR(10) NOT NULL,
    ai_jobs_created INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, usage_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_image_drafts (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_confirm',
    skill_hint VARCHAR(64) DEFAULT '',
    asset_path VARCHAR(512) DEFAULT '',
    confidence DOUBLE DEFAULT NULL,
    editable_json JSON,
    raw_recognition JSON,
    warnings_json JSON,
    confirmed_job_id VARCHAR(64) NULL,
    expires_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_drafts_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lessons (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    job_id VARCHAR(64),
    skill_id VARCHAR(64) NOT NULL,
    problem_type VARCHAR(64) NOT NULL,
    title VARCHAR(512) NOT NULL,
    summary TEXT,
    html_path VARCHAR(512) NOT NULL,
    file_size INT DEFAULT 0,
    publish_status VARCHAR(32) NOT NULL DEFAULT 'draft',
    visibility VARCHAR(32) NOT NULL DEFAULT 'private',
    view_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_lessons_user (user_id),
    INDEX idx_lessons_publish (publish_status, visibility)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lesson_assets (
    id VARCHAR(64) PRIMARY KEY,
    lesson_id VARCHAR(64) NOT NULL,
    asset_type VARCHAR(64) NOT NULL,
    path VARCHAR(512) NOT NULL,
    mime_type VARCHAR(128) DEFAULT '',
    size_bytes INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_assets_lesson (lesson_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS problem_catalog (
    skill_id VARCHAR(64) NOT NULL,
    problem_type VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (skill_id, problem_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS system_config (
    config_key VARCHAR(128) PRIMARY KEY,
    config_value TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

export async function initDb() {
  memReload();
  if (useMysql) {
    await initMysqlSchema();
  }
  const seedDemo = String(process.env.SEED_DEMO_ACCOUNTS || 'false').toLowerCase() === 'true';
  const adminEmail = (process.env.DEMO_ADMIN_EMAIL || 'admin@edulab.local').trim().toLowerCase();
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD || '';
  if (seedDemo && adminPassword.length < 12) throw new Error('启用演示管理员时 DEMO_ADMIN_PASSWORD 必须至少 12 位');
  if (seedDemo && useMysql) {
    const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [adminEmail]);
    if (!rows[0]) {
      const admin = {
        id: generateId('usr'), email: adminEmail, nickname: '管理员',
        password_hash: hashPassword(adminPassword),
        role: ROLES.ADMIN, status: 'active'
      };
      await pool.query('INSERT INTO users (id, email, nickname, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
        [admin.id, admin.email, admin.nickname, admin.password_hash, admin.role, admin.status]);
    }
  } else if (seedDemo && !memory.users.find(u => u.email === adminEmail)) {
    memory.users.push({
      id: generateId('usr'),
      email: adminEmail,
      nickname: '管理员',
      password_hash: hashPassword(adminPassword),
      role: ROLES.ADMIN,
      status: 'active',
      created_at: new Date().toISOString()
    });
    if (!useMysql) saveMemory();
  }
  const skillsModule = await import('./services/skillCatalog.js');
  const catalogEntries = skillsModule.listSkills().flatMap(skill => skill.problemTypes.map(problem => ({ skill_id: skill.id, problem_type: problem.key, enabled: 1 })));
  if (useMysql) {
    for (const entry of catalogEntries) await pool.query('INSERT IGNORE INTO problem_catalog (skill_id, problem_type, enabled) VALUES (?, ?, ?)', [entry.skill_id, entry.problem_type, entry.enabled]);
  } else {
    let changed = false;
    for (const entry of catalogEntries) if (!memory.catalog.some(item => item.skill_id === entry.skill_id && item.problem_type === entry.problem_type)) { memory.catalog.push({ ...entry, updated_at: new Date().toISOString() }); changed = true; }
    if (changed) saveMemory();
  }
}

export async function runStartupMaintenance() {
  memReload();
  const staleBefore = new Date(Date.now() - staleJobMs);
  if (useMysql) {
    const [result] = await pool.query("UPDATE generation_jobs SET status = 'queued', progress = 0, current_stage = '排队中', worker_token = NULL, lease_until = NULL, updated_at = NOW() WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)", [staleBefore]);
    return { droppedSessions: 0, resetJobs: result.affectedRows || 0 };
  }
  const lockFd = acquireMemoryLock();
  try {
    loadMemory();
    const before = memory.sessions.length;
    const cutoff = staleBefore;
    memory.sessions = memory.sessions.filter(s => !String(s.token || '').startsWith('tok_') && new Date(s.created_at).getTime() >= cutoff.getTime());
    let resetJobs = 0;
    for (const job of memory.jobs) {
      if (job.status === 'running' && new Date(job.updated_at).getTime() < staleBefore.getTime()) {
        job.status = 'queued'; job.progress = 0; job.current_stage = '排队中'; job.worker_token = null; job.lease_until = null; job.updated_at = new Date().toISOString(); resetJobs++;
      }
    }
    if (memory.sessions.length !== before || resetJobs) saveMemory(lockFd);
    return { droppedSessions: before - memory.sessions.length, resetJobs };
  } finally { releaseMemoryLock(lockFd); }
}

// ---------- Users ----------

export async function createUser({ email, nickname, passwordHash, role }) {
  memReload();
  if (useMysql) {
    const user = { id: generateId('usr'), email, nickname, password_hash: passwordHash, role: normalizeRole(role), status: 'active', created_at: new Date().toISOString() };
    await pool.query('INSERT INTO users (id, email, nickname, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id, user.email, user.nickname, user.password_hash, user.role, user.status]);
    return user;
  }
  if (memory.users.some(u => u.email === email)) throw new Error('邮箱已注册');
  const user = { id: generateId('usr'), email, nickname, password_hash: passwordHash, role: normalizeRole(role), status: 'active', created_at: new Date().toISOString() };
  memory.users.push(user);
  saveMemory();
  return user;
}

export async function getUserByEmail(email) {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0] || null;
  }
  return memory.users.find(u => u.email === email) || null;
}

export async function getUserById(id) {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    return rows[0] || null;
  }
  return memory.users.find(u => u.id === id) || null;
}

export async function listUsers() {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT id, email, nickname, role, status, created_at FROM users ORDER BY created_at DESC');
    return rows;
  }
  return memory.users.map(u => ({ id: u.id, email: u.email, nickname: u.nickname, role: normalizeRole(u.role), status: u.status, created_at: u.created_at }));
}

export async function updateUser(id, patch) {
  const fields = [];
  const values = [];
  if (patch.nickname) { fields.push('nickname = ?'); values.push(patch.nickname); }
  if (patch.role) { fields.push('role = ?'); values.push(normalizeRole(patch.role)); }
  if (patch.status) { fields.push('status = ?'); values.push(patch.status); }
  if (patch.passwordHash) { fields.push('password_hash = ?'); values.push(patch.passwordHash); }
  if (!fields.length) return getUserById(id);
  values.push(id);
  if (useMysql) {
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  } else {
    const u = memory.users.find(x => x.id === id);
    if (!u) return null;
    if (patch.nickname) u.nickname = patch.nickname;
    if (patch.role) u.role = normalizeRole(patch.role);
    if (patch.status) u.status = patch.status;
    if (patch.passwordHash) u.password_hash = patch.passwordHash;
    saveMemory();
  }
  return getUserById(id);
}

// ---------- Sessions ----------

export async function createSession(userId) {
  const token = `sess_${crypto.randomBytes(24).toString('hex')}`;
  if (useMysql) {
    await pool.query('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, userId]);
  } else {
    memory.sessions.push({ token, user_id: userId, created_at: new Date().toISOString() });
    saveMemory();
  }
  return token;
}

export async function getSessionUser(token) {
  if (!token) return null;
  memReload();
  const cutoff = Date.now() - sessionTtlHours * 60 * 60 * 1000;
  if (useMysql) {
    const [rows] = await pool.query(
      'SELECT u.* FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.created_at >= ?',
      [token, new Date(cutoff)]);
    return rows[0] || null;
  }
  const s = memory.sessions.find(x => x.token === token);
  if (!s) return null;
  if (new Date(s.created_at).getTime() < cutoff) { await deleteSession(token); return null; }
  return memory.users.find(u => u.id === s.user_id) || null;
}

export async function deleteSession(token) {
  memReload();
  if (useMysql) {
    await pool.query('DELETE FROM sessions WHERE token = ?', [token]);
  } else {
    memory.sessions = memory.sessions.filter(s => s.token !== token);
    saveMemory();
  }
}

export async function deleteUserSessions(userId) {
  memReload();
  if (useMysql) { await pool.query('DELETE FROM sessions WHERE user_id = ?', [userId]); return; }
  memory.sessions = memory.sessions.filter(s => s.user_id !== userId); saveMemory();
}

// ---------- Jobs ----------

function buildJobRecord({
  userId,
  skillId,
  problemType,
  params,
  title,
  kind = 'fixed',
  inputMode = 'catalog',
  sourceText = '',
  sourceAssetId = null,
  draftId = null,
  skillHint = null,
  idempotencyKey = null,
  aiMeta = null,
  spec = null
}) {
  return {
    id: generateId('job'),
    user_id: userId,
    status: 'queued',
    progress: 0,
    current_stage: '排队中',
    skill_id: skillId || '',
    problem_type: problemType || (kind === 'ai' ? 'ai_dynamic' : ''),
    params: params || {},
    title: title || '',
    error_message: '',
    error_code: '',
    result_lesson_id: null,
    worker_token: null,
    lease_until: null,
    kind: kind === 'ai' ? 'ai' : 'fixed',
    input_mode: inputMode || (kind === 'ai' ? 'text' : 'catalog'),
    source_text: sourceText || '',
    source_asset_id: sourceAssetId || null,
    draft_id: draftId || null,
    skill_hint: skillHint || null,
    idempotency_key: idempotencyKey || null,
    spec: spec || null,
    validation_trace: null,
    molecule_extensions: null,
    ai_meta: aiMeta || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function insertJob(job, executor = pool) {
  await executor.query(
    `INSERT INTO generation_jobs (
       id, user_id, status, progress, current_stage, skill_id, problem_type, params, title,
       worker_token, lease_until, kind, input_mode, source_text, source_asset_id, draft_id,
       skill_hint, idempotency_key, error_code, spec, validation_trace, molecule_extensions, ai_meta
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id, job.user_id, job.status, job.progress, job.current_stage, job.skill_id, job.problem_type,
      JSON.stringify(job.params), job.title, job.kind, job.input_mode, job.source_text, job.source_asset_id,
      job.draft_id, job.skill_hint, job.idempotency_key, job.error_code,
      job.spec ? JSON.stringify(job.spec) : null,
      null,
      null,
      job.ai_meta ? JSON.stringify(job.ai_meta) : null
    ]
  );
}

export async function createJob(fields) {
  const job = buildJobRecord(fields);
  if (useMysql) {
    await insertJob(job);
  } else {
    const lockFd = acquireMemoryLock();
    try { loadMemory(); memory.jobs.unshift(job); saveMemory(lockFd); } finally { releaseMemoryLock(lockFd); }
  }
  return mapJob(job);
}

function quotaExceededError({ usageDate, quotaLimit, used }) {
  const error = new Error('今日 AI 生成次数已达上限');
  error.code = 'QUOTA_EXCEEDED';
  error.quota = { date: usageDate, limit: quotaLimit, used, remaining: 0 };
  return error;
}

function quotaResult({ userId, usageDate, quotaLimit, used }) {
  return {
    userId,
    date: usageDate,
    limit: quotaLimit,
    used,
    remaining: Math.max(0, quotaLimit - used)
  };
}

/** Atomically reserve quota and create an AI job, including idempotency. */
export async function createAiJob({
  userId,
  quotaLimit,
  usageDate = new Date().toISOString().slice(0, 10),
  ...fields
}) {
  const limit = Math.max(0, Number(quotaLimit));
  const job = buildJobRecord({ ...fields, userId, kind: 'ai' });

  if (useMysql) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (job.idempotency_key) {
        const [existingRows] = await connection.query(
          'SELECT * FROM generation_jobs WHERE user_id = ? AND idempotency_key = ? FOR UPDATE',
          [userId, job.idempotency_key]
        );
        if (existingRows[0]) {
          const [[usage]] = await connection.query(
            'SELECT ai_jobs_created FROM ai_daily_quota WHERE user_id = ? AND usage_date = ?',
            [userId, usageDate]
          );
          await connection.commit();
          const used = Number(usage?.ai_jobs_created || 0);
          return { job: mapJob(existingRows[0]), reused: true, quota: quotaResult({ userId, usageDate, quotaLimit: limit, used }) };
        }
      }
      await connection.query(
        'INSERT INTO ai_daily_quota (user_id, usage_date, ai_jobs_created) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE user_id = user_id',
        [userId, usageDate]
      );
      const [[usage]] = await connection.query(
        'SELECT ai_jobs_created FROM ai_daily_quota WHERE user_id = ? AND usage_date = ? FOR UPDATE',
        [userId, usageDate]
      );
      const used = Number(usage?.ai_jobs_created || 0);
      if (used >= limit) throw quotaExceededError({ usageDate, quotaLimit: limit, used });
      await connection.query(
        'UPDATE ai_daily_quota SET ai_jobs_created = ai_jobs_created + 1 WHERE user_id = ? AND usage_date = ?',
        [userId, usageDate]
      );
      await insertJob(job, connection);
      await connection.commit();
      return { job: mapJob(job), reused: false, quota: quotaResult({ userId, usageDate, quotaLimit: limit, used: used + 1 }) };
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY' && job.idempotency_key) {
        const [rows] = await pool.query(
          'SELECT * FROM generation_jobs WHERE user_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1',
          [userId, job.idempotency_key]
        );
        if (rows[0]) {
          const used = await getAiDailyUsage(userId, usageDate);
          return { job: mapJob(rows[0]), reused: true, quota: quotaResult({ userId, usageDate, quotaLimit: limit, used }) };
        }
      }
      throw error;
    } finally { connection.release(); }
  }

  const lockFd = acquireMemoryLock();
  try {
    loadMemory();
    if (job.idempotency_key) {
      const existing = memory.jobs.find(item => item.user_id === userId && item.idempotency_key === job.idempotency_key);
      if (existing) {
        const usage = memory.aiQuota.find(item => item.user_id === userId && item.usage_date === usageDate);
        const used = Number(usage?.ai_jobs_created || 0);
        return { job: mapJob(existing), reused: true, quota: quotaResult({ userId, usageDate, quotaLimit: limit, used }) };
      }
    }
    let usage = memory.aiQuota.find(item => item.user_id === userId && item.usage_date === usageDate);
    if (!usage) {
      usage = { user_id: userId, usage_date: usageDate, ai_jobs_created: 0, updated_at: new Date().toISOString() };
      memory.aiQuota.push(usage);
    }
    const used = Number(usage.ai_jobs_created || 0);
    if (used >= limit) throw quotaExceededError({ usageDate, quotaLimit: limit, used });
    usage.ai_jobs_created = used + 1;
    usage.updated_at = new Date().toISOString();
    memory.jobs.unshift(job);
    saveMemory(lockFd);
    return { job: mapJob(job), reused: false, quota: quotaResult({ userId, usageDate, quotaLimit: limit, used: used + 1 }) };
  } finally { releaseMemoryLock(lockFd); }
}

function parseJsonField(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

function mapJob(row) {
  if (!row) return null;
  const params = parseJsonField(row.params, {});
  const publicError = row.error_message
    ? (row.kind === 'ai' || row.error_code ? String(row.error_message) : '课件生成失败，请稍后重试')
    : '';
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    progress: row.progress,
    currentStage: row.current_stage,
    skillId: row.skill_id,
    problemType: row.problem_type,
    params,
    title: row.title,
    errorMessage: publicError,
    errorCode: row.error_code || '',
    resultLessonId: row.result_lesson_id,
    workerToken: row.worker_token || null,
    leaseUntil: row.lease_until || null,
    kind: row.kind || 'fixed',
    inputMode: row.input_mode || 'catalog',
    sourceText: row.source_text || '',
    sourceAssetId: row.source_asset_id || null,
    draftId: row.draft_id || null,
    skillHint: row.skill_hint || null,
    idempotencyKey: row.idempotency_key || null,
    spec: parseJsonField(row.spec, null),
    validationTrace: parseJsonField(row.validation_trace, null),
    moleculeExtensions: parseJsonField(row.molecule_extensions, null),
    aiMeta: parseJsonField(row.ai_meta, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listJobs({ userId, isAdmin, kind } = {}) {
  memReload();
  if (useMysql) {
    let sql = 'SELECT * FROM generation_jobs';
    const vals = [];
    const conditions = [];
    if (!isAdmin && userId) { conditions.push('user_id = ?'); vals.push(userId); }
    if (kind) { conditions.push('kind = ?'); vals.push(kind); }
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC LIMIT 200';
    const [rows] = await pool.query(sql, vals);
    return rows.map(mapJob);
  }
  let jobs = memory.jobs;
  if (!isAdmin && userId) jobs = jobs.filter(j => j.user_id === userId);
  if (kind) jobs = jobs.filter(j => j.kind === kind);
  return jobs.slice(0, 200).map(mapJob);
}

export async function getJob(id) {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT * FROM generation_jobs WHERE id = ?', [id]);
    return mapJob(rows[0]);
  }
  return mapJob(memory.jobs.find(j => j.id === id) || null);
}

export async function claimQueuedJob(workerToken = generateId('worker')) {
  memReload();
  if (useMysql) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const leaseUntil = new Date(Date.now() + staleJobMs);
      const [rows] = await connection.query("SELECT * FROM generation_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE");
      if (!rows[0]) { await connection.rollback(); return null; }
      await connection.query("UPDATE generation_jobs SET status = 'running', progress = 5, current_stage = ?, worker_token = ?, lease_until = ?, updated_at = NOW() WHERE id = ? AND status = 'queued'", ['开始生成', workerToken, leaseUntil, rows[0].id]);
      const [updated] = await connection.query('SELECT * FROM generation_jobs WHERE id = ?', [rows[0].id]);
      await connection.commit();
      return mapJob(updated[0]);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  const lockFd = acquireMemoryLock();
  try {
    loadMemory();
    const job = memory.jobs.find(j => j.status === 'queued');
    if (!job) return null;
    job.status = 'running';
    job.progress = 5;
    job.current_stage = '开始生成';
    job.updated_at = new Date().toISOString();
    job.worker_token = workerToken;
    job.lease_until = new Date(Date.now() + staleJobMs).toISOString();
    saveMemory(lockFd);
    return mapJob(job);
  } finally { releaseMemoryLock(lockFd); }
}

export async function updateJobProgress(id, { progress, currentStage, workerToken } = {}) {
  memReload();
  if (useMysql) {
    await pool.query('UPDATE generation_jobs SET progress = ?, current_stage = ?, lease_until = ?, updated_at = NOW() WHERE id = ? AND status = \'running\' AND worker_token = ?',
      [progress, currentStage, new Date(Date.now() + staleJobMs), id, workerToken]);
  } else {
    const lockFd = acquireMemoryLock();
    try {
      loadMemory();
      const job = memory.jobs.find(j => j.id === id);
      if (!job) return;
      if (workerToken && job.worker_token !== workerToken) return;
      if (progress != null) job.progress = progress;
      if (currentStage != null) job.current_stage = currentStage;
      job.lease_until = new Date(Date.now() + staleJobMs).toISOString();
      job.updated_at = new Date().toISOString();
      saveMemory(lockFd);
    } finally { releaseMemoryLock(lockFd); }
  }
}

export async function completeJob(id, lessonId, workerToken) {
  memReload();
  if (!workerToken) workerToken = (await getJob(id))?.workerToken;
  if (useMysql) {
    const [result] = await pool.query("UPDATE generation_jobs SET status = 'succeeded', progress = 100, current_stage = '完成', result_lesson_id = ?, worker_token = NULL, lease_until = NULL, updated_at = NOW() WHERE id = ? AND status = 'running' AND worker_token = ?", [lessonId, id, workerToken]);
    return result.affectedRows > 0;
  } else {
    const lockFd = acquireMemoryLock();
    try {
      loadMemory();
      const job = memory.jobs.find(j => j.id === id);
      if (!job) return false;
      if (job.status !== 'running' || job.worker_token !== workerToken) return false;
      job.status = 'succeeded'; job.progress = 100; job.current_stage = '完成'; job.result_lesson_id = lessonId;
      job.worker_token = null; job.lease_until = null; job.updated_at = new Date().toISOString();
      saveMemory(lockFd); return true;
    } finally { releaseMemoryLock(lockFd); }
  }
}

export async function failJob(id, errorMessage, workerToken) {
  memReload();
  if (!workerToken) workerToken = (await getJob(id))?.workerToken;
  if (useMysql) {
    const [result] = await pool.query("UPDATE generation_jobs SET status = 'failed', current_stage = '失败', error_message = ?, worker_token = NULL, lease_until = NULL, updated_at = NOW() WHERE id = ? AND status = 'running' AND worker_token = ?", [errorMessage, id, workerToken]);
    return result.affectedRows > 0;
  } else {
    const lockFd = acquireMemoryLock();
    try {
      loadMemory();
      const job = memory.jobs.find(j => j.id === id);
      if (!job) return false;
      if (job.status !== 'running' || job.worker_token !== workerToken) return false;
      job.status = 'failed'; job.current_stage = '失败'; job.error_message = errorMessage;
      job.worker_token = null; job.lease_until = null; job.updated_at = new Date().toISOString();
      saveMemory(lockFd); return true;
    } finally { releaseMemoryLock(lockFd); }
  }
}

export async function cancelJob(id) {
  const job = await getJob(id);
  if (!job) return null;
  if (job.status !== 'queued' && job.status !== 'running') return job;
  if (useMysql) {
    await pool.query("UPDATE generation_jobs SET status = 'cancelled', current_stage = '已取消', worker_token = NULL, lease_until = NULL, updated_at = NOW() WHERE id = ? AND status IN ('queued', 'running')", [id]);
  } else {
    const lockFd = acquireMemoryLock();
    try { loadMemory(); const stored = memory.jobs.find(item => item.id === id); if (stored) { stored.status = 'cancelled'; stored.current_stage = '已取消'; stored.updated_at = new Date().toISOString(); stored.worker_token = null; stored.lease_until = null; saveMemory(lockFd); } }
    finally { releaseMemoryLock(lockFd); }
  }
  return getJob(id);
}

export async function retryJob(id) {
  memReload();
  const job = await getJob(id);
  if (!job || !['failed', 'cancelled'].includes(job.status)) return job;
  if (useMysql) {
    await pool.query("UPDATE generation_jobs SET status = 'queued', progress = 0, current_stage = '排队中', error_message = '', result_lesson_id = NULL, worker_token = NULL, lease_until = NULL, updated_at = NOW() WHERE id = ? AND status IN ('failed', 'cancelled')", [id]);
  } else {
    const stored = memory.jobs.find(item => item.id === id);
    if (stored) {
      stored.status = 'queued'; stored.progress = 0; stored.current_stage = '排队中';
      stored.error_message = ''; stored.result_lesson_id = null; stored.updated_at = new Date().toISOString();
      stored.worker_token = null; stored.lease_until = null;
      saveMemory();
    }
  }
  return getJob(id);
}

// ---------- Lessons ----------

export async function createLesson({ userId, jobId, skillId, problemType, title, summary, htmlPath, fileSize }) {
  const lesson = {
    id: generateId('les'),
    user_id: userId,
    job_id: jobId || null,
    skill_id: skillId,
    problem_type: problemType,
    title,
    summary: summary || '',
    html_path: htmlPath,
    file_size: fileSize || 0,
    publish_status: 'draft',
    visibility: 'private',
    view_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (useMysql) {
    await pool.query(
      `INSERT INTO lessons (id, user_id, job_id, skill_id, problem_type, title, summary, html_path, file_size, publish_status, visibility, view_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lesson.id, lesson.user_id, lesson.job_id, lesson.skill_id, lesson.problem_type, lesson.title, lesson.summary, lesson.html_path, lesson.file_size, lesson.publish_status, lesson.visibility, lesson.view_count]
    );
  } else {
    memory.lessons.unshift(lesson);
    saveMemory();
  }
  return lesson;
}

function mapLesson(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    jobId: row.job_id,
    skillId: row.skill_id,
    problemType: row.problem_type,
    title: row.title,
    summary: row.summary,
    htmlPath: row.html_path,
    fileSize: row.file_size,
    publishStatus: row.publish_status,
    visibility: row.visibility,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listLessons({ userId, isAdmin, visibility, publishStatus } = {}) {
  memReload();
  if (useMysql) {
    const conds = [];
    const vals = [];
    if (visibility) { conds.push('visibility = ?'); vals.push(visibility); }
    if (publishStatus) { conds.push('publish_status = ?'); vals.push(publishStatus); }
    if (!isAdmin) {
      if (userId) { conds.push('(user_id = ? OR (visibility = ? AND publish_status = ?))'); vals.push(userId, 'public', 'approved'); }
      else { conds.push('(visibility = ? AND publish_status = ?)'); vals.push('public', 'approved'); }
    }
    let sql = 'SELECT * FROM lessons';
    if (conds.length) { sql += ' WHERE ' + conds.join(' AND '); }
    sql += ' ORDER BY created_at DESC LIMIT 200';
    const [rows] = await pool.query(sql, vals);
    return rows.map(mapLesson);
  }
  let lessons = memory.lessons;
  if (!isAdmin) lessons = userId
    ? lessons.filter(l => l.user_id === userId || (l.visibility === 'public' && l.publish_status === 'approved'))
    : lessons.filter(l => l.visibility === 'public' && l.publish_status === 'approved');
  if (visibility) lessons = lessons.filter(l => l.visibility === visibility);
  if (publishStatus) lessons = lessons.filter(l => l.publish_status === publishStatus);
  return lessons.slice(0, 200).map(mapLesson);
}

export async function getLesson(id) {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT * FROM lessons WHERE id = ?', [id]);
    return mapLesson(rows[0]);
  }
  return mapLesson(memory.lessons.find(l => l.id === id));
}

export async function getLessonByJobId(jobId) {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT * FROM lessons WHERE job_id = ?', [jobId]);
    return mapLesson(rows[0]);
  }
  return mapLesson(memory.lessons.find(l => l.job_id === jobId));
}

export async function updateLesson(id, patch) {
  const fields = [];
  const vals = [];
  const map = { title: 'title', summary: 'summary', publishStatus: 'publish_status', visibility: 'visibility' };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] != null) { fields.push(`${col} = ?`); vals.push(patch[k]); }
  }
  if (!fields.length) return getLesson(id);
  vals.push(id);
  if (useMysql) {
    fields.push('updated_at = NOW()');
    await pool.query(`UPDATE lessons SET ${fields.join(', ')} WHERE id = ?`, vals);
  } else {
    const l = memory.lessons.find(x => x.id === id);
    if (!l) return null;
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] != null) l[col] = patch[k];
    }
    l.updated_at = new Date().toISOString();
    saveMemory();
  }
  return getLesson(id);
}

export async function incrementLessonViews(id) {
  memReload();
  if (useMysql) {
    await pool.query('UPDATE lessons SET view_count = view_count + 1 WHERE id = ?', [id]);
  } else {
    const l = memory.lessons.find(x => x.id === id);
    if (l) { l.view_count++; saveMemory(); }
  }
}

export async function deleteLesson(id) {
  memReload();
  if (useMysql) {
    await pool.query('DELETE FROM lesson_assets WHERE lesson_id = ?', [id]);
    await pool.query('UPDATE generation_jobs SET result_lesson_id = NULL WHERE result_lesson_id = ?', [id]);
    await pool.query('DELETE FROM lessons WHERE id = ?', [id]);
  } else {
    memory.lessons = memory.lessons.filter(l => l.id !== id);
    memory.assets = memory.assets.filter(a => a.lesson_id !== id);
    for (const job of memory.jobs) if (job.result_lesson_id === id) job.result_lesson_id = null;
    saveMemory();
  }
}

export async function createLessonAsset({ lessonId, assetType, assetPath, mimeType = '', sizeBytes = 0 }) {
  const asset = { id: generateId('asset'), lesson_id: lessonId, asset_type: assetType, path: assetPath, mime_type: mimeType, size_bytes: sizeBytes, created_at: new Date().toISOString() };
  if (useMysql) await pool.query('INSERT INTO lesson_assets (id, lesson_id, asset_type, path, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)', [asset.id, asset.lesson_id, asset.asset_type, asset.path, asset.mime_type, asset.size_bytes]);
  else { memReload(); memory.assets.push(asset); saveMemory(); }
  return asset;
}

export async function listLessonAssets(lessonId) {
  memReload();
  if (useMysql) { const [rows] = await pool.query('SELECT id, lesson_id, asset_type, mime_type, size_bytes, created_at FROM lesson_assets WHERE lesson_id = ? ORDER BY created_at', [lessonId]); return rows; }
  return memory.assets.filter(asset => asset.lesson_id === lessonId).map(({ path, ...publicAsset }) => publicAsset);
}

// ---------- Stats ----------

export async function getStats() {
  memReload();
  if (useMysql) {
    const [[{ users }]] = await pool.query('SELECT COUNT(*) as users FROM users');
    const [[{ jobs }]] = await pool.query('SELECT COUNT(*) as jobs FROM generation_jobs');
    const [[{ runningJobs }]] = await pool.query("SELECT COUNT(*) as runningJobs FROM generation_jobs WHERE status = 'running'");
    const [[{ lessons }]] = await pool.query('SELECT COUNT(*) as lessons FROM lessons');
    const [[{ pendingReviews }]] = await pool.query("SELECT COUNT(*) AS pendingReviews FROM lessons WHERE publish_status = 'pending'");
    return { users, jobs, runningJobs, lessons, pendingReviews };
  }
  return {
    users: memory.users.length,
    jobs: memory.jobs.length,
    runningJobs: memory.jobs.filter(j => j.status === 'running').length,
    lessons: memory.lessons.length,
    pendingReviews: memory.lessons.filter(l => l.publish_status === 'pending').length
  };
}

export async function getSystemConfig() {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT config_key, config_value FROM system_config ORDER BY config_key');
    return Object.fromEntries(rows.map(row => [row.config_key, row.config_value]));
  }
  return { ...memory.config };
}

export async function setSystemConfig(key, value) {
  if (useMysql) {
    await pool.query('INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)', [key, String(value)]);
    return;
  }
  const lockFd = acquireMemoryLock();
  try { loadMemory(); memory.config[key] = String(value); saveMemory(lockFd); } finally { releaseMemoryLock(lockFd); }
}

export async function listProblemCatalog() {
  memReload();
  if (useMysql) { const [rows] = await pool.query('SELECT skill_id, problem_type, enabled, updated_at FROM problem_catalog ORDER BY skill_id, problem_type'); return rows; }
  return memory.catalog.map(item => ({ ...item }));
}

export async function setProblemCatalogEntry(skillId, problemType, enabled) {
  if (useMysql) {
    await pool.query('INSERT INTO problem_catalog (skill_id, problem_type, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [skillId, problemType, enabled ? 1 : 0]);
    return;
  }
  memReload();
  const item = memory.catalog.find(entry => entry.skill_id === skillId && entry.problem_type === problemType);
  if (item) { item.enabled = enabled ? 1 : 0; item.updated_at = new Date().toISOString(); }
  else memory.catalog.push({ skill_id: skillId, problem_type: problemType, enabled: enabled ? 1 : 0, updated_at: new Date().toISOString() });
  saveMemory();
}

// ---------- AI quota / drafts / idempotency (M0) ----------

export async function getAiDailyUsage(userId, usageDate) {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT ai_jobs_created FROM ai_daily_quota WHERE user_id = ? AND usage_date = ?', [userId, usageDate]);
    return rows[0]?.ai_jobs_created || 0;
  }
  const row = memory.aiQuota.find(item => item.user_id === userId && item.usage_date === usageDate);
  return row?.ai_jobs_created || 0;
}

export async function incrementAiDailyUsage(userId, usageDate) {
  memReload();
  if (useMysql) {
    await pool.query(
      `INSERT INTO ai_daily_quota (user_id, usage_date, ai_jobs_created) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE ai_jobs_created = ai_jobs_created + 1`,
      [userId, usageDate]
    );
    return getAiDailyUsage(userId, usageDate);
  }
  const lockFd = acquireMemoryLock();
  try {
    loadMemory();
    let row = memory.aiQuota.find(item => item.user_id === userId && item.usage_date === usageDate);
    if (!row) {
      row = { user_id: userId, usage_date: usageDate, ai_jobs_created: 0, updated_at: new Date().toISOString() };
      memory.aiQuota.push(row);
    }
    row.ai_jobs_created += 1;
    row.updated_at = new Date().toISOString();
    saveMemory(lockFd);
    return row.ai_jobs_created;
  } finally { releaseMemoryLock(lockFd); }
}

export async function consumeAiDailyQuota(userId, usageDate, quotaLimit) {
  const limit = Math.max(0, Number(quotaLimit));
  if (useMysql) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        'INSERT INTO ai_daily_quota (user_id, usage_date, ai_jobs_created) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE user_id = user_id',
        [userId, usageDate]
      );
      const [updated] = await connection.query(
        'UPDATE ai_daily_quota SET ai_jobs_created = ai_jobs_created + 1 WHERE user_id = ? AND usage_date = ? AND ai_jobs_created < ?',
        [userId, usageDate, limit]
      );
      const [[usage]] = await connection.query(
        'SELECT ai_jobs_created FROM ai_daily_quota WHERE user_id = ? AND usage_date = ?',
        [userId, usageDate]
      );
      const used = Number(usage?.ai_jobs_created || 0);
      if (!updated.affectedRows) throw quotaExceededError({ usageDate, quotaLimit: limit, used });
      await connection.commit();
      return used;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  const lockFd = acquireMemoryLock();
  try {
    loadMemory();
    let usage = memory.aiQuota.find(item => item.user_id === userId && item.usage_date === usageDate);
    if (!usage) {
      usage = { user_id: userId, usage_date: usageDate, ai_jobs_created: 0, updated_at: new Date().toISOString() };
      memory.aiQuota.push(usage);
    }
    const used = Number(usage.ai_jobs_created || 0);
    if (used >= limit) throw quotaExceededError({ usageDate, quotaLimit: limit, used });
    usage.ai_jobs_created = used + 1;
    usage.updated_at = new Date().toISOString();
    saveMemory(lockFd);
    return usage.ai_jobs_created;
  } finally { releaseMemoryLock(lockFd); }
}

export async function findJobByIdempotencyKey(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  memReload();
  if (useMysql) {
    const [rows] = await pool.query(
      'SELECT * FROM generation_jobs WHERE user_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1',
      [userId, idempotencyKey]
    );
    return mapJob(rows[0]);
  }
  const row = memory.jobs.find(j => j.user_id === userId && j.idempotency_key === idempotencyKey);
  return mapJob(row || null);
}

export async function updateJobAiFields(id, fields = {}) {
  memReload();
  const allowed = ['spec', 'validation_trace', 'molecule_extensions', 'ai_meta', 'skill_id', 'problem_type', 'error_code', 'source_text', 'skill_hint'];
  if (useMysql) {
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (!(key in fields)) continue;
      const column = key;
      let value = fields[key];
      if (['spec', 'validation_trace', 'molecule_extensions', 'ai_meta'].includes(key)) {
        value = value == null ? null : JSON.stringify(value);
      }
      sets.push(`${column} = ?`);
      vals.push(value);
    }
    if (!sets.length) return getJob(id);
    vals.push(id);
    await pool.query(`UPDATE generation_jobs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, vals);
    return getJob(id);
  }
  const lockFd = acquireMemoryLock();
  try {
    loadMemory();
    const job = memory.jobs.find(j => j.id === id);
    if (!job) return null;
    for (const key of allowed) {
      if (!(key in fields)) continue;
      job[key] = fields[key];
    }
    job.updated_at = new Date().toISOString();
    saveMemory(lockFd);
    return mapJob(job);
  } finally { releaseMemoryLock(lockFd); }
}

export async function createAiImageDraft({ userId, skillHint = '', assetPath = '', editable = {}, rawRecognition = null, confidence = null, warnings = [], ttlHours = 24 }) {
  const draft = {
    id: generateId('draft'),
    user_id: userId,
    status: 'pending_confirm',
    skill_hint: skillHint || '',
    asset_path: assetPath || '',
    confidence,
    editable_json: editable || {},
    raw_recognition: rawRecognition,
    warnings_json: warnings || [],
    confirmed_job_id: null,
    expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (useMysql) {
    await pool.query(
      `INSERT INTO ai_image_drafts (id, user_id, status, skill_hint, asset_path, confidence, editable_json, raw_recognition, warnings_json, confirmed_job_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [draft.id, draft.user_id, draft.status, draft.skill_hint, draft.asset_path, draft.confidence,
        JSON.stringify(draft.editable_json), draft.raw_recognition ? JSON.stringify(draft.raw_recognition) : null,
        JSON.stringify(draft.warnings_json), draft.expires_at]
    );
  } else {
    const lockFd = acquireMemoryLock();
    try { loadMemory(); memory.aiImageDrafts.unshift(draft); saveMemory(lockFd); } finally { releaseMemoryLock(lockFd); }
  }
  return mapAiDraft(draft);
}

function mapAiDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    skillHint: row.skill_hint || '',
    assetPath: row.asset_path || '',
    confidence: row.confidence,
    editable: parseJsonField(row.editable_json, {}),
    rawRecognition: parseJsonField(row.raw_recognition, null),
    warnings: parseJsonField(row.warnings_json, []),
    confirmedJobId: row.confirmed_job_id || null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getAiImageDraft(id) {
  memReload();
  if (useMysql) {
    const [rows] = await pool.query('SELECT * FROM ai_image_drafts WHERE id = ?', [id]);
    return mapAiDraft(rows[0]);
  }
  return mapAiDraft(memory.aiImageDrafts.find(d => d.id === id) || null);
}

export async function updateAiImageDraft(id, patch = {}) {
  memReload();
  if (useMysql) {
    const sets = [];
    const vals = [];
    const map = {
      status: 'status',
      skillHint: 'skill_hint',
      editable: 'editable_json',
      warnings: 'warnings_json',
      confirmedJobId: 'confirmed_job_id',
      confidence: 'confidence',
      assetPath: 'asset_path',
      rawRecognition: 'raw_recognition'
    };
    for (const [k, col] of Object.entries(map)) {
      if (!(k in patch)) continue;
      let value = patch[k];
      if (k === 'editable' || k === 'warnings' || k === 'rawRecognition') value = value == null ? null : JSON.stringify(value ?? (k === 'warnings' ? [] : {}));
      sets.push(`${col} = ?`);
      vals.push(value);
    }
    if (!sets.length) return getAiImageDraft(id);
    vals.push(id);
    await pool.query(`UPDATE ai_image_drafts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, vals);
    return getAiImageDraft(id);
  }
  const lockFd = acquireMemoryLock();
  try {
    loadMemory();
    const draft = memory.aiImageDrafts.find(d => d.id === id);
    if (!draft) return null;
    if ('status' in patch) draft.status = patch.status;
    if ('skillHint' in patch) draft.skill_hint = patch.skillHint;
    if ('editable' in patch) draft.editable_json = patch.editable;
    if ('warnings' in patch) draft.warnings_json = patch.warnings;
    if ('confirmedJobId' in patch) draft.confirmed_job_id = patch.confirmedJobId;
    if ('confidence' in patch) draft.confidence = patch.confidence;
    if ('assetPath' in patch) draft.asset_path = patch.assetPath;
    if ('rawRecognition' in patch) draft.raw_recognition = patch.rawRecognition;
    draft.updated_at = new Date().toISOString();
    saveMemory(lockFd);
    return mapAiDraft(draft);
  } finally { releaseMemoryLock(lockFd); }
}
