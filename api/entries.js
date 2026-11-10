import { getSql, ensureSchema } from '../lib/db.js';
import { loadSettings, currentCycle, todayKL } from '../lib/cycle.js';

const fmtDMY = (s) => s.split('-').reverse().join('/');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Multi-user safety:
 *  - Entries are append-only INSERTs, so two people submitting at the same moment can never
 *    overwrite each other (there is no "read total, add, write total" step to race on).
 *  - Totals are always summed from the entries table, never stored.
 *  - The over-limit result is the category total as of THIS entry (ordered by id), so it is
 *    consistent with Recent Activity even if other entries land at the same instant.
 *  - A client-generated requestId (unique index in the DB) makes retries / double-clicks /
 *    flaky-network resubmits safe: the same request can only ever be saved once.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  body = body || {};

  const categoryId = Number(body.categoryId);
  const value = Math.round(Number(body.value) * 100) / 100;
  const submittedBy = String(body.submittedBy ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  const requestId = typeof body.requestId === 'string' && UUID.test(body.requestId) ? body.requestId.toLowerCase() : null;

  if (!Number.isInteger(categoryId) || categoryId < 1) return res.status(400).json({ error: 'Please select a category.' });
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Value must be a number greater than 0.' });
  if (value > 1e10) return res.status(400).json({ error: 'Value is too large.' });
  if (!submittedBy) return res.status(400).json({ error: 'Please enter Submitted By.' });
  if (submittedBy.length > 60) return res.status(400).json({ error: 'Submitted By is too long (max 60 characters).' });

  try {
    const sql = getSql();
    await ensureSchema(sql);
    const settings = await loadSettings(sql);
    const today = todayKL();
    const { started, current, opensOn } = currentCycle(settings, today);
    if (!started) {
      return res.status(400).json({ error: `Entries open on ${fmtDMY(opensOn)}.` });
    }

    const cat = await sql`select id, name, department, limit_value::float8 as "limit" from categories where id = ${categoryId}`;
    if (!cat.length) return res.status(400).json({ error: 'Unknown category.' });

    let duplicate = false;
    let id, cycle;
    const ins = await sql`
      insert into entries (category_id, value, submitted_by, entry_date, cycle_no, request_id)
      values (${categoryId}, ${value}, ${submittedBy}, ${today}, ${current}, ${requestId}::uuid)
      on conflict (request_id) do nothing
      returning id, cycle_no`;
    if (ins.length) {
      ({ id, cycle_no: cycle } = ins[0]);
    } else {
      // Same requestId already saved (double-click / retry): report the original entry.
      const prev = await sql`select id, cycle_no from entries where request_id = ${requestId}::uuid`;
      if (!prev.length) return res.status(500).json({ error: 'Could not save the entry. Please try again.' });
      ({ id, cycle_no: cycle } = prev[0]);
      duplicate = true;
    }

    // Category total as of this entry (ids only ever increase).
    const tot = await sql`
      select coalesce(sum(value), 0)::float8 as received
      from entries where category_id = ${categoryId} and cycle_no = ${cycle} and id <= ${id}`;
    const received = tot[0].received;

    return res.status(duplicate ? 200 : 201).json({
      ok: true,
      duplicate,
      id,
      category: cat[0].name,
      department: cat[0].department,
      cycle,
      received,
      limit: cat[0].limit,
      overLimit: received > cat[0].limit,
    });
  } catch (err) {
    console.error('entries error', err);
    return res.status(500).json({ error: 'Could not save the entry. Please try again.' });
  }
}
