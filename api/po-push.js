import { getSql, ensureSchema } from '../lib/db.js';
import { accountForToken, cleanPush } from '../lib/po.js';

/**
 * Called by the "Push to DOMS" bookmark from the portal page (another website), so it is token-based, not cookie-based:
 *   GET  ?k=TOKEN&po=PONO  -> category list + "already recorded?" check, shown in the popup before sending
 *   POST (text/plain JSON { k, po:{...}, poCategoryId, brand, remark }) -> saves the PO as PENDING (the budget is NOT touched; it is added later when the PO is saved in a PO Summary Report)
 * text/plain keeps it a "simple" request, so the browser sends no pre-check (preflight) that portals often block.
 * The token (hash stored in push_tokens) is the only credential; it belongs to one account.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  body = body && typeof body === 'object' ? body : {};

  try {
    const sql = getSql();
    await ensureSchema(sql);
    const acct = await accountForToken(sql, req.method === 'GET' ? req.query?.k : body.k);
    if (!acct) return res.status(401).json({ error: 'This bookmark is not valid any more. Open PO Entry in DOMS and create the bookmark again.', code: 'token' });

    const existing = async (poNo) => (await sql`
      select p.po_no, c.name as category, p.brand, (extract(epoch from p.pushed_at) * 1000)::float8 as ts
      from purchase_orders p join po_categories c on c.id = p.po_category_id
      where p.account = ${acct} and p.po_no = ${poNo}`)[0] || null;

    if (req.method === 'GET') {
      const po = String(req.query?.po ?? '').trim().slice(0, 40);
      const cats = await sql`select id, name, report from po_categories order by sort_order, id`;
      return res.status(200).json({ ok: true, account: acct, categories: cats.map((c) => ({ id: Number(c.id), name: c.name, report: c.report })), duplicate: po ? await existing(po) : null });
    }

    const parsed = cleanPush(body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;

    const dupReply = async () => {
      const d = await existing(v.poNo);
      return res.status(409).json({ error: `PO ${v.poNo} is already recorded.`, code: 'duplicate', duplicate: d });
    };
    if (await existing(v.poNo)) return dupReply();

    let row;
    try {
      // not exists + the unique (account, po_no) index: the same PO can never be stored twice, even when pushed twice at once
      const ins = await sql`
        insert into purchase_orders (account, po_no, reference, supplier, date_received, date_verified, amount, po_category_id, brand, remark)
        select ${acct}, ${v.poNo}, ${v.reference}, ${v.supplier}, ${v.dateReceived}::date, ${v.dateVerified}::date, ${v.amount}, pc.id, ${v.brand}, ${v.remark}
        from po_categories pc
        where pc.id = ${v.pcId} and not exists (select 1 from purchase_orders where account = ${acct} and po_no = ${v.poNo})
        returning id`;
      row = ins[0];
    } catch (err) {
      if (err && (err.code === '23505' || /duplicate key/i.test(err.message || ''))) return dupReply();
      throw err;
    }
    if (!row) {
      const known = await sql`select name from po_categories where id = ${v.pcId}`;
      if (!known.length) return res.status(400).json({ error: 'Unknown category.' });
      return dupReply();
    }
    const cat = (await sql`select name, report from po_categories where id = ${v.pcId}`)[0];
    return res.status(201).json({ ok: true, id: Number(row.id), poNo: v.poNo, category: cat.name, report: cat.report });
  } catch (err) {
    console.error('po-push error', err);
    return res.status(500).json({ error: 'Could not save the PO. Please try again.' });
  }
}
