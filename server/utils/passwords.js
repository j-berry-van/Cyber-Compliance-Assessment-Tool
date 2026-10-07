import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
