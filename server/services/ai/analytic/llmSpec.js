import { chatCompletions, getSub2ApiConfig } from '../../llm/sub2apiClient.js';
import { analyticRepairSystemPrompt, analyticSystemPrompt, analyticUserPrompt } from './prompts.js';
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
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw Object.assign(new Error('模型未返回合法 JSON'), { code: 'LLM_JSON_PARSE' });
}

function asPair(v, fallback) {
  if (Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))) return v;
  return fallback;
}

export function normalizeAnalyticSpec(raw) {
  let spec = raw;
  if (raw?.payload && typeof raw.payload === 'object') spec = raw.payload;
  if (raw?.lesson && raw?.board) spec = raw;
  // allow envelope AnalyticLessonSpec
  if (spec?.lesson && !spec.board && spec.board == null && raw?.board) {
    spec = { lesson: raw.lesson, steps: raw.steps, board: raw.board };
  }
  if (!spec || typeof spec !== 'object') {
    throw Object.assign(new Error('analytic spec 为空'), { code: 'SPEC_EMPTY' });
  }

  const specVersion = Number(spec.specVersion);
  const skillId = String(spec.skillId || '');
  const problemKind = String(spec.problemKind || '');

  // unwrap { specVersion, skillId, problemKind, lesson, steps, board }
  const lesson = spec.lesson && typeof spec.lesson === 'object' ? { ...spec.lesson } : {};
  const steps = Array.isArray(spec.steps) ? spec.steps.map(s => ({
    title: s?.title || '步骤',
    content: s?.content || s?.html || ''
  })) : [];
  const board = spec.board && typeof spec.board === 'object' ? { ...spec.board } : {};

  lesson.language = lesson.language || 'zh-CN';
  if (!lesson.title) lesson.title = '解析几何演示';
  if (!lesson.problem) lesson.problem = '<p>解析几何题目</p>';
  if (!lesson.answerLabel) lesson.answerLabel = '答案';
  if (!lesson.answer) lesson.answer = '';

  if (!steps.length) {
    steps.push(
      { title: '审题与建系', content: '<p>建立平面直角坐标系，写出曲线方程。</p>' },
      { title: '联立求解', content: '<p>设直线参数，与曲线联立，用韦达定理整理。</p>' },
      { title: '结论', content: `<p>答案：${lesson.answer || '见题意'}</p>` }
    );
  }

  if (!board.view || typeof board.view !== 'object') board.view = {};
  board.view.xRange = asPair(board.view.xRange, [-4, 4]);
  board.view.yRange = asPair(board.view.yRange, [-3, 3]);
  if (!Array.isArray(board.conics)) board.conics = [];
  if (!board.conics.length) {
    board.conics = [{ name: 'C', kind: 'ellipse', a: 2, b: 1.5, center: [0, 0], color: 'curve', label: 'C' }];
  }
  board.conics = board.conics.map((c, i) => {
    const item = { ...(c || {}) };
    item.name = item.name || (i === 0 ? 'C' : `C${i + 1}`);
    item.kind = String(item.kind || 'ellipse').toLowerCase();
    if (!Array.isArray(item.center) || item.center.length !== 2) item.center = [0, 0];
    item.center = item.center.map(Number);
    if (item.kind === 'ellipse' || item.kind === 'hyperbola') {
      item.a = Number(item.a || 2);
      item.b = Number(item.b || 1.5);
      if (item.kind === 'hyperbola') item.orient = item.orient === 'y' ? 'y' : 'x';
    } else if (item.kind === 'circle') {
      item.r = Number(item.r || item.a || 2);
    } else if (item.kind === 'parabola') {
      item.p = Number(item.p || 1);
      item.axis = item.axis === 'y' ? 'y' : 'x';
    } else {
      item.kind = 'ellipse';
      item.a = Number(item.a || 2);
      item.b = Number(item.b || 1.5);
    }
    item.color = item.color || 'curve';
    return item;
  });

  if (!board.points || typeof board.points !== 'object') board.points = {};
  if (!Array.isArray(board.derived)) board.derived = [];
  if (!Array.isArray(board.readouts)) board.readouts = [];
  if (!Array.isArray(board.legend)) board.legend = board.legend || [];

  if (board.param && typeof board.param === 'object') {
    const p = { ...board.param };
    p.name = p.name || 't';
    p.label = p.label || '参数';
    p.min = Number(p.min ?? 0);
    p.max = Number(p.max ?? 1);
    p.step = Number(p.step ?? 0.1);
    p.value = Number(p.value ?? p.min);
    p.standard = Number(p.standard ?? p.value);
    board.param = p;
  }

  return sanitizeTree({ specVersion, skillId, problemKind, lesson, steps, board });
}

export async function generateAnalyticSpecFromLlm({ content, inputMode, model, signal, previousError, previousSpec }) {
  const cfg = getSub2ApiConfig({ model });
  if (!cfg.configured) {
    const err = new Error('sub2api 未配置');
    err.code = 'SUB2API_NOT_CONFIGURED';
    throw err;
  }
  const system = previousError ? analyticRepairSystemPrompt() : analyticSystemPrompt();
  const user = analyticUserPrompt({ content, inputMode, previousError, previousSpec });
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
  const spec = normalizeAnalyticSpec(parsed);
  return { spec, usage: result.usage, model: result.model, finishReason: result.finishReason, rawContent: result.content };
}
