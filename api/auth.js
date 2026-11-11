import { getSql, ensureSchema } from '../lib/db.js';
import { verifyPassword, dummyHash, signSession, readSession, sessionCookie } from '../lib/auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 *  GET  /api/auth                                 -> who is signed in (401 if nobody)
 *  POST /api/auth { action: 'login', username, password }
 *  POST /api/auth { action: 'logout' }
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = getSql();
    await ensureSchema(sql);

    if (req.method === 'GET') {
      const s = readSession(req);
      const found = s ? await sql`select code from accounts where code = ${s.code}` : [];
      if (!found.length) return res.status(401).json({ error: 'Please sign in.', code: 'session' });
      return res.status(200).json({ account: { code: found[0].code } });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    body = body || {};

    if (body.action === 'logout') {
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return res.status(200).json({ ok: true });
    }
    if (body.action !== 'login') return res.status(400).json({ error: 'Unknown action.' });

    const code = String(body.username ?? '').trim().toUpperCase();
    const rows = code ? await sql`select code, password_hash from accounts where code = ${code}` : [];
    // always run one password check, so timing doesn't reveal whether the account exists
    const ok = verifyPassword(body.password, rows[0]?.password_hash || dummyHash());
    if (!rows.length || !ok) {
      await sleep(400); // slows down password guessing
      return res.status(401).json({ error: 'Incorrect account or password.', code: 'login' });
    }
    res.setHeader('Set-Cookie', sessionCookie(req, signSession(rows[0].code)));
    return res.status(200).json({ ok: true, account: { code: rows[0].code } });
  } catch (err) {
    console.error('auth error', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
