import fs from 'fs';
import path from 'path';
import { getAiRuntimeConfig } from '../config.js';
import { matchKnownAnalyticProblem } from './knownProblems.js';
import { generateAnalyticSpecFromLlm } from './llmSpec.js';
import { renderAnalyticSpec, validateAnalyticSpec } from './validateRender.js';
import { runGenerate } from '../../skillRunner.js';

/**
 * M3 analytic AI pipeline: known registry fast-path OR LLM lesson spec -> validate/repair -> render.
 */
export async function runAnalyticAiPipeline(job, {
  outputPath,
  workDir,
  pythonBin = process.env.PYTHON_BIN || 'python3',
  onProgress,
  signal
} = {}) {
  const ai = await getAiRuntimeConfig();
  const maxAttempts = Math.max(1, Number(ai.maxRepairAttempts || 3));
  const content = String(job.sourceText || job.params?.content || '').trim();
  if (!content) {
    const err = new Error('缺少解析几何输入内容');
    err.code = 'AI_INPUT_EMPTY';
    throw err;
  }

  const inputMode = job.inputMode || 'text';
  if (workDir) fs.mkdirSync(workDir, { recursive: true });
  if (outputPath) fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const validationTrace = [];
  const aiMeta = {
    ...(job.aiMeta || {}),
    provider: 'sub2api',
    pipeline: 'm3_analytic',
    attempts: []
  };

  const knownKey = matchKnownAnalyticProblem(content);
  if (knownKey) {
    await onProgress?.({ progress: 40, currentStage: `命中已知题型 ${knownKey}` });
    await runGenerate({
      skillId: 'edu-analytic-geometry',
      problemKey: knownKey,
      params: {},
      outputPath,
      signal,
      pythonBin
    });
    if (!fs.existsSync(outputPath)) {
      const err = new Error('已知解析几何题渲染失败');
      err.code = 'ANALYTIC_RENDER_FAILED';
      throw err;
    }
    aiMeta.route = 'known_registry';
    aiMeta.knownKey = knownKey;
    return {
      skillId: 'edu-analytic-geometry',
      problemType: knownKey,
      title: job.title || knownKey,
      spec: { route: 'known_registry', key: knownKey, sourceText: content },
      validationTrace,
      aiMeta,
      outputPath
    };
  }

  if (!ai.sub2api?.configured && !process.env.SUB2API_API_KEY) {
    const err = new Error('未命中已知题型，且 sub2api 未配置，无法动态生成');
    err.code = 'SUB2API_NOT_CONFIGURED';
    throw err;
  }

  let spec = null;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await onProgress?.({ progress: 20 + attempt * 10, currentStage: `生成解析几何 Spec（第 ${attempt}/${maxAttempts} 次）` });
    let gen;
    try {
      gen = await generateAnalyticSpecFromLlm({
        content,
        inputMode,
        model: ai.sub2api?.model || process.env.SUB2API_MODEL,
        signal,
        previousError: lastError || undefined,
        previousSpec: spec || undefined
      });
    } catch (error) {
      validationTrace.push({ attempt, phase: 'llm', error: error.message, code: error.code || null });
      lastError = error.message;
      if (attempt >= maxAttempts) {
        const err = new Error(`LLM 生成失败: ${error.message}`);
        err.code = error.code || 'LLM_ERROR';
        err.validationTrace = validationTrace;
        err.aiMeta = aiMeta;
        throw err;
      }
      continue;
    }

    spec = gen.spec;
    aiMeta.attempts.push({ attempt, model: gen.model, usage: gen.usage, finishReason: gen.finishReason });
    await onProgress?.({ progress: 25 + attempt * 12, currentStage: `校验解析几何 Spec（第 ${attempt} 次）` });
    const validated = await validateAnalyticSpec(spec, { pythonBin, workDir });
    if (validated.ok) {
      validationTrace.push({ attempt, phase: 'validate', ok: true, summary: validated.summary });
      break;
    }
    lastError = validated.error;
    validationTrace.push({ attempt, phase: 'validate', ok: false, error: validated.error });
    if (attempt >= maxAttempts) {
      const err = new Error(`解析几何 Spec 校验失败: ${validated.error}`);
      err.code = 'ANALYTIC_VALIDATION_FAILED';
      err.validationTrace = validationTrace;
      err.aiMeta = aiMeta;
      err.spec = spec;
      throw err;
    }
  }

  await onProgress?.({ progress: 80, currentStage: '渲染解析几何课件 HTML' });
  const rendered = await renderAnalyticSpec(spec, outputPath, { pythonBin, workDir });
  if (!rendered.ok) {
    const err = new Error(`解析几何课件渲染失败: ${rendered.error}`);
    err.code = 'ANALYTIC_RENDER_FAILED';
    err.validationTrace = validationTrace;
    err.aiMeta = aiMeta;
    err.spec = spec;
    throw err;
  }

  const title = job.title || spec?.lesson?.title || '解析几何演示';
  aiMeta.route = 'llm_spec';
  return {
    skillId: 'edu-analytic-geometry',
    problemType: 'ai_dynamic',
    title,
    spec,
    validationTrace,
    aiMeta,
    outputPath
  };
}

export function isAnalyticAiJob(job) {
  if (job?.kind !== 'ai') return false;
  const hint = job.skillHint || job.skillId || '';
  if (hint === 'edu-analytic-geometry') return true;
  if (hint === 'edu-chem-reaction' || hint === 'edu-solid-geometry') return false;
  return false;
}
