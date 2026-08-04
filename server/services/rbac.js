export const ROLES = {
  STUDENT: 'student',
  TEACHER: 'teacher',
  ADMIN: 'admin'
};

export const LEGACY_USER_ROLE = 'student';

export function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === ROLES.ADMIN) return ROLES.ADMIN;
  if (r === ROLES.TEACHER) return ROLES.TEACHER;
  return ROLES.STUDENT;
}

export function isAdmin(user) {
  return !!user && normalizeRole(user.role) === ROLES.ADMIN;
}

export function isTeacher(user) {
  return !!user && normalizeRole(user.role) === ROLES.TEACHER;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    role: normalizeRole(user.role),
    status: user.status || 'active',
    createdAt: user.created_at || user.createdAt
  };
}

export function validateRegisterPayload(payload) {
  const errors = [];
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  const nickname = String(payload.nickname || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('邮箱格式不正确');
  }
  if (email.length > 255) errors.push('邮箱长度不能超过 255 个字符');
  if (password.length < 6 || password.length > 128) errors.push('密码长度必须为 6-128 位');
  if (!nickname) errors.push('昵称不能为空');
  if (nickname.length > 128) errors.push('昵称长度不能超过 128 个字符');

  return { email, password, nickname, errors };
}
