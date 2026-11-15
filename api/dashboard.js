import { getSql, ensureSchema } from '../lib/db.js';
import { requireAccount, isCentral, CENTRAL } from '../lib/auth.js';
import { loadSettings, currentCycle, describeCycle, todayKL } from '../lib/cycle.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sql = getSql();
    await ensureSchema(sql);
    const acct = await requireAccount(req, res, sql);
    if (!acct) return;
    // Branch accounts see only their own data. Central Admin sees all branch accounts combined, or one chosen account.
    const central = isCentral(acct);
    const order = ['1008-SHBN', '1007-SHPP', '1015-SHPL'];     // show accounts in the same order everywhere
    const rank = (c) => (order.includes(c) ? order.indexOf(c) : 99);
    const branches = central ? (await sql`select code from accounts where code <> ${CENTRAL}`).map((r) => r.code).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)) : [acct];
    const wanted = String(req.query?.account ?? '').toUpperCase();
    const viewAccount = central && branches.includes(wanted) ? wanted : central ? 'ALL' : acct;
    const accts = central && viewAccount !== 'ALL' ? [viewAccount] : branches;
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
             (select coalesce(sum(coalesce(al.limit_value, c.limit_value)), 0)
                from unnest(${accts}::text[]) as a(code)
                left join account_limits al on al.category_id = c.id and al.account = a.code)::float8 as "limit",
             coalesce(sum(e.value) filter (where e.cycle_no = ${view}::int), 0)::float8 as received,
             coalesce(sum(e.value) filter (where e.cycle_no = ${current}::int), 0)::float8 as "receivedCurrent",
             (count(e.id) filter (where e.cycle_no = ${view}::int))::int as entries
      from categories c
      left join entries e
        on e.category_id = c.id and e.cycle_no in (${view}::int, ${current}::int) and e.account = any(${accts}::text[])
      group by c.id
      order by c.sort_order, c.id`;

    // Combined view for Central Admin: keep each account's own limit and total side by side (never added together).
    if (central && viewAccount === 'ALL') {
      const per = await sql`
        select c.id as category_id, a.code as account,
               coalesce(al.limit_value, c.limit_value)::float8 as "limit",
               coalesce(sum(e.value) filter (where e.cycle_no = ${view}::int), 0)::float8 as received
        from categories c
        cross join unnest(${accts}::text[]) as a(code)
        left join account_limits al on al.category_id = c.id and al.account = a.code
        left join entries e on e.category_id = c.id and e.account = a.code
        group by c.id, a.code, al.limit_value`;
      const byCat = new Map();
      for (const r of per) {
        const k = Number(r.category_id);
        if (!byCat.has(k)) byCat.set(k, []);
        byCat.get(k).push({ account: r.account, limit: r.limit, received: r.received });
      }
      for (const c of categories) c.accounts = (byCat.get(Number(c.id)) || []).sort((x, y) => rank(x.account) - rank(y.account));
    }

    // Entries are an append-only ledger ordered by id, so "running" is the category total
    // immediately after that entry — the same answer no matter how requests interleaved.
    const recent = await sql`
      select * from (
        select e.id, e.account, c.name as category, c.department,
               e.value::float8 as value, e.submitted_by as "submittedBy", e.cycle_no as cycle,
               (extract(epoch from e.created_at) * 1000)::float8 as ts,
               (sum(e.value) over (partition by e.account, e.category_id, e.cycle_no order by e.id))::float8 as running,
               coalesce(al.limit_value, c.limit_value)::float8 as "limit"
        from entries e join categories c on c.id = e.category_id
        left join account_limits al on al.category_id = e.category_id and al.account = e.account
        where e.account = any(${accts}::text[])
      ) t
      order by id desc
      limit 15`;

    return res.status(200).json({
      account: acct,
      central,
      viewAccount,
      branches: central ? branches : undefined,
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
