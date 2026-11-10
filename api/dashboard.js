import { getSql } from '../lib/db.js';
import { loadSettings, currentCycle, describeCycle, todayKL } from '../lib/cycle.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sql = getSql();
    const settings = await loadSettings(sql);
    const today = todayKL();
    const { started, current, daysUntilStart } = currentCycle(settings, today);

    // Which cycle is being viewed? Default = current (or cycle 1 before tracking starts).
    const maxView = Math.max(current, 1);
    let view = parseInt(req.query?.cycle, 10);
    if (!Number.isInteger(view) || view < 1 || view > maxView) view = maxView;

    // received = viewed cycle, receivedCurrent = live cycle (used by the New Entry form hint)
    const categories = await sql`
      select c.id, c.department, c.name,
             c.limit_value::float8 as "limit",
             coalesce(sum(e.value) filter (where e.cycle_no = ${view}), 0)::float8 as received,
             coalesce(sum(e.value) filter (where e.cycle_no = ${current}), 0)::float8 as "receivedCurrent",
             (count(e.id) filter (where e.cycle_no = ${view}))::int as entries
      from categories c
      left join entries e
        on e.category_id = c.id and e.cycle_no in (${view}, ${current})
      group by c.id
      order by c.sort_order, c.id`;

    const recent = await sql`
      select * from (
        select e.id, c.name as category, c.department,
               e.value::float8 as value, e.submitted_by as "submittedBy", e.cycle_no as cycle,
               (extract(epoch from e.created_at) * 1000)::float8 as ts,
               (sum(e.value) over (partition by e.category_id, e.cycle_no order by e.created_at, e.id))::float8 as running,
               c.limit_value::float8 as "limit"
        from entries e join categories c on c.id = e.category_id
      ) t
      order by ts desc, id desc
      limit 15`;

    return res.status(200).json({
      today,
      started,
      daysUntilStart,
      currentCycle: current,
      trackingStart: settings.start,
      cycle: describeCycle(settings, view, today),
      categories,
      recent: recent.map((r) => ({ ...r, overLimit: r.running > r.limit })),
    });
  } catch (err) {
    console.error('dashboard error', err);
    return res.status(500).json({ error: 'Could not load dashboard data.' });
  }
}
