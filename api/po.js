import { getSql, ensureSchema } from '../lib/db.js';
import { requireAccount } from '../lib/auth.js';
import { loadSettings, currentCycle, todayKL } from '../lib/cycle.js';
import { PO_ACCOUNTS, OUTLET_NAME, REPORTS, hashToken, newToken } from '../lib/po.js';

/**
 * PO Entry / PO Summary Report / Submitted Summary Report data for the signed-in account (test run: PO_ACCOUNTS only).
 * A pushed PO is PENDING: it does not touch the budget. It is added to the budget only when the user saves it in a summary report.
 *   GET  ?view=list                       all pushed POs (pending + submitted), newest first, plus whether a bookmark exists
 *   GET  ?view=pending                    pending POs for the three printable reports (preview)
 *   GET  ?view=submitted&from=&to=        saved reports (with their POs) saved between two dates (Kuala Lumpur calendar)
 *   POST { action: 'token' }              create (or replace) this account's Push to DOMS bookmark token
 *   POST { action: 'submit', report, ids }  save the chosen pending POs of one report: adds each PO amount to its category budget
 *   POST { action: 'discard', id }        remove a pending PO (e.g. pushed by mistake) so it can be pushed again
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = getSql();
    await ensureSchema(sql);
    const acct = await requireAccount(req, res, sql);
    if (!acct) return;
    if (!PO_ACCOUNTS.includes(acct)) return res.status(403).json({ error: 'Push to DOMS is not enabled for this account.', code: 'forbidden' });

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Unknown action.' });

      if (body.action === 'token') {
        const token = newToken();
        await sql`
          insert into push_tokens (account, token_hash) values (${acct}, ${hashToken(token)})
          on conflict (account) do update set token_hash = excluded.token_hash, created_at = now()`;
        return res.status(200).json({ ok: true, token });
      }

      if (body.action === 'discard') {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Unknown PO.' });
        const del = await sql`delete from purchase_orders where id = ${id} and account = ${acct} and report_id is null returning id`;
        if (!del.length) return res.status(409).json({ error: 'This PO is already saved in a report, or no longer exists.', code: 'gone' });
        return res.status(200).json({ ok: true });
      }

      if (body.action === 'submit') {
        const report = String(body.report || '');
        if (!REPORTS.some((r) => r.code === report)) return res.status(400).json({ error: 'Unknown report.' });
        const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
        if (!ids.length) return res.status(400).json({ error: 'Select at least one PO.' });
        const settings = await loadSettings(sql);
        const today = todayKL();
        const { started, current, opensOn } = currentCycle(settings, today);
        if (!started) return res.status(400).json({ error: `Entries open on ${String(opensOn).split('-').reverse().join('/')}.` });
        // One statement = all or nothing. It locks the chosen pending POs, creates the report, adds one budget entry per PO and links them.
        // Two people saving the same PO at once: the second finds it already taken (report_id no longer null) and saves nothing.
        const out = await sql`
          with sel as (
            select p.id as pid, p.amount, p.po_no, pc.category_id,
                   nextval(pg_get_serial_sequence('entries', 'id')) as eid
            from purchase_orders p join po_categories pc on pc.id = p.po_category_id
            where p.account = ${acct} and p.report_id is null and pc.report = ${report} and p.id = any(${ids}::bigint[])
            for update of p
          ),
          rep as (
            insert into po_reports (account, report, report_date, cycle_no, po_count, total)
            select ${acct}, ${report}, ${today}::date, ${current}, count(*), sum(amount) from sel having count(*) > 0
            returning id
          ),
          ent as (
            insert into entries (id, account, category_id, value, submitted_by, entry_date, cycle_no)
            select eid, ${acct}, category_id, amount, upper('PO ' || po_no), ${today}::date, ${current} from sel
            where exists (select 1 from rep)
            returning id
          ),
          upd as (
            update purchase_orders p set report_id = (select id from rep), entry_id = sel.eid, cycle_no = ${current}
            from sel where p.id = sel.pid and exists (select 1 from rep)
            returning p.id
          )
          select (select id from rep) as report_id, (select count(*) from upd)::int as n, (select count(*) from ent)::int as e`;
        const o = out[0];
        if (!o || !o.report_id) return res.status(409).json({ error: 'None of the selected POs can be saved: they were already saved or removed. Reload the page.', code: 'gone' });
        const over = await sql`
          select c.name as category, coalesce(al.limit_value, c.limit_value)::float8 as "limit",
                 (select coalesce(sum(e.value), 0)::float8 from entries e where e.account = ${acct} and e.category_id = c.id and e.cycle_no = ${current}) as received
          from categories c left join account_limits al on al.category_id = c.id and al.account = ${acct}
          where c.id in (select pc.category_id from purchase_orders p join po_categories pc on pc.id = p.po_category_id where p.report_id = ${o.report_id})
          order by c.name`;
        return res.status(200).json({
          ok: true, reportId: Number(o.report_id), saved: o.n, date: today, cycle: current,
          categories: over.map((x) => ({ category: x.category, limit: x.limit, received: x.received, over: x.received > x.limit })),
        });
      }
      return res.status(400).json({ error: 'Unknown action.' });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const attnMap = async () => {
      const attn = await sql`select report, min(attn) as attn from po_categories group by report`;
      const m = Object.fromEntries(attn.map((a) => [a.report, a.attn]));
      return REPORTS.map((r) => ({ ...r, attn: m[r.code] || '' }));
    };
    const ISO_DAY = (v, d) => (ISO.test(v || '') ? v : d);

    if (req.query?.view === 'pending') {
      const rows = await sql`
        select p.id, p.po_no as "poNo", p.supplier, p.date_received::text as "dateReceived", p.date_verified::text as "dateVerified",
               p.amount::float8 as amount, c.name as category, c.report, c.sort_order as "sort", p.brand, p.remark, (extract(epoch from p.pushed_at) * 1000)::float8 as ts
        from purchase_orders p join po_categories c on c.id = p.po_category_id
        where p.account = ${acct} and p.report_id is null
        order by c.sort_order, p.id`;
      return res.status(200).json({ today: todayKL(), outlet: OUTLET_NAME[acct] || acct, reports: await attnMap(), rows: rows.map((r) => ({ ...r, id: Number(r.id) })) });
    }

    if (req.query?.view === 'submitted') {
      const today = todayKL();
      const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 30);
      const from = ISO_DAY(req.query.from, d.toISOString().slice(0, 10));
      const to = ISO_DAY(req.query.to, today);
      const reps = await sql`
        select r.id, r.report, r.report_date::text as "date", (extract(epoch from r.saved_at) * 1000)::float8 as ts, r.cycle_no as cycle, r.po_count as count, r.total::float8 as total
        from po_reports r
        where r.account = ${acct} and (r.saved_at at time zone 'Asia/Kuala_Lumpur')::date between ${from}::date and ${to}::date
        order by r.id desc limit 200`;
      const ids = reps.map((r) => Number(r.id));
      const rows = ids.length ? await sql`
        select p.id, p.po_no as "poNo", p.supplier, p.date_received::text as "dateReceived", p.date_verified::text as "dateVerified",
               p.amount::float8 as amount, c.name as category, c.report, c.sort_order as "sort", p.brand, p.remark, p.report_id as "reportId"
        from purchase_orders p join po_categories c on c.id = p.po_category_id
        where p.account = ${acct} and p.report_id = any(${ids}::bigint[])
        order by c.sort_order, p.id` : [];
      return res.status(200).json({
        today, from, to, outlet: OUTLET_NAME[acct] || acct, reports: await attnMap(),
        saved: reps.map((r) => ({ ...r, id: Number(r.id) })),
        rows: rows.map((r) => ({ ...r, id: Number(r.id), reportId: Number(r.reportId) })),
      });
    }

    const listRows = await sql`
        select p.id, p.po_no as "poNo", p.reference, p.supplier, p.date_received::text as "dateReceived", p.date_verified::text as "dateVerified",
               p.amount::float8 as amount, c.name as category, c.report, p.brand, p.remark,
               (extract(epoch from p.pushed_at) * 1000)::float8 as ts, p.report_id as "reportId"
        from purchase_orders p join po_categories c on c.id = p.po_category_id
        where p.account = ${acct} order by p.id desc limit 300`;
    const has = await sql`select 1 from push_tokens where account = ${acct}`;
    const rows = listRows;
    return res.status(200).json({ account: acct, hasToken: has.length > 0, rows: rows.map((r) => ({ ...r, id: Number(r.id), reportId: r.reportId == null ? null : Number(r.reportId) })) });
  } catch (err) {
    console.error('po error', err);
    return res.status(500).json({ error: 'Could not load PO data.' });
  }
}
