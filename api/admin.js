import { getSql, ensureSchema } from '../lib/db.js';
import { requireAccount, isCentral, CENTRAL } from '../lib/auth.js';
import { loadSettings, currentCycle, describeCycle, todayKL } from '../lib/cycle.js';

/**
 * Record Adjustments API (edit / delete submitted entries). One endpoint, POST only:
 *   { action: 'meta' | 'list' | 'save' | 'activity', ... }
 * Only the signed-in Central Admin account may use it (checked here on the server, from the signed session):
 * it can edit or delete entries of ALL accounts. Every edit / delete is written to the `adjustments` log.
 */
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

  try {
    const sql = getSql();
    await ensureSchema(sql);
    const acct = await requireAccount(req, res, sql);
    if (!acct) return;

    if (!isCentral(acct)) return res.status(403).json({ error: 'Only Central Admin can adjust records.', code: 'forbidden' });
    const scope = 'hq', hq = true;

    switch (body.action) {
      case 'activity': {
        const rows = await sql`
          select id, (extract(epoch from at) * 1000)::float8 as ts, action, account, cycle_no as cycle,
                 category, department, value::float8 as value, submitted_by as "submittedBy",
                 new_category as "newCategory", new_value::float8 as "newValue", new_submitted_by as "newSubmittedBy"
          from adjustments order by id desc limit 30`;
        return res.status(200).json({ activity: rows.map((r) => ({ ...r, id: Number(r.id) })) });
      }

      case 'meta': {
        const settings = await loadSettings(sql);
        const today = todayKL();
        const { phase, current } = currentCycle(settings, today);
        const only = null;
        const counts = Object.fromEntries(
          (await sql`select cycle_no, count(*)::int as n from entries
                     where (${only}::text is null or account = ${only}::text) group by cycle_no`).map((r) => [r.cycle_no, r.n]),
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
        const accounts = (await sql`select code from accounts where code <> ${CENTRAL} order by code`).map((r) => r.code);
        return res.status(200).json({ scope, account: acct, accounts, cycles, categories, defaultCycle });
      }

      case 'list': {
        const cycle = Number(body.cycle);
        if (!Number.isInteger(cycle) || cycle < 0) return res.status(400).json({ error: 'Choose a period.' });
        const dept = typeof body.department === 'string' && body.department ? body.department : null;
        const catId = body.categoryId ? Number(body.categoryId) : null;
        const only = typeof body.account === 'string' && body.account ? body.account : null;
        if (catId !== null && !Number.isInteger(catId)) return res.status(400).json({ error: 'Invalid category.' });

        const rows = await sql`
          select e.id, e.account, e.category_id as "categoryId", c.name as category, c.department,
                 e.value::float8 as value, e.submitted_by as "submittedBy", e.cycle_no as cycle,
                 (extract(epoch from e.created_at) * 1000)::float8 as ts,
                 (extract(epoch from e.edited_at) * 1000)::float8 as "editedAt"
          from entries e join categories c on c.id = e.category_id
          where e.cycle_no = ${cycle}::int
            and (${dept}::text is null or c.department = ${dept}::text)
            and (${catId}::int is null or e.category_id = ${catId}::int)
            and (${only}::text is null or e.account = ${only}::text)
          order by e.id desc
          limit ${MAX_ROWS + 1}`;
        // bigint ids arrive as text from Neon; the page compares them strictly, so send real numbers
        const entries = rows.slice(0, MAX_ROWS).map((r) => ({ ...r, id: Number(r.id) }));
        return res.status(200).json({ entries, truncated: rows.length > MAX_ROWS });
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
        const touched = [...ids, ...deletes];
        const out = await sql`
          with old as (
            select e.id, e.account, e.cycle_no, e.value, e.submitted_by, c.name as category, c.department
            from entries e join categories c on c.id = e.category_id
            where e.id = any(${touched}::bigint[])
          ), upd as (
            update entries e
               set category_id = u.category_id, value = u.value, submitted_by = u.submitted_by, edited_at = now()
              from unnest(${ids}::bigint[], ${cats}::int[], ${vals}::numeric[], ${bys}::text[])
                   as u(id, category_id, value, submitted_by)
             where e.id = u.id and (${hq}::boolean or e.account = ${acct}::text)
            returning e.id
          ), del as (
            delete from entries where id = any(${deletes}::bigint[]) and (${hq}::boolean or account = ${acct}::text) returning id
          ), po_sync as (
            update purchase_orders p set amount = u.value
            from unnest(${ids}::bigint[], ${vals}::numeric[]) as u(id, value)
            where p.entry_id = u.id and u.id in (select id from upd) and u.value > 0
            returning p.id
          ), log_edit as (
            insert into adjustments (by_account, action, entry_id, account, cycle_no, category, department, value, submitted_by, new_category, new_value, new_submitted_by)
            select ${acct}, 'edit', o.id, o.account, o.cycle_no, o.category, o.department, o.value, o.submitted_by, nc.name, u.value, u.submitted_by
            from old o
            join unnest(${ids}::bigint[], ${cats}::int[], ${vals}::numeric[], ${bys}::text[]) as u(id, category_id, value, submitted_by) on u.id = o.id
            join categories nc on nc.id = u.category_id
            where o.id in (select id from upd)
            returning id
          ), log_del as (
            insert into adjustments (by_account, action, entry_id, account, cycle_no, category, department, value, submitted_by)
            select ${acct}, 'delete', o.id, o.account, o.cycle_no, o.category, o.department, o.value, o.submitted_by
            from old o where o.id in (select id from del)
            returning id
          )
          select (select count(*) from upd)::int as updated, (select count(*) from del)::int as deleted,
                 (select count(*) from log_edit)::int + (select count(*) from log_del)::int as logged`;
        return res.status(200).json({
          ok: true,
          updated: out[0].updated,
          deleted: out[0].deleted,
          missing: ids.length + deletes.length - out[0].updated - out[0].deleted, // already removed, or not in your scope
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
