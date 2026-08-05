import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { visionCompletions, chatCompletions, getSub2ApiConfig } from '../../llm/sub2apiClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../');

const SKILL_HINTS = new Set(['edu-chem-reaction', 'edu-analytic-geometry', 'edu-solid-geometry']);

export function imageUploadsRoot() {
  return process.env.AI_IMAGE_UPLOAD_ROOT
    || path.join(projectRoot, 'server', 'uploads', 'ai-images');
}

export function stripDataUrl(base64OrDataUrl = '') {
  const s = String(base64OrDataUrl || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) return { mimeType: m[1], base64: m[2] };
  return { mimeType: null, base64: s.replace(/\s+/g, '') };
}

export function guessExt(mimeType = '') {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

export function saveImageAsset({ draftId, base64, mimeType = 'image/png' }) {
  const root = imageUploadsRoot();
  fs.mkdirSync(root, { recursive: true });
  const ext = guessExt(mimeType);
  const fileName = `${draftId || `img_${Date.now()}`}.${ext}`;
  const abs = path.join(root, fileName);
  const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!buf.length) {
    const err = new Error('图片内容为空');
    err.code = 'IMAGE_EMPTY';
    throw err;
  }
  const maxBytes = Math.max(100_000, Number(process.env.AI_IMAGE_MAX_BYTES || 5_000_000));
  if (buf.length > maxBytes) {
    const err = new Error(`图片过大，超过 ${maxBytes} 字节`);
    err.code = 'IMAGE_TOO_LARGE';
    throw err;
  }
  fs.writeFileSync(abs, buf);
  return { absPath: abs, relPath: path.relative(projectRoot, abs), bytes: buf.length, mimeType, fileName };
}

function recognitionSystemPrompt() {
  return `你是教学习题图片识别器。只输出 JSON，不要 markdown。
从图片中提取题目信息，格式：
{
  "skillId": "edu-chem-reaction" | "edu-analytic-geometry" | "edu-solid-geometry" | "",
  "problemText": "完整题干文本（尽量保留公式 LaTeX）",
  "equation": "关键方程/反应式（若有）",
  "conditions": "已知条件摘要",
  "ask": "所求问题",
  "confidence": 0.0,
  "warnings": ["..."],
  "language": "zh-CN"
}
规则：
1. 化学题 skillId=edu-chem-reaction；圆锥曲线/解析几何=edu-analytic-geometry；立体几何=edu-solid-geometry。
2. confidence 0~1；看不清就降低并写 warnings。
3. 公式尽量用 LaTeX（$...$ 可省略定界）。
4. 无法识别时 problemText 置空，confidence<=0.2，warnings 说明原因。
`;
}

export function extractJsonObject(text) {
  let s = String(text || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw Object.assign(new Error('识别结果不是合法 JSON'), { code: 'VISION_JSON_PARSE' });
}

export function normalizeRecognition(raw, { skillHint = '', note = '' } = {}) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  let skillId = String(obj.skillId || obj.skill_id || skillHint || '').trim();
  if (skillId && !SKILL_HINTS.has(skillId)) skillId = skillHint || '';
  const problemText = String(obj.problemText || obj.problem || obj.text || note || '').trim();
  const equation = String(obj.equation || obj.formula || '').trim();
  const conditions = String(obj.conditions || '').trim();
  const ask = String(obj.ask || obj.question || '').trim();
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = problemText ? 0.6 : 0.1;
  confidence = Math.max(0, Math.min(1, confidence));
  const warnings = Array.isArray(obj.warnings) ? obj.warnings.map(String) : [];
  if (!problemText && !equation) warnings.push('未能识别出有效题干，请手工填写后确认');
  if (!skillId) {
    const blob = `${problemText}\n${equation}\n${conditions}\n${ask}`;
    if (/椭圆|双曲线|抛物线|离心率|圆锥曲线|弦长|数量积|斜率/.test(blob)) skillId = 'edu-analytic-geometry';
    else if (/正方体|长方体|棱锥|二面角|异面|线面角|立体几何/.test(blob)) skillId = 'edu-solid-geometry';
    else if (/燃烧|电解|氧化还原|酯化|反应|化学|分子|O2|H2O/.test(blob)) skillId = 'edu-chem-reaction';
  }
  return {
    skillId,
    editable: {
      skillId,
      problemText,
      equation,
      conditions,
      ask,
      language: obj.language || 'zh-CN'
    },
    confidence,
    warnings,
    raw: obj
  };
}

export async function recognizeProblemFromImage({
  imageBase64,
  imageUrl,
  mimeType = 'image/png',
  skillHint = '',
  note = '',
  model,
  signal
} = {}) {
  const cfg = getSub2ApiConfig({ model });
  if (!cfg.configured) {
    const err = new Error('sub2api 未配置，无法识图');
    err.code = 'SUB2API_NOT_CONFIGURED';
    throw err;
  }

  const prompt = [
    recognitionSystemPrompt(),
    skillHint ? `用户提示学科: ${skillHint}` : '',
    note ? `用户备注: ${note}` : '',
    '请识别图中题目并输出 JSON。'
  ].filter(Boolean).join('\n');

  let result;
  try {
    result = await visionCompletions({
      prompt,
      imageBase64,
      imageUrl,
      mimeType,
      model: model || cfg.visionModel || cfg.model,
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
      signal
    });
  } catch (error) {
    // fallback: if vision endpoint/model rejects, try plain chat with note only
    if (note) {
      const chat = await chatCompletions({
        messages: [
          { role: 'system', content: recognitionSystemPrompt() },
          { role: 'user', content: `图片识别失败（${error.message}）。请仅根据备注整理 JSON：\n${note}` }
        ],
        model: model || cfg.model,
        temperature: 0.1,
        responseFormat: { type: 'json_object' },
        signal
      });
      const parsed = extractJsonObject(chat.content);
      const normalized = normalizeRecognition(parsed, { skillHint, note });
      normalized.warnings = [
        ...(normalized.warnings || []),
        `视觉模型调用失败，已降级为备注解析: ${error.message}`
      ];
      normalized.confidence = Math.min(normalized.confidence, 0.35);
      return {
        ...normalized,
        usage: chat.usage,
        model: chat.model,
        finishReason: chat.finishReason,
        degraded: true
      };
    }
    throw error;
  }

  const parsed = extractJsonObject(result.content);
  const normalized = normalizeRecognition(parsed, { skillHint, note });
  return {
    ...normalized,
    usage: result.usage,
    model: result.model,
    finishReason: result.finishReason,
    degraded: false
  };
}

export function buildConfirmSourceText(editable = {}) {
  return [editable.problemText, editable.equation, editable.conditions, editable.ask]
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
