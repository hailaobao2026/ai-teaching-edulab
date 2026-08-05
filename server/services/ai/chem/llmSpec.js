import { chatCompletions, getSub2ApiConfig } from '../../llm/sub2apiClient.js';
import { chemRepairSystemPrompt, chemSystemPrompt, chemUserPrompt } from './prompts.js';
import { sanitizeTree } from '../sanitize.js';

function stripCodeFence(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  return s;
}

export function extractJsonObject(text) {
  const s = stripCodeFence(text);
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(s.slice(start, end + 1));
  }
  throw Object.assign(new Error('模型未返回合法 JSON'), { code: 'LLM_JSON_PARSE' });
}


function speciesCounts(list = []) {
  const m = new Map();
  for (const item of list || []) {
    const id = item?.species;
    const c = Number(item?.count || 1);
    if (!id) continue;
    m.set(id, (m.get(id) || 0) + c);
  }
  return m;
}

function maybeSynthesizeSimpleAtomMap(spec) {
  if (Array.isArray(spec.atom_map) && spec.atom_map.length) return spec;
  const r = speciesCounts(spec.reactants);
  const p = speciesCounts(spec.products);
  // C + O2 -> CO2
  if (r.get('C') === 1 && r.get('O2') === 1 && p.get('CO2') === 1 && r.size === 2 && p.size === 1) {
    spec.atom_map = [
      ['C#1.X', 'CO2#1.Y'],
      ['O2#1.Oa', 'CO2#1.Xa'],
      ['O2#1.Ob', 'CO2#1.Xb']
    ];
  }
  // 2H2 + O2 -> 2H2O
  if (r.get('H2') === 2 && r.get('O2') === 1 && p.get('H2O') === 2 && r.size === 2 && p.size === 1) {
    spec.atom_map = [
      ['O2#1.Oa', 'H2O#1.A'], ['O2#1.Ob', 'H2O#2.A'],
      ['H2#1.Ha', 'H2O#1.Ha'], ['H2#1.Hb', 'H2O#1.Hb'],
      ['H2#2.Ha', 'H2O#2.Ha'], ['H2#2.Hb', 'H2O#2.Hb']
    ];
  }
  return sanitizeTree(spec);
}

export function normalizeChemSpec(raw) {
  const spec = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
  if (!spec || typeof spec !== 'object') throw Object.assign(new Error('spec 为空'), { code: 'SPEC_EMPTY' });
  if (!spec.meta || typeof spec.meta !== 'object') spec.meta = {};
  spec.meta.language = spec.meta.language || 'zh-CN';
  spec.meta.engine = 'morph';
  if (!spec.meta.title) spec.meta.title = '化学反应演示';
  if (!Array.isArray(spec.steps) || !spec.steps.length) {
    spec.steps = [
      { title: '反应物', html: '反应物分子靠近。' },
      { title: '反应过程', html: '化学键断裂并重组。' },
      { title: '产物', html: '生成产物，原子守恒。' }
    ];
  }
  // normalize step field html vs content
  spec.steps = spec.steps.map(step => ({
    title: step.title || '步骤',
    html: step.html || step.content || ''
  }));
  maybeSynthesizeSimpleAtomMap(spec);
  // drop clearly invalid atom_map entries like bare element symbols without #
  if (Array.isArray(spec.atom_map)) {
    const cleaned = spec.atom_map.filter(pair => Array.isArray(pair) && pair.length === 2 && String(pair[0]).includes('#') && String(pair[1]).includes('#'));
    if (cleaned.length) spec.atom_map = cleaned;
    else delete spec.atom_map;
    maybeSynthesizeSimpleAtomMap(spec);
  }
  return spec;
}

export async function generateChemSpecFromLlm({ content, inputMode, model, signal, previousError, previousSpec }) {
  const cfg = getSub2ApiConfig({ model });
  if (!cfg.configured) {
    const err = new Error('sub2api 未配置');
    err.code = 'SUB2API_NOT_CONFIGURED';
    throw err;
  }
  const system = previousError ? chemRepairSystemPrompt() : chemSystemPrompt();
  const user = chemUserPrompt({ content, inputMode, previousError, previousSpec });
  const result = await chatCompletions({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    model: model || cfg.model,
    temperature: previousError ? 0.1 : 0.2,
    responseFormat: { type: 'json_object' },
    signal
  });
  const parsed = extractJsonObject(result.content);
  const spec = normalizeChemSpec(parsed);
  return { spec, usage: result.usage, model: result.model, finishReason: result.finishReason, rawContent: result.content };
}
