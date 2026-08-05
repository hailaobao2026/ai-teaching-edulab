import { chatCompletions, getSub2ApiConfig } from '../../llm/sub2apiClient.js';
import { extractJsonObject } from './llmSpec.js';
import {
  findMoleculeExtension,
  listActiveMoleculeExtensions,
  normalizeMoleculeDefinition,
  staticCheckMolecule,
  upsertMoleculeExtension,
  writeTempExtensionsFile
} from './moleculeStore.js';
import { selfcheckMolecule } from './validateRender.js';

const BUILTIN_SPECIES = new Set([
  'H2', 'O2', 'N2', 'Cl2', 'CO', 'CO2', 'H2O', 'CH4', 'NH3', 'Na', 'C', 'Fe', 'Mg', 'NaCl', 'Glucose'
]);

export function collectSpeciesFromSpec(spec) {
  const ids = new Set();
  for (const side of ['reactants', 'products']) {
    for (const item of spec?.[side] || []) {
      if (item?.species) ids.add(String(item.species).trim());
    }
  }
  // also parse atom_map SPECIES#n.slot
  for (const pair of spec?.atom_map || []) {
    for (const ref of pair || []) {
      const m = String(ref).match(/^([A-Za-z][A-Za-z0-9]*)#/);
      if (m) ids.add(m[1]);
    }
  }
  return [...ids].filter(Boolean);
}

export function missingSpecies(spec, knownSet) {
  const known = knownSet || new Set([...BUILTIN_SPECIES, ...listActiveMoleculeExtensions().map(m => m.id)]);
  return collectSpeciesFromSpec(spec).filter(id => !known.has(id));
}

function moleculeSystemPrompt() {
  return `你是化学分子三维几何定义生成器（VSEPR 理想化）。只输出 JSON 对象，不要 markdown。

输出格式：
{
  "id": "SO2",
  "formula": "SO₂",
  "latex": "\\\\text{SO}_2",
  "name": "二氧化硫",
  "name_en": "sulfur dioxide",
  "color": "yellow",
  "atoms": [
    {"slot": "A", "el": "S", "pos": [0, 0, 0]},
    {"slot": "Oa", "el": "O", "pos": [1.1, 0.7, 0]},
    {"slot": "Ob", "el": "O", "pos": [-1.1, 0.7, 0]}
  ],
  "bonds": [
    {"a": "A", "b": "Oa", "order": 2},
    {"a": "A", "b": "Ob", "order": 2}
  ]
}

硬性规则：
1. 仅使用元素: H,C,N,O,S,Cl,Na,Fe,Cu,Mg
2. 坐标为局部理想几何，键长大约 0.9~1.5；中心常在原点
3. slot 在分子内唯一；常见约定：单原子 X；双原子 Oa/Ob 或 Ha/Hb；线形三原子中心 Y 两端 Xa/Xb；弯曲中心 A
4. bonds.order 只能是 1/2/3 或 "ionic"
5. color 用 sky/red/blue/green/slate/cyan/amber/orange/purple/yellow/gray/pink 之一
6. 不要输出 SMILES、Python 代码或额外说明
7. id 必须与用户请求的 species 一致
`;
}

function moleculeUserPrompt(speciesId, context = {}) {
  const parts = [
    `请为物种 ID=${speciesId} 生成分子几何 JSON。`,
    context.reactionHint ? `出现在反应上下文: ${context.reactionHint}` : '',
    context.previousError ? `上次失败请修复: ${context.previousError}` : '',
    context.previousMolecule ? `上次定义: ${JSON.stringify(context.previousMolecule)}` : ''
  ].filter(Boolean);
  return parts.join('\n');
}

export async function generateMoleculeFromLlm(speciesId, { model, signal, previousError, previousMolecule, reactionHint } = {}) {
  const cfg = getSub2ApiConfig({ model });
  if (!cfg.configured) {
    const err = new Error('sub2api 未配置，无法扩展分子库');
    err.code = 'SUB2API_NOT_CONFIGURED';
    throw err;
  }
  const result = await chatCompletions({
    messages: [
      { role: 'system', content: moleculeSystemPrompt() },
      { role: 'user', content: moleculeUserPrompt(speciesId, { previousError, previousMolecule, reactionHint }) }
    ],
    model: model || cfg.model,
    temperature: previousError ? 0.1 : 0.2,
    responseFormat: { type: 'json_object' },
    signal
  });
  const parsed = extractJsonObject(result.content);
  if (parsed && !parsed.id) parsed.id = speciesId;
  const mol = normalizeMoleculeDefinition(parsed, speciesId);
  if (mol.id !== speciesId) {
    const err = new Error(`分子 id 与请求不一致: ${mol.id} != ${speciesId}`);
    err.code = 'MOL_ID_MISMATCH';
    throw err;
  }
  return { molecule: mol, usage: result.usage, model: result.model, finishReason: result.finishReason };
}

/**
 * Ensure all species in spec exist (builtin + extension store + optional in-memory candidates).
 * Returns { extensions: [...new persisted], extensionsFile, missingResolved }
 */
export async function ensureSpeciesForSpec(spec, {
  pythonBin,
  workDir,
  model,
  signal,
  reactionHint,
  maxAttempts = 2,
  onProgress,
  persist = true
} = {}) {
  const active = listActiveMoleculeExtensions();
  const known = new Set([...BUILTIN_SPECIES, ...active.map(m => m.id)]);
  let missing = missingSpecies(spec, known);
  if (!missing.length) {
    return {
      extensions: [],
      allExtensions: active,
      extensionsFile: writeTempExtensionsFile(active, workDir),
      missingResolved: []
    };
  }

  const newly = [];
  const sessionCandidates = [...active];
  const attemptsLog = [];

  for (const speciesId of missing) {
    await onProgress?.({ currentStage: `扩展分子库: ${speciesId}` });
    const existing = findMoleculeExtension(speciesId);
    if (existing) {
      known.add(speciesId);
      continue;
    }

    let lastError = '';
    let lastMol = null;
    let okMol = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const gen = await generateMoleculeFromLlm(speciesId, {
          model,
          signal,
          previousError: lastError || undefined,
          previousMolecule: lastMol || undefined,
          reactionHint: reactionHint || JSON.stringify({
            reactants: spec.reactants,
            products: spec.products
          })
        });
        lastMol = gen.molecule;
        const checked = await selfcheckMolecule(gen.molecule, { pythonBin, workDir });
        attemptsLog.push({ speciesId, attempt, ok: checked.ok, error: checked.error || null, usage: gen.usage });
        if (!checked.ok) {
          lastError = checked.error || 'molecule selfcheck failed';
          continue;
        }
        okMol = gen.molecule;
        break;
      } catch (error) {
        lastError = error.message;
        attemptsLog.push({ speciesId, attempt, ok: false, error: error.message, code: error.code || null });
      }
    }

    if (!okMol) {
      const err = new Error(`无法自动扩展分子 ${speciesId}: ${lastError}`);
      err.code = 'MOLECULE_EXTEND_FAILED';
      err.attempts = attemptsLog;
      throw err;
    }

    if (persist) {
      upsertMoleculeExtension(okMol);
    }
    sessionCandidates.push(okMol);
    newly.push(okMol);
    known.add(speciesId);
  }

  const all = persist ? listActiveMoleculeExtensions() : sessionCandidates;
  return {
    extensions: newly,
    allExtensions: all,
    extensionsFile: writeTempExtensionsFile(all, workDir),
    missingResolved: newly.map(m => m.id),
    attemptsLog
  };
}

export function builtinSpeciesSet() {
  return new Set(BUILTIN_SPECIES);
}
