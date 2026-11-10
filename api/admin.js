import { createHash, timingSafeEqual } from 'node:crypto';
import { getSql, ensureSchema } from '../lib/db.js';
import { loadSettings, currentCycle, describeCycle, todayKL } from '../lib/cycle.js';

/**
 * Admin API (edit / delete submitted entries). One endpoint, POST only:
 *   { action: 'login' | 'meta' | 'list' | 'save', password, ... }
 * The password is checked here on the server for every call. Default is 8888;
 * set the ADMIN_PASSWORD environment variable in Vercel to change it without touching code.
 */
const sha = (s) => createHash('sha256').update(String(s)).digest();
const passwordOk = (given) => timingSafeEqual(sha(given ?? ''), sha(process.env.ADMIN_PASSWORD || '8888'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_ROWS = 500;
const MAX_CHANGES = 300;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  body = body || {};

  if (!passwordOk(body.password)) {
    await sleep(400); // slows down password guessing
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  try {
    const sql = getSql();
    await ensureSchema(sql);

    switch (body.action) {
      case 'login':
        return res.status(200).json({ ok: true });

      case 'meta': {
        const settings = await loadSettings(sql);
        const today = todayKL();
        const { phase, current } = currentCycle(settings, today);
        const counts = Object.fromEntries(
          (await sql`select cycle_no, count(*)::int as n from entries group by cycle_no`).map((r) => [r.cycle_no, r.n]),
        );
        const cycles = [];
        if (settings.test || counts[0]) {
          const d = settings.test ? describeCycle(settings, 0, today) : { start: null, end: null };
          cycles.push({ n: 0, start: d.start, end: d.end, count: counts[0] || 0 });
        }
        const maxLive = Math.max(phase === 'live' ? current : 0, ...Object.keys(counts).map(Number));
        for (let n = 1; n <= maxLive; n++) {
          const d = describeCycle(settings, n, today);
          cycles.push({ n, start: d.start, end: d.end, count: counts[n] || 0 });
        }
        const categories = await sql`select id, department, name from categories order by sort_order, id`;
        const defaultCycle = phase === 'upcoming' ? (cycles[0]?.n ?? 1) : current;
        return res.status(200).json({ cycles, categories, defaultCycle });
      }

      case 'list': {
        const cycle = Number(body.cycle);
        if (!Number.isInteger(cycle) || cycle < 0) return res.status(400).json({ error: 'Choose a period.' });
        const dept = typeof body.department === 'string' && body.department ? body.department : null;
        const catId = body.categoryId ? Number(body.categoryId) : null;
        if (catId !== null && !Number.isInteger(catId)) return res.status(400).json({ error: 'Invalid category.' });

        const rows = await sql`
          select e.id, e.category_id as "categoryId", c.name as category, c.department,
                 e.value::float8 as value, e.submitted_by as "submittedBy", e.cycle_no as cycle,
                 (extract(epoch from e.created_at) * 1000)::float8 as ts,
                 (extract(epoch from e.edited_at) * 1000)::float8 as "editedAt"
          from entries e join categories c on c.id = e.category_id
          where e.cycle_no = ${cycle}::int
            and (${dept}::text is null or c.department = ${dept}::text)
            and (${catId}::int is null or e.category_id = ${catId}::int)
          order by e.id desc
          limit ${MAX_ROWS + 1}`;
        return res.status(200).json({ entries: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS });
      }

      case 'save': {
        const updates = Array.isArray(body.updates) ? body.updates : [];
        const deletes = Array.isArray(body.deletes) ? body.deletes.map(Number) : [];
        if (!updates.length && !deletes.length) return res.status(400).json({ error: 'No changes to save.' });
        if (updates.length + deletes.length > MAX_CHANGES) return res.status(400).json({ error: `Too many changes at once (max ${MAX_CHANGES}).` });

        const ids = [], cats = [], vals = [], bys = [];
        for (const u of updates) {
          const id = Number(u?.id), categoryId = Number(u?.categoryId);
          const value = Math.round(Number(u?.value) * 100) / 100;
          const by = String(u?.submittedBy ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
          if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid entry.' });
          if (!Number.isInteger(categoryId) || categoryId < 1) return res.status(400).json({ error: 'Please select a category.' });
          if (!Number.isFinite(value) || value <= 0 || value > 1e10) return res.status(400).json({ error: 'Value must be a number greater than 0.' });
          if (!by) return res.status(400).json({ error: 'Submitted By cannot be empty.' });
          if (by.length > 60) return res.status(400).json({ error: 'Submitted By is too long (max 60 characters).' });
          ids.push(id); cats.push(categoryId); vals.push(value); bys.push(by);
        }
        if (deletes.some((d) => !Number.isInteger(d) || d < 1)) return res.status(400).json({ error: 'Invalid entry.' });
        if (new Set([...ids, ...deletes]).size !== ids.length + deletes.length) {
          return res.status(400).json({ error: 'An entry cannot be both edited and deleted.' });
        }
        if (cats.length) {
          const found = await sql`select id from categories where id = any(${[...new Set(cats)]}::int[])`;
          if (found.length !== new Set(cats).size) return res.status(400).json({ error: 'Unknown category.' });
        }

        // One SQL statement = one transaction: all edits and deletes apply together or not at all.
        const out = await sql`
          with upd as (
            update entries e
               set category_id = u.category_id, value = u.value, submitted_by = u.submitted_by, edited_at = now()
              from unnest(${ids}::bigint[], ${cats}::int[], ${vals}::numeric[], ${bys}::text[])
                   as u(id, category_id, value, submitted_by)
             where e.id = u.id
            returning e.id
          ), del as (
            delete from entries where id = any(${deletes}::bigint[]) returning id
          )
          select (select count(*) from upd)::int as updated, (select count(*) from del)::int as deleted`;
        return res.status(200).json({
          ok: true,
          updated: out[0].updated,
          deleted: out[0].deleted,
          missing: ids.length + deletes.length - out[0].updated - out[0].deleted, // already removed by someone else
        });
      }

      default:
        return res.status(400).json({ error: 'Unknown action.' });
    }
  } catch (err) {
    console.error('admin error', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
