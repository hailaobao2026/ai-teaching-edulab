import { getAiDailyUsage, consumeAiDailyQuota } from '../../db.js';
import { getAiRuntimeConfig, quotaLimitForRole } from './config.js';

export function quotaDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function getQuotaStatus(user) {
  const aiConfig = await getAiRuntimeConfig();
  const date = quotaDate();
  const limit = quotaLimitForRole(aiConfig, user.role);
  const used = await getAiDailyUsage(user.id, date);
  const remaining = Math.max(0, limit - used);
  return {
    role: user.role,
    date,
    limit,
    used,
    remaining,
    enabled: aiConfig.enabled
  };
}

/**
 * Consume 1 AI job quota. Returns status or throws with code QUOTA_EXCEEDED.
 */
export async function consumeAiQuota(user) {
  const aiConfig = await getAiRuntimeConfig();
  if (!aiConfig.enabled) {
    const err = new Error('AI 生成未启用');
    err.code = 'AI_DISABLED';
    throw err;
  }
  const { roleAllowedForAi } = await import('./config.js');
  if (!roleAllowedForAi(aiConfig, user.role)) {
    const err = new Error('当前角色不允许使用 AI 生成');
    err.code = 'AI_ROLE_FORBIDDEN';
    throw err;
  }
  const date = quotaDate();
  const limit = quotaLimitForRole(aiConfig, user.role);
  const next = await consumeAiDailyQuota(user.id, date, limit);
  return {
    role: user.role,
    date,
    limit,
    used: next,
    remaining: Math.max(0, limit - next),
    enabled: true
  };
}
