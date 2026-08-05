import { getSystemConfig } from '../../db.js';
import { getSub2ApiConfig } from '../llm/sub2apiClient.js';
import { ROLES, normalizeRole } from '../rbac.js';

const DEFAULT_QUOTA = {
  [ROLES.STUDENT]: 10,
  [ROLES.TEACHER]: 50,
  [ROLES.ADMIN]: 200
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getAiRuntimeConfig() {
  const sys = await getSystemConfig();
  const env = getSub2ApiConfig({
    baseUrl: sys.ai_sub2api_base_url || process.env.SUB2API_BASE_URL,
    apiKey: process.env.SUB2API_API_KEY,
    model: sys.ai_model || process.env.SUB2API_MODEL,
    visionModel: sys.ai_vision_model || process.env.SUB2API_VISION_MODEL || sys.ai_model || process.env.SUB2API_MODEL
  });

  const enabled = String(sys.ai_enabled ?? process.env.AI_ENABLED ?? 'true').toLowerCase() !== 'false';
  const allowRoles = String(sys.ai_allow_roles || 'student,teacher,admin')
    .split(',')
    .map(s => normalizeRole(s.trim()))
    .filter(Boolean);

  return {
    enabled,
    allowRoles,
    imageConfirmRequired: String(sys.ai_image_confirm_required ?? 'true').toLowerCase() !== 'false',
    maxRepairAttempts: Math.max(0, num(sys.ai_max_repair_attempts, Number(process.env.AI_MAX_REPAIR_ATTEMPTS || 3))),
    quota: {
      student: num(sys.ai_quota_student, DEFAULT_QUOTA.student),
      teacher: num(sys.ai_quota_teacher, DEFAULT_QUOTA.teacher),
      admin: num(sys.ai_quota_admin, DEFAULT_QUOTA.admin)
    },
    sub2api: {
      configured: env.configured,
      baseUrl: env.baseUrl,
      model: env.model,
      visionModel: env.visionModel,
      hasApiKey: Boolean(process.env.SUB2API_API_KEY)
    }
  };
}

export function quotaLimitForRole(aiConfig, role) {
  const r = normalizeRole(role);
  if (r === ROLES.ADMIN) return aiConfig.quota.admin;
  if (r === ROLES.TEACHER) return aiConfig.quota.teacher;
  return aiConfig.quota.student;
}

export function roleAllowedForAi(aiConfig, role) {
  if (!aiConfig.enabled) return false;
  return aiConfig.allowRoles.includes(normalizeRole(role));
}

export function publicAiConfig(aiConfig) {
  return {
    enabled: aiConfig.enabled,
    allowRoles: aiConfig.allowRoles,
    imageConfirmRequired: aiConfig.imageConfirmRequired,
    maxRepairAttempts: aiConfig.maxRepairAttempts,
    quota: aiConfig.quota,
    sub2api: {
      configured: aiConfig.sub2api.configured,
      baseUrl: aiConfig.sub2api.baseUrl || '',
      model: aiConfig.sub2api.model || '',
      visionModel: aiConfig.sub2api.visionModel || '',
      hasApiKey: aiConfig.sub2api.hasApiKey
    }
  };
}
