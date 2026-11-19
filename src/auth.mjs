import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COST = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 2 ** 20 };

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- passwords (scrypt) ----
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, 32, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const key = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: COST.maxmem });
    return crypto.timingSafeEqual(key, want);
  } catch {
    return false;
  }
}

// Checked against when the login does not exist, so response time does not reveal valid logins.
export const DUMMY_HASH = await hashPassword(token());

export function passwordProblem(pw, login) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (login && pw.toLowerCase().includes(login.toLowerCase())) return 'The password must not contain your login.';
  return null;
}

export const otp = () => String(crypto.randomInt(1e6)).padStart(6, '0');

export function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 16 }, () => abc[crypto.randomInt(abc.length)]).join('');
}

// ---- brute-force protection: lock a key after `max` failures inside the window ----
export function throttle({ max, windowMs = 15 * 60e3, lockMs = 15 * 60e3 }) {
  const hits = new Map();
  return {
    wait(key) {
      const e = hits.get(key);
      return e && e.until > Date.now() ? e.until - Date.now() : 0;
    },
    fail(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || now - e.since > windowMs) hits.set(key, (e = { n: 0, since: now, until: 0 }));
      if (++e.n >= max) Object.assign(e, { n: 0, since: now, until: now + lockMs });
    },
    clear: key => hits.delete(key),
    sweep() {
      const now = Date.now();
      for (const [k, e] of hits) if (e.until < now && now - e.since > windowMs) hits.delete(k);
    },
  };
}
