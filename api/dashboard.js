import { getSql, ensureSchema } from '../lib/db.js';
import { loadSettings, currentCycle, describeCycle, todayKL } from '../lib/cycle.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sql = getSql();
    await ensureSchema(sql);
    const settings = await loadSettings(sql);
    const today = todayKL();
    const { phase, started, current, opensOn, daysUntilStart } = currentCycle(settings, today);

    // Which cycle is being viewed? 0 = Test Cycle, 1+ = live cycles.
    // Default: today's cycle (cycle 1 is previewed while nothing is open yet).
    const maxLive = Math.max(phase === 'live' ? current : 0, 1);
    let view = req.query?.cycle === undefined ? NaN : parseInt(req.query.cycle, 10);
    const valid = Number.isInteger(view) && view <= maxLive && (view >= 1 || (view === 0 && settings.test));
    if (!valid) view = phase === 'test' ? 0 : phase === 'live' ? current : 1;

    // received = viewed cycle, receivedCurrent = the cycle entries are going into right now
    const categories = await sql`
      select c.id, c.department, c.name,
             c.limit_value::float8 as "limit",
             coalesce(sum(e.value) filter (where e.cycle_no = ${view}::int), 0)::float8 as received,
             coalesce(sum(e.value) filter (where e.cycle_no = ${current}::int), 0)::float8 as "receivedCurrent",
             (count(e.id) filter (where e.cycle_no = ${view}::int))::int as entries
      from categories c
      left join entries e
        on e.category_id = c.id and e.cycle_no in (${view}::int, ${current}::int)
      group by c.id
      order by c.sort_order, c.id`;

    // Entries are an append-only ledger ordered by id, so "running" is the category total
    // immediately after that entry — the same answer no matter how requests interleaved.
    const recent = await sql`
      select * from (
        select e.id, c.name as category, c.department,
               e.value::float8 as value, e.submitted_by as "submittedBy", e.cycle_no as cycle,
               (extract(epoch from e.created_at) * 1000)::float8 as ts,
               (sum(e.value) over (partition by e.category_id, e.cycle_no order by e.id))::float8 as running,
               c.limit_value::float8 as "limit"
        from entries e join categories c on c.id = e.category_id
      ) t
      order by id desc
      limit 15`;

    return res.status(200).json({
      today,
      phase,
      started,
      opensOn,
      daysUntilStart,
      currentCycle: current,
      currentInfo: current === null ? null : describeCycle(settings, current, today),
      trackingStart: settings.start,
      testPeriod: settings.test,
      cycle: describeCycle(settings, view, today),
      categories,
      recent: recent.map((r) => ({ ...r, overLimit: r.running > r.limit })),
    });
  } catch (err) {
    console.error('dashboard error', err);
    return res.status(500).json({ error: 'Could not load dashboard data.' });
  }
}
