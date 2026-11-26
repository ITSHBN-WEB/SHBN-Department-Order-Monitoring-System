import { getSql, ensureSchema } from '../lib/db.js';
import { requireAccount } from '../lib/auth.js';
import { loadSettings, currentCycle, todayKL } from '../lib/cycle.js';
import { PO_ACCOUNTS, OUTLET_NAME, REPORTS, hashToken, newToken, nextDeviceName } from '../lib/po.js';

/**
 * PO Entry / PO Summary Report / Submitted Summary Report data for the signed-in account (test run: PO_ACCOUNTS only).
 * A pushed PO is PENDING: it does not touch the budget. It is added to the budget only when the user saves it in a summary report.
 *   GET  ?view=list                       all pushed POs (pending + submitted), newest first, plus whether a bookmark exists
 *   GET  ?view=pending                    pending POs for the three printable reports (preview)
 *   GET  ?view=submitted&from=&to=        saved reports (with their POs) saved between two dates (Kuala Lumpur calendar)
 *   POST { action: 'token', id? }         add a computer (default name SHBN1, SHBN2, ...) and give it a new bookmark token; with id: replace that computer's token
 *   POST { action: 'device_rename', id, name }  rename a computer
 *   POST { action: 'device_delete', id }  remove a computer (its bookmark stops working)
 *   POST { action: 'submit', report, ids }  save the chosen pending POs of one report: adds each PO amount to its category budget
 *   POST { action: 'discard', id }        remove a pending PO (e.g. pushed by mistake) so it can be pushed again
 *   POST { action: 'po_edit', id, supplier, poCategoryId, brand, remark, dateVerified, dateReceived, amount }  edit a pending PO
 *   POST { action: 'report_save', reportId, updates:[{id,...}], deletes:[poId] }  edit / remove POs of a saved report (budget entries follow)
 *   POST { action: 'report_delete', reportId }  delete a saved report together with its POs and their budget entries
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


    const cleanFields = (u, okCats) => {
      const supplier = String(u?.supplier ?? '').trim().slice(0, 200);
      const amount = Number(String(u?.amount ?? '').replace(/,/g, ''));
      const pc = Number(u?.poCategoryId);
      const day = (v) => { const t = String(v ?? '').slice(0, 10); return ISO.test(t) ? t : ''; };
      if (!supplier) return { error: 'Supplier name cannot be empty.' };
      if (!(amount > 0 && amount <= 1e10)) return { error: 'PO amount must be a number above 0.' };
      if (!okCats.has(pc)) return { error: 'Please choose a valid category.' };
      return { supplier: supplier.toUpperCase(), amount: Math.round(amount * 100) / 100, pc, brand: String(u.brand ?? '').trim().slice(0, 100).toUpperCase(), remark: String(u.remark ?? '').trim().slice(0, 300).toUpperCase(), dv: day(u.dateVerified), dr: day(u.dateReceived) };
    };
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Unknown action.' });

      if (body.action === 'token') {
        const token = newToken();
        if (body.id !== undefined && body.id !== null) {
          const id = Number(body.id);
          const up = Number.isInteger(id) ? await sql`update push_devices set token_hash = ${hashToken(token)}, created_at = now(), last_used_at = null where id = ${id} and account = ${acct} returning id, name` : [];
          if (!up.length) return res.status(404).json({ error: 'This computer was removed. Add it again.', code: 'gone' });
          return res.status(200).json({ ok: true, token, device: { id: Number(up[0].id), name: up[0].name } });
        }
        // first free name; two computers adding at the same moment: the unique name index makes one retry with the next name
        for (let attempt = 0; attempt < 5; attempt++) {
          const taken = (await sql`select name from push_devices where account = ${acct}`).map((x) => x.name);
          const name = nextDeviceName(acct, taken);
          try {
            const ins = await sql`insert into push_devices (account, name, token_hash) values (${acct}, ${name}, ${hashToken(token)}) returning id, name`;
            return res.status(200).json({ ok: true, token, device: { id: Number(ins[0].id), name: ins[0].name } });
          } catch (err) { if (!(err && (err.code === '23505' || /duplicate key|unique/i.test(err.message || '')))) throw err; }
        }
        return res.status(409).json({ error: 'Could not add this computer. Please try again.' });
      }

      if (body.action === 'device_rename') {
        const id = Number(body.id), name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 30).toUpperCase();
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Unknown computer.' });
        if (!name) return res.status(400).json({ error: 'Please enter a name.' });
        try {
          const up = await sql`update push_devices set name = ${name} where id = ${id} and account = ${acct} returning id`;
          if (!up.length) return res.status(404).json({ error: 'This computer was removed.', code: 'gone' });
        } catch (err) {
          if (err && (err.code === '23505' || /duplicate key|unique/i.test(err.message || ''))) return res.status(409).json({ error: `The name ${name} is already used by another computer.` });
          throw err;
        }
        return res.status(200).json({ ok: true, name });
      }

      if (body.action === 'device_delete') {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Unknown computer.' });
        const del = await sql`delete from push_devices where id = ${id} and account = ${acct} returning id`;
        if (!del.length) return res.status(404).json({ error: 'This computer was already removed.', code: 'gone' });
        return res.status(200).json({ ok: true });
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

      if (body.action === 'po_edit') {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Unknown PO.' });
        const okCats = new Set((await sql`select id from po_categories`).map((c) => Number(c.id)));
        const f = cleanFields(body, okCats);
        if (f.error) return res.status(400).json({ error: f.error });
        const upd = await sql`
          update purchase_orders set supplier = ${f.supplier}, po_category_id = ${f.pc}, brand = ${f.brand}, remark = ${f.remark},
                 date_verified = nullif(${f.dv}, '')::date, date_received = nullif(${f.dr}, '')::date, amount = ${f.amount}
          where id = ${id} and account = ${acct} and report_id is null returning id`;
        if (!upd.length) return res.status(409).json({ error: 'This PO is already saved in a report (edit it in Submitted Summary Report), or no longer exists.', code: 'gone' });
        return res.status(200).json({ ok: true });
      }

      if (body.action === 'report_delete') {
        const rid = Number(body.reportId);
        if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ error: 'Unknown report.' });
        const mine = await sql`select 1 from po_reports where id = ${rid} and account = ${acct}`;
        if (!mine.length) return res.status(404).json({ error: 'This report no longer exists.', code: 'gone' });
        // deleting a budget entry also removes its PO (foreign key cascade), so the budget goes down by exactly what the report added
        const ents = await sql`
          delete from entries e using purchase_orders p
          where p.report_id = ${rid} and p.account = ${acct} and e.id = p.entry_id and e.account = ${acct}
          returning e.id`;
        await sql`delete from purchase_orders where report_id = ${rid} and account = ${acct}`;
        await sql`delete from po_reports where id = ${rid} and account = ${acct}`;
        return res.status(200).json({ ok: true, removed: ents.length });
      }

      if (body.action === 'report_save') {
        const rid = Number(body.reportId);
        if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ error: 'Unknown report.' });
        const rep = (await sql`select report from po_reports where id = ${rid} and account = ${acct}`)[0];
        if (!rep) return res.status(404).json({ error: 'This report no longer exists.', code: 'gone' });
        const dels = [...new Set((Array.isArray(body.deletes) ? body.deletes : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
        const okCats = new Set((await sql`select id from po_categories where report = ${rep.report}`).map((c) => Number(c.id)));
        const ups = [];
        for (const u of Array.isArray(body.updates) ? body.updates.slice(0, 500) : []) {
          const id = Number(u?.id);
          if (!Number.isInteger(id) || id <= 0 || dels.includes(id)) continue;
          const supplier = String(u.supplier ?? '').trim().slice(0, 200);
          const amount = Number(String(u.amount ?? '').replace(/,/g, ''));
          const pc = Number(u.poCategoryId);
          const day = (v) => { const t = String(v ?? '').slice(0, 10); return ISO.test(t) ? t : ''; };
          if (!supplier) return res.status(400).json({ error: 'Supplier name cannot be empty.' });
          if (!(amount > 0 && amount <= 1e10)) return res.status(400).json({ error: 'PO amount must be a number above 0.' });
          if (!okCats.has(pc)) return res.status(400).json({ error: 'Category does not belong to this report.' });
          ups.push({ id, supplier: supplier.toUpperCase(), amount: Math.round(amount * 100) / 100, pc, brand: String(u.brand ?? '').trim().slice(0, 100).toUpperCase(), remark: String(u.remark ?? '').trim().slice(0, 300).toUpperCase(), dv: day(u.dateVerified), dr: day(u.dateReceived) });
        }
        // One statement = all or nothing: PO fields, the matching budget entries, and removals.
        const out = await sql`
          with tgt as (select p.id, p.entry_id from purchase_orders p where p.report_id = ${rid} and p.account = ${acct}),
          u as (
            select * from unnest(${ups.map((x) => x.id)}::bigint[], ${ups.map((x) => x.supplier)}::text[], ${ups.map((x) => x.pc)}::int[], ${ups.map((x) => x.brand)}::text[],
                                 ${ups.map((x) => x.remark)}::text[], ${ups.map((x) => x.dv)}::text[], ${ups.map((x) => x.dr)}::text[], ${ups.map((x) => x.amount)}::numeric[])
              as t(id, supplier, pc, brand, remark, dv, dr, amount)
            where id in (select id from tgt)
          ),
          upd as (
            update purchase_orders p set supplier = u.supplier, po_category_id = u.pc, brand = u.brand, remark = u.remark,
                   date_verified = nullif(u.dv, '')::date, date_received = nullif(u.dr, '')::date, amount = u.amount
            from u where p.id = u.id returning p.id, p.entry_id, u.amount, u.pc
          ),
          ent as (
            update entries e set value = upd.amount, category_id = pc.category_id
            from upd join po_categories pc on pc.id = upd.pc where e.id = upd.entry_id returning e.id
          ),
          del as (
            delete from entries e where e.id in (select entry_id from tgt where id = any(${dels}::bigint[])) returning e.id
          )
          select (select count(*) from upd)::int as updated, (select count(*) from del)::int as deleted, (select count(*) from ent)::int as e`;
        // a report with no POs left is removed as well
        const left = await sql`select 1 from purchase_orders where report_id = ${rid}`;
        if (!left.length) await sql`delete from po_reports where id = ${rid} and account = ${acct}`;
        return res.status(200).json({ ok: true, updated: out[0].updated, deleted: out[0].deleted, reportGone: !left.length });
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
        select r.id, r.report, r.report_date::text as "date", (extract(epoch from r.saved_at) * 1000)::float8 as ts, r.cycle_no as cycle,
               count(p.id)::int as count, sum(p.amount)::float8 as total
        from po_reports r join purchase_orders p on p.report_id = r.id
        where r.account = ${acct} and (r.saved_at at time zone 'Asia/Kuala_Lumpur')::date between ${from}::date and ${to}::date
        group by r.id order by r.id desc limit 200`;
      const ids = reps.map((r) => Number(r.id));
      const rows = ids.length ? await sql`
        select p.id, p.po_no as "poNo", p.supplier, p.date_received::text as "dateReceived", p.date_verified::text as "dateVerified",
               p.amount::float8 as amount, c.name as category, c.report, c.sort_order as "sort", p.brand, p.remark, p.report_id as "reportId", p.po_category_id as "pcId"
        from purchase_orders p join po_categories c on c.id = p.po_category_id
        where p.account = ${acct} and p.report_id = any(${ids}::bigint[])
        order by c.sort_order, p.id` : [];
      return res.status(200).json({
        today, from, to, outlet: OUTLET_NAME[acct] || acct, reports: await attnMap(),
        categories: (await sql`select id, name, report from po_categories order by sort_order, id`).map((c) => ({ id: Number(c.id), name: c.name, report: c.report })),
        saved: reps.map((r) => ({ ...r, id: Number(r.id) })),
        rows: rows.map((r) => ({ ...r, id: Number(r.id), reportId: Number(r.reportId), pcId: Number(r.pcId) })),
      });
    }

    const listRows = await sql`
        select p.id, p.po_no as "poNo", p.reference, p.supplier, p.date_received::text as "dateReceived", p.date_verified::text as "dateVerified",
               p.amount::float8 as amount, c.name as category, c.report, p.brand, p.remark,
               (extract(epoch from p.pushed_at) * 1000)::float8 as ts, p.report_id as "reportId", p.po_category_id as "pcId"
        from purchase_orders p join po_categories c on c.id = p.po_category_id
        where p.account = ${acct} order by p.id desc limit 300`;
    const devs = await sql`select id, name, (extract(epoch from created_at) * 1000)::float8 as created, (extract(epoch from last_used_at) * 1000)::float8 as "lastUsed" from push_devices where account = ${acct} order by id`;
    const rows = listRows;
    return res.status(200).json({ account: acct, devices: devs.map((x) => ({ ...x, id: Number(x.id) })), categories: (await sql`select id, name, report from po_categories order by sort_order, id`).map((c) => ({ id: Number(c.id), name: c.name, report: c.report })), rows: rows.map((r) => ({ ...r, id: Number(r.id), reportId: r.reportId == null ? null : Number(r.reportId) })) });
  } catch (err) {
    console.error('po error', err);
    return res.status(500).json({ error: 'Could not load PO data.' });
  }
}
