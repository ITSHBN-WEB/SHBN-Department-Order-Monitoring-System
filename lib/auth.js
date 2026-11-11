import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';

/**
 * Sign-in helpers.
 *  - Passwords are never stored in plain text: only salted scrypt hashes ('scrypt$salt$hash').
 *  - A successful sign-in sets an HttpOnly, SameSite=Strict cookie holding a signed token (account + expiry).
 *    The signing key is derived from SESSION_SECRET, or from DATABASE_URL (already a secret in Vercel),
 *    so no extra setup is needed.
 */
const COOKIE = 'doms_session';
export const SESSION_HOURS = 12;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [, saltB64, hashB64] = String(stored).split('$');
    const expected = Buffer.from(hashB64, 'base64');
    const got = scryptSync(String(pw ?? ''), Buffer.from(saltB64, 'base64'), expected.length);
    return timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

let dummy;
/** A real hash to compare against for unknown accounts, so response time doesn't reveal which accounts exist. */
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password'));

function key() {
  const s = process.env.SESSION_SECRET || process.env.DATABASE_URL || (globalThis.__DOMS_SQL__ ? 'doms-local-dev-secret' : '');
  if (!s) throw new Error('Set SESSION_SECRET or DATABASE_URL');
  return createHash('sha256').update('doms-session|' + s).digest();
}
const mac = (body) => createHmac('sha256', key()).update(body).digest('base64url');

export function signSession(code, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ a: code, e: Math.floor(now / 1000) + SESSION_HOURS * 3600 })).toString('base64url');
  return `${body}.${mac(body)}`;
}

/** Returns { code } for a valid, unexpired session cookie, otherwise null. */
export function readSession(req) {
  const raw = String(req.headers?.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(mac(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { a: code, e } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return typeof code === 'string' && e > Date.now() / 1000 ? { code } : null;
  } catch {
    return null;
  }
}

export function sessionCookie(req, token, maxAge = SESSION_HOURS * 3600) {
  const secure = req.headers?.['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** Signed-in account code, or sends 401 and returns null. */
export async function requireAccount(req, res, sql) {
  const s = readSession(req);
  const found = s ? await sql`select code from accounts where code = ${s.code}` : [];
  if (!found.length) {
    res.status(401).json({ error: 'Please sign in.', code: 'session' });
    return null;
  }
  return s.code;
}

/** Which admin does this password unlock? 'hq' (all accounts), 'account' (own account) or null. */
export async function adminScope(sql, password) {
  const rows = await sql`select key, value from settings where key in ('admin_hash', 'hq_hash')`;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const hq = verifyPassword(password, m.hq_hash || dummyHash());
  const own = verifyPassword(password, m.admin_hash || dummyHash());
  return hq ? 'hq' : own ? 'account' : null;
}
