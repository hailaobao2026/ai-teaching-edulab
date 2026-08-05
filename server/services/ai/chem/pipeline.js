import fs from 'fs';
import path from 'path';
import { getAiRuntimeConfig } from '../config.js';
import { matchKnownChemReaction } from './knownReactions.js';
import { generateChemSpecFromLlm } from './llmSpec.js';
import { renderChemSpec, validateChemSpec } from './validateRender.js';
import { ensureSpeciesForSpec, missingSpecies } from './moleculeExtender.js';
import { listActiveMoleculeExtensions } from './moleculeStore.js';
import { runGenerate } from '../../skillRunner.js';

/**
 * M1/M2 chem AI pipeline: known fixed key fast-path OR LLM spec -> molecule extend -> validate/repair -> render.
 */
export async function runChemAiPipeline(job, {
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
    const err = new Error('缺少化学输入内容');
    err.code = 'AI_INPUT_EMPTY';
    throw err;
  }

  const inputMode = job.inputMode || 'text';
  if (workDir) fs.mkdirSync(workDir, { recursive: true });
  if (outputPath) fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const validationTrace = [];
  const moleculeExtensions = [];
  const aiMeta = {
    ...(job.aiMeta || {}),
    provider: 'sub2api',
    pipeline: 'm2_chem',
    attempts: [],
    moleculeAttempts: []
  };

  // Fast path: map to fixed registry reaction
  const knownKey = matchKnownChemReaction(content);
  if (knownKey) {
    await onProgress?.({ progress: 40, currentStage: `命中已知反应 ${knownKey}` });
    await runGenerate({
      skillId: 'edu-chem-reaction',
      problemKey: knownKey,
      params: {},
      outputPath,
      signal,
      pythonBin
    });
    if (!fs.existsSync(outputPath)) {
      const err = new Error('已知反应渲染失败');
      err.code = 'CHEM_RENDER_FAILED';
      throw err;
    }
    aiMeta.route = 'known_registry';
    aiMeta.knownKey = knownKey;
    return {
      skillId: 'edu-chem-reaction',
      problemType: knownKey,
      title: job.title || knownKey,
      spec: { route: 'known_registry', key: knownKey, sourceText: content },
      validationTrace,
      moleculeExtensions,
      aiMeta,
      outputPath
    };
  }

  if (!ai.sub2api?.configured && !process.env.SUB2API_API_KEY) {
    const err = new Error('未命中已知反应，且 sub2api 未配置，无法动态生成');
    err.code = 'SUB2API_NOT_CONFIGURED';
    throw err;
  }

  let spec = null;
  let lastError = '';
  let extensionsFile = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await onProgress?.({ progress: 20 + attempt * 10, currentStage: `生成化学 Spec（第 ${attempt}/${maxAttempts} 次）` });
    let gen;
    try {
      gen = await generateChemSpecFromLlm({
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
        err.moleculeExtensions = moleculeExtensions;
        throw err;
      }
      continue;
    }

    spec = gen.spec;
    aiMeta.attempts.push({ attempt, model: gen.model, usage: gen.usage, finishReason: gen.finishReason });

    // M2: auto-extend missing molecules before kernel validate
    const miss = missingSpecies(spec);
    if (miss.length) {
      await onProgress?.({ progress: 30 + attempt * 8, currentStage: `分子库扩展: ${miss.join(', ')}` });
      try {
        const extResult = await ensureSpeciesForSpec(spec, {
          pythonBin,
          workDir,
          model: ai.sub2api?.model || process.env.SUB2API_MODEL,
          signal,
          reactionHint: content,
          onProgress,
          persist: true
        });
        extensionsFile = extResult.extensionsFile;
        if (extResult.extensions?.length) {
          moleculeExtensions.push(...extResult.extensions);
        }
        if (extResult.attemptsLog?.length) {
          aiMeta.moleculeAttempts.push(...extResult.attemptsLog);
        }
        validationTrace.push({
          attempt,
          phase: 'extend_molecules',
          ok: true,
          missing: miss,
          added: extResult.missingResolved
        });
      } catch (error) {
        validationTrace.push({
          attempt,
          phase: 'extend_molecules',
          ok: false,
          missing: miss,
          error: error.message,
          code: error.code || null
        });
        lastError = `缺少分子 ${miss.join(', ')} 且自动扩展失败: ${error.message}`;
        if (attempt >= maxAttempts) {
          const err = new Error(lastError);
          err.code = error.code || 'MOLECULE_EXTEND_FAILED';
          err.validationTrace = validationTrace;
          err.aiMeta = aiMeta;
          err.spec = spec;
          err.moleculeExtensions = moleculeExtensions;
          throw err;
        }
        continue;
      }
    } else {
      // still pass any active extensions
      try {
        const active = listActiveMoleculeExtensions();
        if (active.length) {
          const { writeTempExtensionsFile } = await import('./moleculeStore.js');
          extensionsFile = writeTempExtensionsFile(active, workDir);
        }
      } catch { /* ignore */ }
    }

    await onProgress?.({ progress: 25 + attempt * 12, currentStage: `校验化学 Spec（第 ${attempt} 次）` });
    const validated = await validateChemSpec(spec, { pythonBin, workDir, extensionsFile });
    if (validated.ok) {
      validationTrace.push({ attempt, phase: 'validate', ok: true, summary: validated.summary });
      break;
    }

    // if validate fails with unknown species, try extend once more from error text
    const unknown = String(validated.error || '').match(/未知物种\s+([A-Za-z0-9]+)/);
    if (unknown) {
      validationTrace.push({ attempt, phase: 'validate', ok: false, error: validated.error, missingHint: unknown[1] });
      try {
        await ensureSpeciesForSpec({
          ...spec,
          reactants: [...(spec.reactants || []), { species: unknown[1], count: 1 }],
          products: spec.products || []
        }, {
          pythonBin,
          workDir,
          model: ai.sub2api?.model || process.env.SUB2API_MODEL,
          signal,
          reactionHint: content,
          persist: true
        });
        const active = listActiveMoleculeExtensions();
        const { writeTempExtensionsFile } = await import('./moleculeStore.js');
        extensionsFile = writeTempExtensionsFile(active, workDir);
        const revalidated = await validateChemSpec(spec, { pythonBin, workDir, extensionsFile });
        if (revalidated.ok) {
          validationTrace.push({ attempt, phase: 'validate_after_extend', ok: true, summary: revalidated.summary });
          break;
        }
        lastError = revalidated.error;
        validationTrace.push({ attempt, phase: 'validate_after_extend', ok: false, error: revalidated.error });
      } catch (error) {
        lastError = error.message;
        validationTrace.push({ attempt, phase: 'extend_from_error', ok: false, error: error.message });
      }
    } else {
      lastError = validated.error;
      validationTrace.push({ attempt, phase: 'validate', ok: false, error: validated.error });
    }

    if (attempt >= maxAttempts) {
      const err = new Error(`化学 Spec 校验失败: ${lastError}`);
      err.code = 'CHEM_VALIDATION_FAILED';
      err.validationTrace = validationTrace;
      err.aiMeta = aiMeta;
      err.spec = spec;
      err.moleculeExtensions = moleculeExtensions;
      throw err;
    }
  }

  await onProgress?.({ progress: 80, currentStage: '渲染化学课件 HTML' });
  // ensure latest extensions file
  if (!extensionsFile) {
    const active = listActiveMoleculeExtensions();
    if (active.length) {
      const { writeTempExtensionsFile } = await import('./moleculeStore.js');
      extensionsFile = writeTempExtensionsFile(active, workDir);
    }
  }
  const rendered = await renderChemSpec(spec, outputPath, { pythonBin, workDir, extensionsFile });
  if (!rendered.ok) {
    const err = new Error(`化学课件渲染失败: ${rendered.error}`);
    err.code = 'CHEM_RENDER_FAILED';
    err.validationTrace = validationTrace;
    err.aiMeta = aiMeta;
    err.spec = spec;
    err.moleculeExtensions = moleculeExtensions;
    throw err;
  }

  const title = job.title || spec?.meta?.title || '化学反应演示';
  aiMeta.route = 'llm_spec';
  if (moleculeExtensions.length) aiMeta.moleculeExtended = moleculeExtensions.map(m => m.id);
  return {
    skillId: 'edu-chem-reaction',
    problemType: 'ai_dynamic',
    title,
    spec,
    validationTrace,
    moleculeExtensions,
    aiMeta,
    outputPath
  };
}

export function isChemAiJob(job) {
  if (job?.kind !== 'ai') return false;
  const hint = job.skillHint || job.skillId || '';
  if (hint === 'edu-chem-reaction') return true;
  if (hint === 'edu-analytic-geometry' || hint === 'edu-solid-geometry') return false;
  // auto: default chem for M1 when no math hint
  return !hint || hint === 'auto' || hint === '';
}
