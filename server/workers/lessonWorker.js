import '../loadEnv.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  initDb, runStartupMaintenance, getSystemConfig, claimQueuedJob, updateJobProgress, completeJob, failJob,
  createLesson, createLessonAsset, getLessonByJobId, getJob, deleteLesson, updateJobAiFields
} from '../db.js';
import { runGenerate } from '../services/skillRunner.js';
import { getProblemType, getSkill } from '../services/skillCatalog.js';
import { isChemAiJob, runChemAiPipeline } from '../services/ai/chem/pipeline.js';
import { isAnalyticAiJob, runAnalyticAiPipeline } from '../services/ai/analytic/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');

const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL || '2000', 10);
let workerConfig = {};

function artifactsRoot() {
  const configured = workerConfig.lesson_artifacts_root || process.env.LESSON_ARTIFACTS_ROOT;
  return configured ? path.resolve(projectRoot, configured) : path.join(__dirname, '..', 'uploads', 'lessons');
}

function jobWorkDir(jobId) {
  const dir = path.join(artifactsRoot(), jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}


function inferAiSkillHint(job) {
  const hint = job.skillHint || job.skillId || '';
  if (hint) return hint;
  const text = String(job.sourceText || '');
  if (/椭圆|双曲线|抛物线|离心率|圆锥曲线|弦长|数量积|解析几何|斜率之积|焦点弦/.test(text)) return 'edu-analytic-geometry';
  if (/燃烧|电解|氧化还原|酯化|化学|反应|分子|O2|H2O|原子/.test(text)) return 'edu-chem-reaction';
  return '';
}

function buildTitle(job) {
  const skill = getSkill(job.skillId);
  const pt = getProblemType(job.skillId, job.problemType);
  const parts = [skill?.name || job.skillId, pt?.name || job.problemType];
  if (job.title) parts.push(job.title);
  return parts.join(' · ');
}

async function processAiJob(job) {
  const controller = new AbortController();
  const cancelWatcher = setInterval(async () => {
    try {
      const current = await getJob(job.id);
      if (!current || current.status === 'cancelled') controller.abort();
    } catch {}
  }, 1000);
  const workDir = jobWorkDir(job.id);
  const outputPath = path.join(workDir, 'lesson.html');
  try {
    // fill empty skillHint by lightweight text intent
    if (!job.skillHint && !job.skillId) {
      const inferred = inferAiSkillHint(job);
      if (inferred) job = { ...job, skillHint: inferred };
    }

    const pythonBin = workerConfig.python_bin || process.env.PYTHON_BIN || 'python3';
    const onProgress = async ({ progress, currentStage }) => {
      await updateJobProgress(job.id, { progress, currentStage, workerToken: job.workerToken });
    };

    let result;
    if (isChemAiJob(job)) {
      result = await runChemAiPipeline(job, { outputPath, workDir, pythonBin, signal: controller.signal, onProgress });
    } else if (isAnalyticAiJob(job)) {
      result = await runAnalyticAiPipeline(job, { outputPath, workDir, pythonBin, signal: controller.signal, onProgress });
    } else {
      const hint = job.skillHint || job.skillId || '';
      await failJob(
        job.id,
        `当前仅支持化学与解析几何 AI 生成；skillHint=${hint || '(空)'}。立体几何请等待 M4b。`,
        job.workerToken
      );
      return;
    }

    const current = await getJob(job.id);
    if (!current || current.status === 'cancelled') {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      return;
    }

    await updateJobAiFields(job.id, {
      skill_id: result.skillId,
      problem_type: result.problemType,
      spec: result.spec,
      validation_trace: result.validationTrace,
      molecule_extensions: result.moleculeExtensions || null,
      ai_meta: result.aiMeta,
      error_code: ''
    });

    await updateJobProgress(job.id, { progress: 90, currentStage: '注册课件', workerToken: job.workerToken });
    const stat = fs.statSync(outputPath);
    const title = result.title || buildTitle({ ...job, skillId: result.skillId, problemType: result.problemType });
    const existing = await getLessonByJobId(job.id);
    let lesson;
    if (existing) lesson = existing;
    else {
      lesson = await createLesson({
        userId: job.userId,
        jobId: job.id,
        skillId: result.skillId,
        problemType: result.problemType,
        title,
        summary: `${title}（AI 生成）`,
        htmlPath: outputPath,
        fileSize: stat.size
      });
      await createLessonAsset({ lessonId: lesson.id, assetType: 'html', assetPath: outputPath, mimeType: 'text/html', sizeBytes: stat.size });
    }
    const completed = await completeJob(job.id, lesson.id, job.workerToken);
    if (!completed && !existing) await deleteLesson(lesson.id);
    console.log(`[worker] AI job ${job.id} succeeded -> lesson ${lesson.id} (${result.problemType})`);
  } catch (err) {
    console.error(`[worker] AI job ${job.id} failed:`, err.code || err.message, err.detail || '');
    const current = await getJob(job.id);
    if (current?.status !== 'cancelled' && err.code !== 'ECANCELLED') {
      try {
        await updateJobAiFields(job.id, {
          validation_trace: err.validationTrace || null,
          ai_meta: err.aiMeta || job.aiMeta || null,
          molecule_extensions: err.moleculeExtensions || null,
          spec: err.spec || null,
          error_code: err.code || 'AI_JOB_FAILED'
        });
      } catch {}
      const msg = String(err.message || 'AI 生成失败').slice(0, 1000);
      await failJob(job.id, msg, job.workerToken);
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  } finally {
    clearInterval(cancelWatcher);
  }
}

async function processJob(job) {
  if (job.kind === 'ai') {
    return processAiJob(job);
  }
  const controller = new AbortController();
  const cancelWatcher = setInterval(async () => {
    try {
      const current = await getJob(job.id);
      if (!current || current.status === 'cancelled') controller.abort();
    } catch {}
  }, 1000);
  const workDir = jobWorkDir(job.id);
  const outputPath = path.join(workDir, 'lesson.html');

  try {
    await updateJobProgress(job.id, { progress: 15, currentStage: '调用 sympy 计算核心', workerToken: job.workerToken });

    await runGenerate({
      skillId: job.skillId,
      problemKey: job.problemType,
      params: job.params || {},
      outputPath,
      onLog: () => {},
      signal: controller.signal,
      pythonBin: workerConfig.python_bin || process.env.PYTHON_BIN || 'python3'
    });

    const current = await getJob(job.id);
    if (!current || current.status === 'cancelled') {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      return;
    }

    await updateJobProgress(job.id, { progress: 85, currentStage: '注册课件', workerToken: job.workerToken });

    const stat = fs.statSync(outputPath);
    const title = buildTitle(job);

    const existing = await getLessonByJobId(job.id);
    let lesson;
    if (existing) {
      lesson = existing;
    } else {
      lesson = await createLesson({
        userId: job.userId,
        jobId: job.id,
        skillId: job.skillId,
        problemType: job.problemType,
        title,
        summary: `${title}（自动生成）`,
        htmlPath: outputPath,
        fileSize: stat.size
      });
      await createLessonAsset({ lessonId: lesson.id, assetType: 'html', assetPath: outputPath, mimeType: 'text/html', sizeBytes: stat.size });
    }

    const completed = await completeJob(job.id, lesson.id, job.workerToken);
    if (!completed && !existing) await deleteLesson(lesson.id);
    console.log(`[worker] job ${job.id} succeeded -> lesson ${lesson.id}`);
  } catch (err) {
    console.error(`[worker] job ${job.id} failed:`, err.code || err.message, err.detail || '');
    const current = await getJob(job.id);
    if (current?.status !== 'cancelled' && err.code !== 'ECANCELLED') {
      await failJob(job.id, '课件生成失败，请稍后重试', job.workerToken);
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  } finally {
    clearInterval(cancelWatcher);
  }
}

async function main() {
  await initDb();
  const maintenance = await runStartupMaintenance();
  if (maintenance.resetJobs) console.log('[worker] reset stale jobs:', maintenance.resetJobs);
  workerConfig = await getSystemConfig();
  fs.mkdirSync(artifactsRoot(), { recursive: true });
  console.log('[worker] started, artifacts root:', artifactsRoot());
  let active = 0;
  let dispatching = false;
  const dispatch = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      workerConfig = await getSystemConfig();
      const concurrency = Math.max(1, Math.min(16, Number(workerConfig.worker_concurrency || process.env.WORKER_CONCURRENCY || 1)));
      while (active < concurrency) {
        const job = await claimQueuedJob();
        if (!job) break;
        active++;
        console.log(`[worker] claimed job ${job.id} (${job.skillId}/${job.problemType})`);
        processJob(job).finally(() => { active--; dispatch(); });
      }
    } catch (err) {
      console.error('[worker] dispatch error:', err);
    } finally { dispatching = false; }
  };
  setInterval(dispatch, POLL_INTERVAL);
  dispatch();
}

main();
