import crypto from 'node:crypto';

// URL 에 넣기 좋은 짧고 추측 불가능한 토큰
export function newToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function newId(bytes = 5) {
  return crypto.randomBytes(bytes).toString('base64url');
}
