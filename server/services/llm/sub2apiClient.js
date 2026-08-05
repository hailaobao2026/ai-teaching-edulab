/**
 * Sub2API OpenAI-compatible client (server-side only).
 * OpenAI-compatible chat + vision + models health check.
 */

const DEFAULT_TIMEOUT_MS = Math.max(5_000, Number(process.env.SUB2API_TIMEOUT_MS || 120_000));
const DEFAULT_RETRIES = Math.max(0, Number(process.env.SUB2API_MAX_RETRIES || 2));

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

export function getSub2ApiConfig(overrides = {}) {
  // Use nullish coalescing so explicit empty overrides win (tests/health unconfigured path).
  const baseUrl = trimSlash(overrides.baseUrl ?? process.env.SUB2API_BASE_URL ?? '');
  const apiKey = overrides.apiKey ?? process.env.SUB2API_API_KEY ?? '';
  const model = overrides.model ?? process.env.SUB2API_MODEL ?? '';
  const visionModel = overrides.visionModel ?? process.env.SUB2API_VISION_MODEL ?? model;
  return {
    baseUrl,
    apiKey,
    model,
    visionModel,
    timeoutMs: Number(overrides.timeoutMs || DEFAULT_TIMEOUT_MS),
    maxRetries: Number(overrides.maxRetries ?? DEFAULT_RETRIES),
    configured: Boolean(baseUrl && apiKey)
  };
}

function classifyError(status, bodyText) {
  const text = String(bodyText || '');
  if (/aliyun_waf|aliyunCaptcha|进行验证/i.test(text) || text.includes('<!doctypehtml') || text.includes('<!DOCTYPE html')) {
    return { code: 'UPSTREAM_WAF', message: '上游返回防护页（WAF），请检查 sub2api 网关放行 API' };
  }
  if (status === 401 || status === 403) return { code: 'UPSTREAM_AUTH', message: 'sub2api 鉴权失败' };
  if (status === 429) return { code: 'UPSTREAM_RATE_LIMIT', message: 'sub2api 限流' };
  if (status >= 500) return { code: 'UPSTREAM_5XX', message: `sub2api 服务错误 HTTP ${status}` };
  if (status > 0) return { code: 'UPSTREAM_HTTP', message: `sub2api HTTP ${status}` };
  return { code: 'UPSTREAM_NETWORK', message: 'sub2api 网络错误' };
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function sub2apiFetch(path, { method = 'GET', body, config, signal } = {}) {
  const cfg = { ...getSub2ApiConfig(), ...config };
  if (!cfg.configured) {
    const err = new Error('sub2api 未配置（需要 SUB2API_BASE_URL 与 SUB2API_API_KEY）');
    err.code = 'SUB2API_NOT_CONFIGURED';
    throw err;
  }
  const url = `${cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  let lastError;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': process.env.SUB2API_USER_AGENT || 'OpenAI/JS 4.73.0'
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await res.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      if (!res.ok) {
        const classified = classifyError(res.status, raw);
        const err = new Error(classified.message);
        err.code = classified.code;
        err.status = res.status;
        err.body = data || raw.slice(0, 500);
        throw err;
      }
      if (data == null && raw) {
        const classified = classifyError(res.status || 200, raw);
        if (classified.code === 'UPSTREAM_WAF') {
          const err = new Error(classified.message);
          err.code = classified.code;
          throw err;
        }
      }
      return { data, raw, status: res.status };
    } catch (error) {
      lastError = error;
      if (error.name === 'AbortError') {
        const err = new Error('sub2api 请求超时或取消');
        err.code = signal?.aborted ? 'SUB2API_ABORTED' : 'SUB2API_TIMEOUT';
        lastError = err;
      }
      if (lastError?.code === 'SUB2API_ABORTED') throw lastError;
      if (error.code === 'SUB2API_NOT_CONFIGURED') throw error;
      if (attempt >= cfg.maxRetries) break;
      await sleep(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

export async function listModels(config) {
  const { data } = await sub2apiFetch('/models', { method: 'GET', config });
  return data;
}

export async function chatCompletions({ messages, model, temperature = 0.2, responseFormat, config, signal } = {}) {
  const cfg = { ...getSub2ApiConfig(), ...config };
  const payload = {
    model: model || cfg.model,
    messages,
    temperature
  };
  if (!payload.model) {
    const err = new Error('未配置 SUB2API_MODEL');
    err.code = 'SUB2API_MODEL_MISSING';
    throw err;
  }
  if (responseFormat) payload.response_format = responseFormat;
  const { data } = await sub2apiFetch('/chat/completions', { method: 'POST', body: payload, config: cfg, signal });
  const choice = data?.choices?.[0];
  return {
    id: data?.id,
    model: data?.model || payload.model,
    content: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? choice?.finishReason ?? null,
    usage: data?.usage || null,
    raw: data
  };
}


export async function visionCompletions({
  prompt,
  imageUrl,
  imageBase64,
  mimeType = 'image/png',
  model,
  temperature = 0.1,
  responseFormat,
  config,
  signal
} = {}) {
  const cfg = { ...getSub2ApiConfig(), ...config };
  const useModel = model || cfg.visionModel || cfg.model;
  if (!useModel) {
    const err = new Error('未配置 SUB2API_VISION_MODEL / SUB2API_MODEL');
    err.code = 'SUB2API_MODEL_MISSING';
    throw err;
  }
  let url = imageUrl || '';
  if (!url && imageBase64) {
    const clean = String(imageBase64).replace(/^data:[^;]+;base64,/, '');
    url = `data:${mimeType || 'image/png'};base64,${clean}`;
  }
  if (!url) {
    const err = new Error('vision 需要 imageUrl 或 imageBase64');
    err.code = 'VISION_IMAGE_MISSING';
    throw err;
  }
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: String(prompt || '请识别图片中的题目') },
        { type: 'image_url', image_url: { url } }
      ]
    }
  ];
  return chatCompletions({
    messages,
    model: useModel,
    temperature,
    responseFormat,
    config: cfg,
    signal
  });
}

export async function healthCheck(config) {
  const cfg = getSub2ApiConfig(config);
  if (!cfg.configured) {
    return { ok: false, configured: false, code: 'SUB2API_NOT_CONFIGURED', message: '未配置 baseUrl/apiKey' };
  }
  try {
    const models = await listModels(cfg);
    const count = Array.isArray(models?.data) ? models.data.length : (Array.isArray(models) ? models.length : null);
    return { ok: true, configured: true, model: cfg.model, models: count, baseUrl: cfg.baseUrl };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      code: error.code || 'SUB2API_ERROR',
      message: error.message,
      status: error.status || null,
      baseUrl: cfg.baseUrl
    };
  }
}
