import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Test run: only this account can use Push to DOMS / PO Entry / PO Summary Report. */
export const PO_ACCOUNTS = ['1008-SHBN'];
export const OUTLET_NAME = { '1008-SHBN': 'SEGSHBN' };

/** The three printed summary reports, in the order they are shown. */
export const REPORTS = [
  { code: 'FOOD', title: 'FOOD DEPT' },
  { code: 'FROZEN/RTD', title: 'FROZEN/RTD DEPT' },
  { code: 'NONFOOD', title: 'NONFOOD DEPT' },
];

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const newToken = () => randomBytes(24).toString('base64url');

/** Which account does this bookmark token belong to? (null when unknown or not allowed to use Push to DOMS) */
export async function accountForToken(sql, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const rows = await sql`select account, token_hash from push_tokens where token_hash = ${hashToken(token)}`;
  if (!rows.length) return null;
  const a = Buffer.from(rows[0].token_hash), b = Buffer.from(hashToken(token));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return PO_ACCOUNTS.includes(rows[0].account) ? rows[0].account : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** 'YYYY-MM-DD' (or '...T..' / 'DD/MM/YYYY') -> 'YYYY-MM-DD', else null. */
export function toIsoDate(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  let out = null;
  if (m) out = m[1];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s))) out = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!out || !ISO.test(out)) return null;
  const d = new Date(out + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out ? null : out;
}

/** Validate what the bookmark sends. Returns { error } or { value }. */
export function cleanPush(body) {
  const po = body && typeof body.po === 'object' && body.po ? body.po : {};
  const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const poNo = str(po.po_no, 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{2,39}$/.test(poNo)) return { error: 'The PO No could not be read from the portal page.' };
  const supplier = str(po.supplier, 120);
  if (!supplier) return { error: 'The supplier name could not be read from the portal page.' };
  const amount = Math.round(Number(String(po.amount ?? '').replace(/,/g, '')) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'The Grand Total could not be read (or is not above 0).' };
  if (amount > 1e10) return { error: 'The Grand Total is too large.' };
  const pcId = Number(body.poCategoryId);
  if (!Number.isInteger(pcId) || pcId < 1) return { error: 'Please select a category.' };
  return {
    value: {
      poNo, supplier, amount, pcId,
      reference: str(po.reference, 80),
      dateReceived: toIsoDate(po.date_received),
      dateVerified: toIsoDate(po.date_verified),
      brand: str(body.brand, 60).toUpperCase(),
      remark: str(body.remark, 120).toUpperCase(),
    },
  };
}
