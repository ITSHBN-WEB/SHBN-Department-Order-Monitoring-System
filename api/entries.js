import { getSql } from '../lib/db.js';
import { loadSettings, currentCycle, todayKL } from '../lib/cycle.js';

const fmtDMY = (s) => s.split('-').reverse().join('/');

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
  const submittedBy = String(body.submittedBy ?? '').trim().replace(/\s+/g, ' ');

  if (!Number.isInteger(categoryId) || categoryId < 1) return res.status(400).json({ error: 'Please select a category.' });
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Value must be a number greater than 0.' });
  if (value > 1e10) return res.status(400).json({ error: 'Value is too large.' });
  if (!submittedBy) return res.status(400).json({ error: 'Please enter Submitted By.' });
  if (submittedBy.length > 60) return res.status(400).json({ error: 'Submitted By is too long (max 60 characters).' });

  try {
    const sql = getSql();
    const settings = await loadSettings(sql);
    const today = todayKL();
    const { started, current } = currentCycle(settings, today);
    if (!started) {
      return res.status(400).json({ error: `Tracking begins on ${fmtDMY(settings.start)}. New entries open then.` });
    }

    const cat = await sql`select id, name, department, limit_value::float8 as "limit" from categories where id = ${categoryId}`;
    if (!cat.length) return res.status(400).json({ error: 'Unknown category.' });

    const ins = await sql`
      insert into entries (category_id, value, submitted_by, entry_date, cycle_no)
      values (${categoryId}, ${value}, ${submittedBy}, ${today}, ${current})
      returning id`;

    const tot = await sql`
      select coalesce(sum(value), 0)::float8 as received
      from entries where category_id = ${categoryId} and cycle_no = ${current}`;
    const received = tot[0].received;

    return res.status(201).json({
      ok: true,
      id: ins[0].id,
      category: cat[0].name,
      department: cat[0].department,
      cycle: current,
      received,
      limit: cat[0].limit,
      overLimit: received > cat[0].limit,
    });
  } catch (err) {
    console.error('entries error', err);
    return res.status(500).json({ error: 'Could not save the entry. Please try again.' });
  }
}
