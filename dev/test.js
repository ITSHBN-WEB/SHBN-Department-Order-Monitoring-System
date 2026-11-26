// npm test — exercises the API handlers against an in-memory Postgres.
import assert from 'node:assert/strict';
import { createLocalDb } from './pg.js';
import { currentCycle, describeCycle } from '../lib/cycle.js';
import { ensureSchema } from '../lib/db.js';
import { hashPassword, signSession } from '../lib/auth.js';
import { LIMITS } from '../lib/seed.js';
import { hashToken } from '../lib/po.js';

const sql = await createLocalDb();
const { default: dashboard } = await import('../api/dashboard.js');
const { default: entries } = await import('../api/entries.js');

// By default every call is made as a signed-in 1008-SHBN; pass { as: 'CODE' } or { as: null } (no session) to change that.
const cookieFor = (code) => `doms_session=${signSession(code)}`;
const call = (handler, { method = 'GET', query = {}, body, as = '1008-SHBN', cookie } = {}) =>
  new Promise((resolve) => {
    const res = {
      headers: {}, code: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(o) { resolve({ code: this.code, body: o, headers: this.headers }); },
      end() { resolve({ code: this.code, body: null, headers: this.headers }); },
    };
    handler({ method, query, body, headers: { cookie: cookie ?? (as ? cookieFor(as) : '') } }, res);
  });

// Test-only passwords (the real ones are never in the repo; the seeded hashes are checked by hand).

// Malaysia date (UTC+8) to match the app's own clock; plain UTC differs between 00:00 and 08:00 KL.
const iso = (offsetDays) => new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
const setStart = (d) => sql`update settings set value = ${d} where key = 'tracking_start'`;
const catId = async (name) => (await sql`select id from categories where name = ${name}`)[0].id;

// --- pure cycle maths ---------------------------------------------------
const s = { start: '2026-11-15', days: 45, test: { start: '2026-09-30', end: '2026-11-14' } };
const none = { ...s, test: null };
assert.deepEqual(currentCycle(none, '2026-11-14'), { phase: 'upcoming', started: false, current: null, opensOn: '2026-11-15', daysUntilStart: 1 });
assert.equal(currentCycle(s, '2026-09-29').phase, 'upcoming');
assert.equal(currentCycle(s, '2026-09-29').opensOn, '2026-09-30');
assert.equal(currentCycle(s, '2026-09-30').phase, 'test');
assert.equal(currentCycle(s, '2026-11-14').current, 0);
assert.equal(currentCycle(s, '2026-11-15').phase, 'live');
assert.equal(currentCycle(s, '2026-11-15').current, 1);
assert.equal(currentCycle(s, '2026-12-29').current, 1);  // day 45
assert.equal(currentCycle(s, '2026-12-30').current, 2);  // day 46 -> next cycle
assert.equal(describeCycle(s, 1, '2026-11-15').end, '2026-12-29');
assert.equal(describeCycle(s, 2, '2026-12-30').start, '2026-12-30');
assert.equal(describeCycle(s, 1, '2026-11-15').dayNumber, 1);
assert.equal(describeCycle(s, 1, '2026-12-29').daysLeft, 0);
const tc = describeCycle(s, 0, '2026-11-10');
assert.deepEqual([tc.start, tc.end, tc.days, tc.status, tc.dayNumber], ['2026-09-30', '2026-11-14', 46, 'active', 42]);
assert.equal(describeCycle(s, 0, '2026-11-15').status, 'closed');

// --- seed data ------------------------------------------------------------
const cats = await sql`select count(*)::int n, sum(limit_value)::float8 total from categories`;
assert.equal(cats[0].n, 31);
assert.equal(cats[0].total, 2217415);
const st = Object.fromEntries((await sql`select key, value from settings`).map((r) => [r.key, r.value]));
assert.equal(st.tracking_start, '2026-11-01');
assert.equal(st.test_start, '2026-10-01');
assert.equal(st.test_end, '2026-10-30');

const rice = await catId('RICE'); // limit 178,126
const post = (body) => call(entries, { method: 'POST', body: { categoryId: rice, submittedBy: 'Tester', ...body } });
const noTest = () => sql`delete from settings where key in ('test_start','test_end')`;
const setTest = (a, b) => sql`insert into settings (key, value) values ('test_start', ${a}), ('test_end', ${b})
  on conflict (key) do update set value = excluded.value`;

// --- older database (no request_id column, no test settings) is upgraded automatically ---
await sql.raw('alter table entries drop column request_id');
await sql`delete from settings where key in ('test_start','test_end')`;
await ensureSchema(sql, true);
assert.equal((await sql`select value from settings where key = 'test_start'`)[0].value, '2026-10-01');

// --- one-time move from the old dates to the new ones (existing deployments) -----------------
await sql`update settings set value = '2026-11-15' where key = 'tracking_start'`;
await sql`update settings set value = '2026-09-30' where key = 'test_start'`;
await sql`update settings set value = '2026-11-14' where key = 'test_end'`;
await sql`delete from settings where key = 'dates_v2'`;
await ensureSchema(sql, true);
const mig = Object.fromEntries((await sql`select key, value from settings`).map((r) => [r.key, r.value]));
assert.deepEqual([mig.tracking_start, mig.test_start, mig.test_end, mig.dates_v2], ['2026-11-01', '2026-10-01', '2026-10-30', '1']);
// ...and never again: a date changed later by hand survives the next start-up
await sql`update settings set value = '2027-01-01' where key = 'tracking_start'`;
await ensureSchema(sql, true);
assert.equal((await sql`select value from settings where key = 'tracking_start'`)[0].value, '2027-01-01');
await sql`update settings set value = '2026-11-01' where key = 'tracking_start'`;
assert.equal((await sql`select count(*)::int n from information_schema.columns where table_name = 'entries' and column_name = 'request_id'`)[0].n, 1);

// --- Test Cycle window active today ---------------------------------
await setStart(iso(5));
await setTest(iso(-10), iso(4));
let r = await call(dashboard);
assert.equal(r.body.phase, 'test');
assert.equal(r.body.cycle.n, 0);
assert.equal(r.body.currentCycle, 0);
assert.equal(r.body.cycle.status, 'active');
r = await post({ value: 150000 });
assert.equal(r.code, 201);
assert.equal(r.body.cycle, 0);                       // stored as the Test Cycle
r = await call(dashboard);
assert.equal(r.body.categories.find((c) => c.name === 'RICE').received, 150000);
assert.equal(r.body.recent[0].cycle, 0);
r = await call(dashboard, { query: { cycle: '1' } }); // live cycle 1 is untouched by test data
assert.equal(r.body.cycle.n, 1);
assert.equal(r.body.cycle.status, 'upcoming');
assert.equal(r.body.categories.find((c) => c.name === 'RICE').received, 0);
assert.equal(r.body.categories.find((c) => c.name === 'RICE').receivedCurrent, 150000);

// --- before anything opens ------------------------------------------------------
await setStart(iso(5));
await setTest(iso(2), iso(4));
r = await call(dashboard);
assert.equal(r.body.phase, 'upcoming');
assert.equal(r.body.daysUntilStart, 2);
assert.equal(r.body.opensOn, iso(2));
r = await post({ value: 100 });
assert.equal(r.code, 400);
assert.match(r.body.error, /Entries open on/);
await noTest();
r = await call(dashboard, { query: { cycle: '0' } });
assert.equal(r.body.cycle.n, 1);                      // no test configured -> cycle 0 not viewable

// --- active live cycle -----------------------------------------------------------
await setStart(iso(-3));
r = await post({ value: '100000', submittedBy: '  Ali   Baba ' });
assert.equal(r.code, 201);
assert.equal(r.body.cycle, 1);
assert.equal(r.body.overLimit, false);
r = await post({ value: 78126.5, submittedBy: 'Siti' });
assert.equal(r.body.received, 178126.5);
assert.equal(r.body.overLimit, true);                // 0.50 over the limit

for (const bad of [
  { value: 0 }, { value: -5 }, { value: 'abc' }, { value: 10, submittedBy: '   ' },
  { value: 10, categoryId: 99999 }, { value: 10, categoryId: undefined },
]) assert.equal((await post(bad)).code, 400, JSON.stringify(bad));

r = await call(dashboard);
assert.equal(r.body.phase, 'live');
assert.equal(r.body.cycle.dayNumber, 4);
const riceRow = r.body.categories.find((c) => c.name === 'RICE');
assert.equal(riceRow.received, 178126.5);
assert.equal(riceRow.department, 'FOOD');
assert.equal(r.body.recent.length, 3);               // 2 live entries + the earlier Test Cycle entry
assert.equal(r.body.recent[2].cycle, 0);
assert.equal(r.body.recent[0].overLimit, true);
assert.equal(r.body.recent[1].overLimit, false);
assert.equal(r.body.recent[1].submittedBy, 'ALI BABA');   // Submitted By is stored in capitals

// --- simultaneous submissions ------------------------------------------------------
const uuid = () => crypto.randomUUID();
const before = (await sql`select count(*)::int n from entries`)[0].n;
// 25 different users at once -> all saved, exact total, no lost updates
const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => post({ value: 10, submittedBy: 'User' + i, requestId: uuid() })));
assert.ok(burst.every((x) => x.code === 201));
assert.equal((await sql`select count(*)::int n from entries`)[0].n, before + 25);
assert.equal(new Set(burst.map((x) => x.body.id)).size, 25);
assert.equal(Math.max(...burst.map((x) => x.body.received)), 178126.5 + 250);
// the same request sent 6 times at once (double-click / retry) -> saved exactly once
const rid = uuid();
const dup = await Promise.all(Array.from({ length: 6 }, () => post({ value: 77, submittedBy: 'Dup', requestId: rid })));
assert.ok(dup.every((x) => x.code === 200 || x.code === 201));
assert.equal(dup.filter((x) => x.body.duplicate === false).length, 1);
assert.equal(new Set(dup.map((x) => x.body.id)).size, 1);
assert.equal((await sql`select count(*)::int n from entries where request_id = ${rid}::uuid`)[0].n, 1);
// a bad requestId is ignored (still saves once, not deduplicated)
assert.equal((await post({ value: 1, requestId: 'not-a-uuid' })).code, 201);

// --- cycle rollover: totals reset, old cycle still viewable ---------------------------
await setStart(iso(-46));
r = await call(dashboard);
assert.equal(r.body.currentCycle, 2);
assert.equal(r.body.categories.find((c) => c.name === 'RICE').received, 0);
r = await post({ value: 500, submittedBy: 'Zul' });
assert.equal(r.body.cycle, 2);
assert.equal(r.body.received, 500);
r = await call(dashboard, { query: { cycle: '1' } });
assert.equal(r.body.cycle.status, 'closed');
assert.equal(r.body.categories.find((c) => c.name === 'RICE').receivedCurrent, 500);
r = await call(dashboard, { query: { cycle: '99' } });
assert.equal(r.body.cycle.n, 2);

// --- Admin API ----------------------------------------------------------------------------
const { default: admin } = await import('../api/admin.js');
const adm = (body, as = 'CENTRAL-ADMIN') => call(admin, { method: 'POST', as, body });      // Record Adjustments: Central Admin only, no extra password
assert.equal((await call(admin, { method: 'POST', as: null, body: { action: 'list', cycle: 2 } })).code, 401);   // not signed in
assert.equal((await call(admin, { method: 'GET' })).code, 405);
assert.equal((await adm({ action: 'list', cycle: 2 }, '1008-SHBN')).code, 403);                                 // a branch account is refused

r = await adm({ action: 'meta' });
assert.deepEqual(r.body.cycles.map((c) => c.n), [0, 1, 2]);
assert.equal(r.body.defaultCycle, 2);
assert.equal(r.body.categories.length, 31);
assert.ok(r.body.cycles.find((c) => c.n === 1).count > 0);

const baby = await catId('BABY CARE'), pet = await catId('PET FOOD'), tob = await catId('TOBACCO / MAGAZINE & NEWSPAPER');
for (const [c, v, who] of [[baby, 100, 'a'], [baby, 200, 'b'], [pet, 300, 'c'], [tob, 400, 'd']]) {
  assert.equal((await call(entries, { method: 'POST', body: { categoryId: c, value: v, submittedBy: who } })).code, 201);
}
r = await adm({ action: 'list', cycle: 2 });
assert.equal(r.body.entries.length, 5);                                  // Zul's 500 + the four above
r = await adm({ action: 'list', cycle: 2, department: 'NONFOOD' });
assert.equal(r.body.entries.length, 4);
r = await adm({ action: 'list', cycle: 2, department: 'NONFOOD', categoryId: baby });
assert.deepEqual(r.body.entries.map((e) => e.value).sort(), [100, 200]);
assert.equal(r.body.entries[0].department, 'NONFOOD');
const [e1, e2] = r.body.entries;
assert.equal(typeof e1.id, 'number');   // the page compares ids with ===, so they must be numbers (Neon returns bigint as text)

// edit one (value + category + name), delete another, in a single save
r = await adm({ action: 'save', updates: [{ id: e1.id, categoryId: pet, value: '250.456', submittedBy: ' new  name ' }], deletes: [e2.id] });
assert.deepEqual([r.code, r.body.updated, r.body.deleted, r.body.missing], [200, 1, 1, 0]);
r = await adm({ action: 'list', cycle: 2, categoryId: pet });
const edited = r.body.entries.find((e) => e.id === e1.id);
assert.deepEqual([edited.value, edited.submittedBy, edited.category, edited.department], [250.46, 'NEW NAME', 'PET FOOD', 'NONFOOD']);
assert.ok(edited.editedAt > 0);
assert.equal((await adm({ action: 'list', cycle: 2, categoryId: baby })).body.entries.length, 0);
r = await call(dashboard);                                              // dashboard totals follow the edit
assert.equal(r.body.categories.find((c) => c.name === 'PET FOOD').received, 300 + 250.46);
// deleting an already-deleted entry is reported, not an error
r = await adm({ action: 'save', deletes: [e2.id] });
assert.deepEqual([r.code, r.body.deleted, r.body.missing], [200, 0, 1]);
// validation: nothing is changed when any item is invalid
const bads = [
  { updates: [{ id: e1.id, categoryId: pet, value: 0, submittedBy: 'x' }] },
  { updates: [{ id: e1.id, categoryId: pet, value: 5, submittedBy: '  ' }] },
  { updates: [{ id: e1.id, categoryId: 99999, value: 5, submittedBy: 'x' }] },
  { updates: [{ id: e1.id, categoryId: pet, value: 5, submittedBy: 'x' }], deletes: [e1.id] },
  {},
];
for (const b of bads) assert.equal((await adm({ action: 'save', ...b })).code, 400, JSON.stringify(b));
r = await adm({ action: 'list', cycle: 2, categoryId: pet });
assert.equal(r.body.entries.find((e) => e.id === e1.id).value, 250.46);
// every edit / delete is logged with before and after values (the validation failures and the repeated delete above are not)
r = await adm({ action: 'activity' });
assert.equal(r.body.activity.length, 2);
{
  const ed = r.body.activity.find((a) => a.action === 'edit'), de = r.body.activity.find((a) => a.action === 'delete');
  assert.deepEqual([ed.category, ed.newCategory, ed.newValue, ed.newSubmittedBy, ed.department], ['BABY CARE', 'PET FOOD', 250.46, 'NEW NAME', 'NONFOOD']);
  assert.ok([100, 200].includes(ed.value) && ed.ts > 0);
  assert.deepEqual([de.category, de.newValue ?? null], ['BABY CARE', null]);
}

// --- Accounts: sign-in ----------------------------------------------------------------------
const { default: auth } = await import('../api/auth.js');
const seeded = await sql`select code, password_hash from accounts order by code`;
assert.deepEqual(seeded.map((a) => a.code), ['1007-SHPP', '1008-SHBN', '1015-SHPL', 'CENTRAL-ADMIN']);
assert.ok(seeded.every((a) => /^scrypt\$/.test(a.password_hash)));           // hashes only, never plain text
await sql`update accounts set password_hash = ${hashPassword('pw-bn')} where code = '1008-SHBN'`;
await sql`update accounts set password_hash = ${hashPassword('pw-pl')} where code = '1015-SHPL'`;
await sql`update accounts set password_hash = ${hashPassword('pw-pp')} where code = '1007-SHPP'`;
const login = (username, password) => call(auth, { method: 'POST', as: null, body: { action: 'login', username, password } });

assert.equal((await login('1008-SHBN', 'wrong')).code, 401);
assert.equal((await login('9999-NONE', 'pw-bn')).code, 401);
assert.equal((await login('1008-SHBN', '')).code, 401);
assert.equal((await login('1015-SHPL', 'pw-bn')).code, 401);                  // another account's password
r = await call(auth, { as: null, query: { accounts: '1' } });                    // sign-in dropdown list (public)
assert.deepEqual(r.body, { accounts: ['1007-SHPP', '1008-SHBN', '1015-SHPL', 'CENTRAL-ADMIN'] });
r = await login(' 1015-shpl ', 'pw-pl');                                       // trimmed + case-insensitive
assert.equal(r.code, 200);
assert.equal(r.body.account.code, '1015-SHPL');
assert.match(r.headers['Set-Cookie'], /^doms_session=.+HttpOnly.+SameSite=Strict/);
const cookiePL = r.headers['Set-Cookie'].split(';')[0];
assert.equal((await call(auth, { cookie: cookiePL })).body.account.code, '1015-SHPL');   // GET /api/auth = who am I
assert.equal((await call(auth, { as: null })).code, 401);
r = await call(auth, { method: 'POST', as: null, body: { action: 'logout' } });
assert.match(r.headers['Set-Cookie'], /Max-Age=0/);

// every data endpoint refuses visitors who are not signed in, or whose session is forged / expired / deleted
for (const bad of ['', 'doms_session=garbage', cookiePL.slice(0, -3) + 'xyz', `doms_session=${signSession('1008-SHBN', Date.now() - 13 * 3600e3)}`, `doms_session=${signSession('0000-GONE')}`]) {
  assert.equal((await call(dashboard, { cookie: bad, as: null })).code, 401, bad.slice(0, 40));
  assert.equal((await call(entries, { method: 'POST', cookie: bad, as: null, body: { categoryId: 1, value: 5, submittedBy: 'x' } })).code, 401);
  assert.equal((await call(admin, { method: 'POST', cookie: bad, as: null, body: { action: 'meta' } })).code, 401);
}
// tokens are bound to the signing key: a token for one account can't be edited into another
const forged = cookiePL.replace(/^doms_session=[^.]+/, 'doms_session=' + Buffer.from(JSON.stringify({ a: '1008-SHBN', e: 9999999999 })).toString('base64url'));
assert.equal((await call(dashboard, { cookie: forged, as: null })).code, 401);

// --- Accounts: data is fully separate -------------------------------------------------------
await setStart(iso(-3));                       // live cycle 1 for the next checks
await sql`delete from entries`;
const rice2 = await catId('RICE');
const asAcct = (code, body) => call(entries, { method: 'POST', as: code, body: { categoryId: rice2, submittedBy: 'T', ...body } });
assert.equal((await asAcct('1008-SHBN', { value: 1000 })).code, 201);
assert.equal((await asAcct('1015-SHPL', { value: 250 })).code, 201);
assert.equal((await asAcct('1015-SHPL', { value: 50 })).code, 201);
assert.equal((await asAcct('1007-SHPP', { value: 7 })).code, 201);
const riceOf = async (code) => (await call(dashboard, { as: code })).body.categories.find((c) => c.name === 'RICE');
assert.equal((await riceOf('1008-SHBN')).received, 1000);
assert.equal((await riceOf('1015-SHPL')).received, 300);
assert.equal((await riceOf('1007-SHPP')).received, 7);
assert.equal((await call(dashboard, { as: '1015-SHPL' })).body.recent.length, 2);              // only its own activity
assert.equal((await call(dashboard, { as: '1015-SHPL' })).body.account, '1015-SHPL');
// the "over limit" result is judged on the account's own total, not the sum across accounts
const riceLimit = (code) => LIMITS.find((l) => l[0] === code && l[2] === 'RICE')[3];
assert.notEqual(riceLimit('1007-SHPP'), riceLimit('1008-SHBN'));                // accounts really have different limits
r = await asAcct('1007-SHPP', { value: riceLimit('1007-SHPP') - 7 });          // 7 + (limit - 7) = exactly its own limit
assert.deepEqual([r.body.received, r.body.limit, r.body.overLimit], [riceLimit('1007-SHPP'), riceLimit('1007-SHPP'), false]);
assert.equal((await asAcct('1007-SHPP', { value: 1 })).body.overLimit, true);   // 1 over ITS limit
assert.equal((await asAcct('1008-SHBN', { value: 1 })).body.overLimit, false);  // 1008's own total is far below ITS limit
// a request id used by one account can't be replayed to read or hit another account's entry
const sharedRid = crypto.randomUUID();
const first = await asAcct('1008-SHBN', { value: 5, requestId: sharedRid });
assert.equal(first.code, 201);
const replay = await asAcct('1015-SHPL', { value: 5, requestId: sharedRid });
assert.notEqual(replay.code, 201);

// --- Limits are per account (from the three workbook sheets) ------------------------------------------------
const totals = Object.fromEntries((await sql`select account, sum(limit_value)::float8 t, count(*)::int n from account_limits group by account`).map((x) => [x.account, [x.t, x.n]]));
assert.deepEqual(totals, { '1008-SHBN': [2217415, 31], '1015-SHPL': [1376243, 31], '1007-SHPP': [1361166, 31] });
for (const code of ['1008-SHBN', '1015-SHPL', '1007-SHPP']) {
  const d = (await call(dashboard, { as: code })).body.categories;
  assert.equal(d.length, 31);
  assert.equal(d.reduce((a, c) => a + c.limit, 0), totals[code][0]);               // the dashboard shows THIS account's limits
  assert.equal(d.find((c) => c.name === 'RICE').limit, riceLimit(code));
  assert.equal((await call(dashboard, { as: code })).body.recent.every((x) => typeof x.limit === 'number'), true);
}
// the limit shown in Recent Activity / used for "Over limit" is the account's own too
const ppRecent = (await call(dashboard, { as: '1007-SHPP' })).body.recent;
assert.ok(ppRecent.every((x) => x.limit === riceLimit('1007-SHPP')) && ppRecent[0].overLimit === true);
// an account without its own limit row falls back to the default list instead of breaking
await sql`delete from account_limits where account = '1015-SHPL' and category_id = ${rice2}`;
assert.equal((await call(dashboard, { as: '1015-SHPL' })).body.categories.find((c) => c.name === 'RICE').limit, riceLimit('1008-SHBN'));
await sql`insert into account_limits (account, category_id, limit_value) values ('1015-SHPL', ${rice2}, ${riceLimit('1015-SHPL')})`;

// --- Record Adjustments: Central Admin only ------------------------------------------------------
const ids = Object.fromEntries((await sql`select account, min(id)::int as id from entries group by account`).map((x) => [x.account, x.id]));
const countBefore = (await sql`select count(*)::int n from entries`)[0].n;
for (const code of ['1015-SHPL', '1008-SHBN', '1007-SHPP']) {                    // branch accounts can do nothing here, whatever they ask for
  for (const action of ['meta', 'list', 'activity', 'save']) {
    r = await adm({ action, cycle: 1, deletes: [ids[code]], updates: [{ id: ids['1008-SHBN'], categoryId: rice2, value: 1, submittedBy: 'HACK' }] }, code);
    assert.equal(r.code, 403, `${code} ${action}`);
  }
}
assert.equal((await sql`select count(*)::int n from entries`)[0].n, countBefore);
assert.equal((await sql`select count(*)::int n from entries where submitted_by = 'HACK'`)[0].n, 0);

r = await adm({ action: 'meta' });
assert.deepEqual([r.body.scope, r.body.accounts], ['hq', ['1007-SHPP', '1008-SHBN', '1015-SHPL']]);   // Central Admin itself is not listed as a store
assert.equal(r.body.cycles.find((c) => c.n === 1).count, (await sql`select count(*)::int n from entries where cycle_no = 1`)[0].n);   // counts cover all accounts
r = await adm({ action: 'list', cycle: 1 });
assert.deepEqual([...new Set(r.body.entries.map((e) => e.account))].sort(), ['1007-SHPP', '1008-SHBN', '1015-SHPL']);
r = await adm({ action: 'list', cycle: 1, account: '1008-SHBN' });
assert.ok(r.body.entries.length > 0 && r.body.entries.every((e) => e.account === '1008-SHBN'));
// Central Admin edits and deletes entries belonging to other accounts
const logBefore = (await adm({ action: 'activity' })).body.activity.length;
r = await adm({ action: 'save', updates: [{ id: ids['1008-SHBN'], categoryId: rice2, value: 4321, submittedBy: 'hq fix' }], deletes: [ids['1007-SHPP']] });
assert.deepEqual([r.code, r.body.updated, r.body.deleted, r.body.missing], [200, 1, 1, 0]);
const fixed = (await sql`select value::float8 v, submitted_by s, account from entries where id = ${ids['1008-SHBN']}`)[0];
assert.deepEqual([fixed.v, fixed.s, fixed.account], [4321, 'HQ FIX', '1008-SHBN']);              // account itself is never changed
assert.equal((await riceOf('1008-SHBN')).received, 4321 + 1 + 5);
r = await adm({ action: 'activity' });
assert.equal(r.body.activity.length, logBefore + 2);
assert.ok(r.body.activity.some((a) => a.action === 'edit' && a.account === '1008-SHBN' && a.newValue === 4321 && a.newSubmittedBy === 'HQ FIX'));
assert.ok(r.body.activity.some((a) => a.action === 'delete' && a.account === '1007-SHPP'));
assert.ok(r.body.activity.every((a) => a.ts > 0));

// --- Central Admin: view-only account that sees every branch account -------------------------------------
{
  const CA = 'CENTRAL-ADMIN';
  r = await call(auth, { method: 'POST', as: null, body: { action: 'login', username: 'central-admin', password: '123456ADMIN' } });   // the real seeded password
  assert.deepEqual([r.code, r.body.account.code, r.body.account.central], [200, CA, true]);
  r = await call(auth, { method: 'POST', as: null, body: { action: 'login', username: CA, password: '123456' } });
  assert.equal(r.code, 401);
  r = await call(auth, { method: 'POST', as: null, body: { action: 'login', username: '1008-SHBN', password: 'pw-bn' } });
  assert.equal(r.body.account.central, false);
  assert.ok((await call(auth, { query: { accounts: '1' }, as: null })).body.accounts.includes(CA));    // appears in the sign-in dropdown

  // each branch submits into RICE, so the combined view has something from every account
  for (const code of ['1008-SHBN', '1015-SHPL', '1007-SHPP']) assert.equal((await asAcct(code, { value: 1000 })).code, 201);
  const own = {};
  for (const code of ['1008-SHBN', '1015-SHPL', '1007-SHPP']) own[code] = await riceOf(code);
  r = await call(dashboard, { as: CA });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.central, r.body.viewAccount, r.body.branches], [true, 'ALL', ['1008-SHBN', '1007-SHPP', '1015-SHPL']]);   // shown in this order
  const rice = r.body.categories.find((c) => c.name === 'RICE');
  assert.equal(rice.received, Object.values(own).reduce((a, x) => a + x.received, 0));            // totals of all three accounts
  assert.equal(rice.limit, ['1008-SHBN', '1015-SHPL', '1007-SHPP'].reduce((a, c) => a + riceLimit(c), 0));   // limits add up too
  assert.equal(r.body.categories.length, 31);
  // side by side: every category carries each account's OWN limit and total, in order
  assert.deepEqual(rice.accounts.map((x) => x.account), ['1008-SHBN', '1007-SHPP', '1015-SHPL']);
  for (const x of rice.accounts) assert.deepEqual([x.limit, x.received], [riceLimit(x.account), own[x.account].received]);
  assert.ok(r.body.categories.every((c) => c.accounts.length === 3));
  assert.equal((await call(dashboard, { as: CA, query: { account: '1015-SHPL' } })).body.categories[0].accounts, undefined);   // single-account view has no breakdown
  assert.equal((await call(dashboard, { as: '1008-SHBN' })).body.categories[0].accounts, undefined);
  assert.deepEqual([...new Set(r.body.recent.map((x) => x.account))].sort(), ['1007-SHPP', '1008-SHBN', '1015-SHPL']);
  for (const code of ['1008-SHBN', '1015-SHPL', '1007-SHPP']) {                                   // one account at a time matches that account's own dashboard
    const one = await call(dashboard, { as: CA, query: { account: code } });
    const mine = await call(dashboard, { as: code });
    assert.equal(one.body.viewAccount, code);
    assert.deepEqual(one.body.categories, mine.body.categories);
    assert.ok(one.body.recent.length > 0 && one.body.recent.every((x) => x.account === code));
  }
  assert.equal((await call(dashboard, { as: CA, query: { account: 'NOPE' } })).body.viewAccount, 'ALL');
  assert.equal((await call(dashboard, { as: '1015-SHPL', query: { account: '1008-SHBN' } })).body.recent.every((x) => x.account === '1015-SHPL'), true);   // branches can't borrow the filter

  // view-only: cannot submit
  r = await asAcct(CA, { value: 5 });
  assert.equal(r.code, 403);
}

// --- Push to DOMS: bookmark token, popup check, PO save, reports ----------------------------------------------------
{
  const { default: po } = await import('../api/po.js');
  const { default: poPush } = await import('../api/po-push.js');
  const { default: admin2 } = await import('../api/admin.js');
  const CA = 'CENTRAL-ADMIN';
  // the 32 PO categories from the workbook are loaded and each points at a real DOMS budget category
  const pcs = await sql`select p.id, p.name, p.report, p.attn, c.name as cat from po_categories p join categories c on c.id = p.category_id order by p.sort_order`;
  assert.equal(pcs.length, 32);
  assert.deepEqual([...new Set(pcs.map((x) => x.report))], ['FOOD', 'FROZEN/RTD', 'NONFOOD']);
  const rtd = pcs.find((x) => x.name === 'READY TO DRINKS'), bev = pcs.find((x) => x.name === 'BEVERAGES');
  assert.deepEqual([rtd.cat, rtd.report, rtd.attn, bev.cat, bev.report, bev.attn], ['BEVERAGES', 'FROZEN/RTD', 'MR SALLEH', 'BEVERAGES', 'FOOD', 'MS LIZA']);   // beverages counts once, prints on two reports

  // only 1008-SHBN may use it (test run)
  for (const code of ['1015-SHPL', '1007-SHPP', CA]) assert.equal((await call(po, { as: code })).code, 403, code);
  assert.equal((await call(po, { as: null })).code, 401);
  r = await call(po);
  assert.deepEqual([r.code, r.body.devices, r.body.rows.length], [200, [], 0]);
  r = await call(po, { method: 'POST', body: { action: 'token' } });
  assert.equal(r.code, 200);
  const token = r.body.token;
  assert.deepEqual([r.body.device.name], ['SHBN1']);                                      // default computer name
  assert.ok(token.length >= 30);
  assert.equal((await sql`select count(*)::int n from push_devices where token_hash = ${token}`)[0].n, 0);   // only a hash is stored
  assert.deepEqual((await call(po)).body.devices.map((x) => x.name), ['SHBN1']);
  assert.equal((await call(po, { method: 'POST', as: '1015-SHPL', body: { action: 'token' } })).code, 403);

  // the popup's pre-check: bad / missing token is refused, CORS lets the portal page read the answer, no cookie needed
  const push = (b, method = 'POST') => call(poPush, { method, as: null, body: typeof b === 'string' ? b : JSON.stringify(b) });
  const check = (po_no, k = token) => call(poPush, { as: null, query: { k, po: po_no } });
  assert.equal((await check('HQ01962198', 'x'.repeat(32))).code, 401);
  assert.equal((await call(poPush, { as: null, query: {} })).code, 401);
  assert.equal((await call(poPush, { method: 'OPTIONS', as: null })).code, 204);
  r = await check('HQ01962198');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  assert.deepEqual([r.code, r.body.categories.length, r.body.duplicate], [200, 32, null]);

  const PO = { po_no: 'HQ01962198', reference: 'SPO000002009598-LIFE', supplier: 'CHOON HUA BORNEO SDN. BHD.', date_received: '2026-11-10', date_verified: '2026-11-23T04:48:22.000', amount: '1,960.50' };
  const bevRecv = async (as = '1008-SHBN') => (await call(dashboard, { as })).body.categories.find((c) => c.name === 'BEVERAGES').received;
  const before = await bevRecv();
  // invalid input is refused and nothing is saved
  for (const bad of [{ ...PO, po_no: '' }, { ...PO, supplier: ' ' }, { ...PO, amount: '0' }, { ...PO, amount: 'abc' }]) {
    assert.equal((await push({ k: token, po: bad, poCategoryId: rtd.id })).code, 400, JSON.stringify(bad));
  }
  assert.equal((await push({ k: token, po: PO, poCategoryId: 99999 })).code, 400);
  assert.equal((await push({ k: token, po: PO })).code, 400);
  assert.equal((await push('not json')).code, 401);
  assert.equal((await sql`select count(*)::int n from purchase_orders`)[0].n, 0);

  // a good push is only PENDING: stored with the user's category / brand / remark, budget and recent activity untouched
  r = await push({ k: token, po: PO, poCategoryId: rtd.id, brand: 'life', remark: ' urgent ' });
  assert.deepEqual([r.code, r.body.poNo, r.body.category, r.body.report], [201, 'HQ01962198', 'READY TO DRINKS', 'FROZEN/RTD']);
  const saved = (await sql`select p.*, p.amount::float8 as amt from purchase_orders p where p.po_no = 'HQ01962198'`)[0];
  assert.deepEqual([saved.account, saved.amt, saved.brand, saved.remark, saved.reference, saved.supplier, saved.entry_id, saved.report_id], ['1008-SHBN', 1960.5, 'LIFE', 'URGENT', 'SPO000002009598-LIFE', 'CHOON HUA BORNEO SDN. BHD.', null, null]);
  assert.equal(await bevRecv(), before);
  assert.equal((await call(dashboard)).body.recent.some((x) => x.submittedBy === 'PO HQ01962198'), false);

  // the same PO again: blocked in the popup pre-check and on push
  r = await check('HQ01962198');
  assert.deepEqual([r.body.duplicate.po_no, r.body.duplicate.category, r.body.duplicate.brand, r.body.duplicate.ts > 0], ['HQ01962198', 'READY TO DRINKS', 'LIFE', true]);
  r = await push({ k: token, po: PO, poCategoryId: bev.id });
  assert.deepEqual([r.code, r.body.code, r.body.duplicate.category], [409, 'duplicate', 'READY TO DRINKS']);
  // ...even when two people push the same new PO at the same moment: exactly one wins
  const PO2 = { ...PO, po_no: 'HQ01964261', reference: 'SPO000002011712-REX', supplier: 'TRANS-BORNEO MARKETING SDN.BHD. (KK)', amount: '1230.00', date_received: '2026-12-11', date_verified: '2026-11-20T03:19:20.00' };
  const both = await Promise.all([push({ k: token, po: PO2, poCategoryId: bev.id }), push({ k: token, po: PO2, poCategoryId: bev.id })]);
  assert.deepEqual(both.map((x) => x.code).sort(), [201, 409]);
  assert.equal((await sql`select count(*)::int n from purchase_orders where po_no = 'HQ01964261'`)[0].n, 1);
  const pet = pcs.find((x) => x.name === 'PET FOOD'), rice = pcs.find((x) => x.name === 'RICE');
  assert.equal((await push({ k: token, po: { po_no: 'HQ01970000', supplier: 'HERH FUAH (S) SDN.BHD.', amount: 940, date_received: '2026-11-20' }, poCategoryId: pet.id, brand: 'MONAS' })).code, 201);   // no verified date is allowed
  assert.equal((await push({ k: token, po: { po_no: 'HQ01970001', supplier: 'X SDN BHD', amount: 500 }, poCategoryId: pet.id, brand: 'ABC' })).code, 201);
  assert.equal(await bevRecv(), before);                                                  // five pushes later the budget still has not moved

  // PO Entry list
  r = await call(po);
  assert.deepEqual(r.body.rows.map((x) => [x.poNo, x.reportId]), [['HQ01970001', null], ['HQ01970000', null], ['HQ01964261', null], ['HQ01962198', null]]);
  assert.deepEqual([r.body.rows[3].category, r.body.rows[3].report, r.body.rows[3].dateVerified, r.body.rows[3].dateReceived, r.body.rows[3].amount], ['READY TO DRINKS', 'FROZEN/RTD', '2026-11-23', '2026-11-10', 1960.5]);

  // PO Summary Report (preview of pending POs): grouped for the three reports, in the workbook's category order
  r = await call(po, { query: { view: 'pending' } });
  assert.deepEqual([r.body.outlet, r.body.reports.map((x) => [x.code, x.title, x.attn])], ['SEGSHBN', [['FOOD', 'FOOD DEPT', 'MS LIZA'], ['FROZEN/RTD', 'FROZEN/RTD DEPT', 'MR SALLEH'], ['NONFOOD', 'NONFOOD DEPT', 'MS MARLIN']]]);
  assert.deepEqual(r.body.rows.map((x) => [x.category, x.report, x.poNo]), [['BEVERAGES', 'FOOD', 'HQ01964261'], ['READY TO DRINKS', 'FROZEN/RTD', 'HQ01962198'], ['PET FOOD', 'NONFOOD', 'HQ01970000'], ['PET FOOD', 'NONFOOD', 'HQ01970001']]);
  assert.equal((await call(po, { as: '1015-SHPL', query: { view: 'pending' } })).code, 403);
  const idOf = Object.fromEntries(r.body.rows.map((x) => [x.poNo, x.id]));

  // edit a pending PO (any category, every field except PO No)
  const pend = (await call(po, { query: { view: 'pending' } })).body.rows.find((x) => x.poNo === 'HQ01964261');
  const pedit = (b, as = '1008-SHBN', id = pend.id) => call(po, { method: 'POST', as, body: { action: 'po_edit', id, supplier: pend.supplier, poCategoryId: bev.id, brand: pend.brand, remark: pend.remark, dateVerified: pend.dateVerified, dateReceived: pend.dateReceived, amount: pend.amount, ...b } });
  assert.equal((await pedit({ supplier: '' })).code, 400);
  assert.equal((await pedit({ amount: 'abc' })).code, 400);
  assert.equal((await pedit({ poCategoryId: 99999 })).code, 400);
  assert.equal((await pedit({}, '1015-SHPL')).code, 403);
  assert.equal((await pedit({ supplier: 'new supplier', poCategoryId: pet.id, brand: 'x', remark: '', amount: '1,300.50', dateVerified: '', dateReceived: '2026-12-01' })).code, 200);
  r = (await call(po)).body;
  assert.equal(r.categories.length, 32);
  const pe = r.rows.find((x) => x.poNo === 'HQ01964261');
  assert.deepEqual([pe.supplier, pe.category, pe.report, pe.brand, pe.amount, pe.dateVerified, pe.dateReceived, pe.pcId], ['NEW SUPPLIER', 'PET FOOD', 'NONFOOD', 'X', 1300.5, null, '2026-12-01', pet.id]);
  assert.equal((await pedit({ poCategoryId: bev.id, supplier: 'TRANS-BORNEO MARKETING SDN.BHD. (KK)', amount: 1230, dateVerified: '2026-11-20', brand: 'REX', remark: '', dateReceived: '2026-12-11' })).code, 200);   // put it back
  assert.equal(await bevRecv(), before);                                                  // pending edits never touch the budget

  // Save entry: validation
  const submit = (body, as = '1008-SHBN') => call(po, { method: 'POST', as, body: { action: 'submit', ...body } });
  assert.equal((await submit({ report: 'NOPE', ids: [idOf.HQ01964261] })).code, 400);
  assert.equal((await submit({ report: 'FOOD', ids: [] })).code, 400);
  assert.equal((await submit({ report: 'FOOD', ids: [idOf.HQ01962198] })).code, 409);     // a FROZEN/RTD PO cannot be saved into the FOOD report
  assert.equal((await submit({ report: 'FOOD', ids: [idOf.HQ01964261] }, '1015-SHPL')).code, 403);
  assert.equal(await bevRecv(), before);

  // Save entry for FROZEN/RTD (one PO) + NONFOOD (only one of two ticked): the budget changes only now
  r = await submit({ report: 'FROZEN/RTD', ids: [idOf.HQ01962198] });
  assert.deepEqual([r.code, r.body.saved, r.body.categories.map((c) => c.category)], [200, 1, ['BEVERAGES']]);
  assert.deepEqual([r.body.categories[0].before, r.body.categories[0].added, r.body.categories[0].received, r.body.categories[0].limit > 0], [before, 1960.5, before + 1960.5, true]);   // budget impact for the popup
  assert.equal(await bevRecv(), before + 1960.5);
  const rep1 = r.body.reportId;
  const row1 = (await sql`select p.report_id::int rid, p.entry_id, e.value::float8 ev, e.submitted_by eby, e.account eacct, e.cycle_no ec, c.name cn from purchase_orders p join entries e on e.id = p.entry_id join categories c on c.id = e.category_id where p.po_no = 'HQ01962198'`)[0];
  assert.deepEqual([row1.rid, row1.ev, row1.eby, row1.eacct, row1.cn], [rep1, 1960.5, 'PO HQ01962198', '1008-SHBN', 'BEVERAGES']);
  assert.equal((await call(dashboard)).body.recent[0].submittedBy, 'PO HQ01962198');
  assert.equal(await bevRecv('1015-SHPL'), 0);                                            // other accounts see nothing
  assert.equal((await pedit({}, '1008-SHBN', idOf.HQ01962198)).code, 409);                 // a saved PO is edited in its report, not here
  // saving the same PO twice (also two people at once) never doubles the budget
  assert.equal((await submit({ report: 'FROZEN/RTD', ids: [idOf.HQ01962198] })).code, 409);
  assert.equal(await bevRecv(), before + 1960.5);
  const pet0 = (await call(dashboard)).body.categories.find((c) => c.name === 'PET FOOD').received;
  const two = await Promise.all([submit({ report: 'NONFOOD', ids: [idOf.HQ01970000] }), submit({ report: 'NONFOOD', ids: [idOf.HQ01970000] })]);
  assert.deepEqual(two.map((x) => x.code).sort(), [200, 409]);
  assert.equal((await call(dashboard)).body.categories.find((c) => c.name === 'PET FOOD').received, pet0 + 940);
  assert.equal((await sql`select count(*)::int n from entries where submitted_by = 'PO HQ01970000'`)[0].n, 1);
  // the un-ticked PO stays pending; the saved ones leave the preview
  r = await call(po, { query: { view: 'pending' } });
  assert.deepEqual(r.body.rows.map((x) => x.poNo), ['HQ01964261', 'HQ01970001']);
  // a pending PO can be removed (pushed by mistake) and pushed again; a saved one cannot be removed
  const dis = (id) => call(po, { method: 'POST', body: { action: 'discard', id } });
  assert.equal((await dis(idOf.HQ01962198)).code, 409);
  assert.equal((await dis(idOf.HQ01970001)).code, 200);
  assert.equal((await push({ k: token, po: { po_no: 'HQ01970001', supplier: 'X SDN BHD', amount: 510 }, poCategoryId: pet.id })).code, 201);
  assert.equal((await call(po, { method: 'POST', as: '1015-SHPL', body: { action: 'discard', id: idOf.HQ01964261 } })).code, 403);

  // Submitted Summary Report: saved reports by date range and by report; PO list statuses
  r = await call(po, { query: { view: 'submitted' } });
  assert.deepEqual(r.body.saved.map((x) => [x.report, x.count, x.total, x.date === r.body.today]), [['NONFOOD', 1, 940, true], ['FROZEN/RTD', 1, 1960.5, true]]);
  assert.deepEqual(r.body.rows.map((x) => [x.reportId === r.body.saved[0].id, x.poNo]).sort().map((x) => x[1]), ['HQ01962198', 'HQ01970000']);
  assert.equal(r.body.from, r.body.today.slice(0, 8) + '01');                              // default range starts on the 1st of the month
  assert.equal((await call(po, { query: { view: 'submitted', from: '2020-01-01', to: '2020-01-02' } })).body.saved.length, 0);
  assert.equal((await call(po, { as: '1015-SHPL', query: { view: 'submitted' } })).code, 403);
  r = await call(po);
  assert.deepEqual(r.body.rows.map((x) => [x.poNo, x.reportId]), [['HQ01970001', null], ['HQ01964261', null]]);   // PO Entry shows pending POs only; saved ones are in the reports

  // Central Admin edits / deletes a saved budget entry: the PO follows (amount synced, PO removed on delete so it can be pushed again)
  const e1 = (await sql`select entry_id::int id from purchase_orders where po_no = 'HQ01962198'`)[0].id;
  const e2 = (await sql`select entry_id::int id from purchase_orders where po_no = 'HQ01970000'`)[0].id;
  const bevId = (await sql`select id from categories where name = 'BEVERAGES'`)[0].id;
  r = await call(admin2, { method: 'POST', as: CA, body: { action: 'save', updates: [{ id: e1, categoryId: bevId, value: 2000, submittedBy: 'PO HQ01962198' }], deletes: [e2] } });
  assert.deepEqual([r.code, r.body.updated, r.body.deleted], [200, 1, 1]);
  assert.equal((await sql`select amount::float8 a from purchase_orders where po_no = 'HQ01962198'`)[0].a, 2000);
  assert.equal((await sql`select count(*)::int n from purchase_orders where po_no = 'HQ01970000'`)[0].n, 0);
  assert.equal((await push({ k: token, po: { po_no: 'HQ01970000', supplier: 'HERH FUAH (S) SDN.BHD.', amount: 940 }, poCategoryId: pet.id })).code, 201);   // can be pushed again

  // the saved NONFOOD report lost its only PO to Central Admin, so it disappears from Submitted Summary Report; FROZEN/RTD shows the edited amount
  r = await call(po, { query: { view: 'submitted' } });
  assert.deepEqual(r.body.saved.map((x) => [x.report, x.count, x.total]), [['FROZEN/RTD', 1, 2000]]);
  assert.equal((await sql`select count(*)::int n from po_reports where report = 'NONFOOD'`)[0].n, 0);

  // edit a saved report: save two FOOD POs, then change one (supplier, category, amount...) and remove the other
  const food2 = (await call(po, { query: { view: 'pending' } })).body.rows.filter((x) => x.report === 'FOOD');
  const dFood = Object.fromEntries(food2.map((x) => [x.poNo, x.id]));
  assert.equal((await push({ k: token, po: { po_no: 'HQ01980001', supplier: 'A SDN BHD', amount: 300 }, poCategoryId: rice.id })).code, 201);
  const food3 = (await call(po, { query: { view: 'pending' } })).body.rows.filter((x) => x.report === 'FOOD').map((x) => x.id);
  const riceRecv = async () => (await call(dashboard)).body.categories.find((c) => c.name === 'RICE').received;
  const rice0 = await riceRecv(), bev1 = await bevRecv();
  r = await submit({ report: 'FOOD', ids: food3 });
  assert.equal(r.code, 200);
  const rid = r.body.reportId;
  const poRows = (await call(po, { query: { view: 'submitted' } })).body.rows.filter((x) => x.reportId === rid);
  assert.equal(poRows.length, 2);
  const pBev = poRows.find((x) => x.poNo === 'HQ01964261'), pRice = poRows.find((x) => x.poNo === 'HQ01980001');
  assert.equal(await riceRecv(), rice0 + 300);
  const save = (b, as = '1008-SHBN') => call(po, { method: 'POST', as, body: { action: 'report_save', reportId: rid, ...b } });
  const upd = (x, o) => ({ id: x.id, supplier: x.supplier, poCategoryId: x.pcId, brand: x.brand, remark: x.remark, dateVerified: x.dateVerified, dateReceived: x.dateReceived, amount: x.amount, ...o });
  assert.equal((await save({ updates: [upd(pBev, { poCategoryId: pet.id })] })).code, 400);          // NONFOOD category on a FOOD report
  assert.equal((await save({ updates: [upd(pBev, { amount: 0 })] })).code, 400);
  assert.equal((await save({ updates: [upd(pBev, { supplier: ' ' })] })).code, 400);
  assert.equal((await save({ updates: [upd(pBev, {})] }, '1015-SHPL')).code, 403);
  assert.equal((await call(po, { method: 'POST', body: { action: 'report_save', reportId: 99999, updates: [] } })).code, 404);
  r = await save({ updates: [upd(pBev, { poCategoryId: rice.id, amount: '1,500.50', brand: 'new brand', supplier: 'Edited Supplier', dateVerified: '2026-11-01', remark: 'fixed' }), upd(pRice, {})], deletes: [] });
  assert.deepEqual([r.code, r.body.updated, r.body.deleted], [200, 2, 0]);
  const ed = (await sql`select p.supplier, p.brand, p.remark, p.amount::float8 a, p.date_verified::text dv, e.value::float8 ev, c.name cn from purchase_orders p join entries e on e.id = p.entry_id join categories c on c.id = e.category_id where p.po_no = 'HQ01964261'`)[0];
  assert.deepEqual([ed.supplier, ed.brand, ed.remark, ed.a, ed.dv, ed.ev, ed.cn], ['EDITED SUPPLIER', 'NEW BRAND', 'FIXED', 1500.5, '2026-11-01', 1500.5, 'RICE']);   // the budget entry moved category and value with it
  assert.equal(await riceRecv(), rice0 + 300 + 1500.5);
  assert.equal(await bevRecv(), bev1);                                              // BEVERAGES back to what it was: the PO moved to RICE
  r = (await call(po, { query: { view: 'submitted' } })).body;
  assert.deepEqual(r.saved.find((x) => x.id === rid) && [r.saved.find((x) => x.id === rid).count, r.saved.find((x) => x.id === rid).total], [2, 1800.5]);
  // remove one PO from the report: its budget value goes too; the other PO stays
  r = await save({ updates: [], deletes: [pRice.id] });
  assert.deepEqual([r.code, r.body.deleted, r.body.reportGone], [200, 1, false]);
  assert.equal(await riceRecv(), rice0 + 1500.5);
  assert.equal((await sql`select count(*)::int n from purchase_orders where po_no = 'HQ01980001'`)[0].n, 0);
  // delete the whole report: report, POs and budget values all disappear; the PO numbers can be pushed again
  assert.equal((await call(po, { method: 'POST', as: '1015-SHPL', body: { action: 'report_delete', reportId: rid } })).code, 403);
  r = await call(po, { method: 'POST', body: { action: 'report_delete', reportId: rid } });
  assert.deepEqual([r.code, r.body.removed], [200, 1]);
  assert.equal(await riceRecv(), rice0);
  assert.equal((await sql`select count(*)::int n from po_reports where id = ${rid}`)[0].n, 0);
  assert.equal((await sql`select count(*)::int n from purchase_orders where po_no = 'HQ01964261'`)[0].n, 0);
  assert.equal((await call(po, { method: 'POST', body: { action: 'report_delete', reportId: rid } })).code, 404);
  assert.equal((await push({ k: token, po: PO2, poCategoryId: bev.id })).code, 201);
  // removing every PO from a saved report removes the report itself
  const idn = (await call(po, { query: { view: 'pending' } })).body.rows.find((x) => x.poNo === 'HQ01964261').id;
  r = await submit({ report: 'FOOD', ids: [idn] });
  const only = (await call(po, { query: { view: 'submitted' } })).body.rows.find((x) => x.reportId === r.body.reportId);
  r = await call(po, { method: 'POST', body: { action: 'report_save', reportId: r.body.reportId, updates: [], deletes: [only.id] } });
  assert.deepEqual([r.code, r.body.reportGone], [200, true]);

  // several computers: every one gets its own bookmark (SHBN1, SHBN2, ...); they all work at the same time
  const t1 = token;
  r = await call(po, { method: 'POST', body: { action: 'token' } });
  assert.deepEqual([r.code, r.body.device.name], [200, 'SHBN2']);
  const t2 = r.body.token, id2 = r.body.device.id;
  r = await call(po, { method: 'POST', body: { action: 'token' } });
  const t3 = r.body.token, id3 = r.body.device.id;
  assert.equal(r.body.device.name, 'SHBN3');
  for (const t of [t1, t2, t3]) assert.equal((await check('HQ09999999', t)).code, 200);
  r = await call(po);
  assert.deepEqual(r.body.devices.map((x) => x.name), ['SHBN1', 'SHBN2', 'SHBN3']);
  // two computers adding at the very same moment get different names
  const pair = await Promise.all([call(po, { method: 'POST', body: { action: 'token' } }), call(po, { method: 'POST', body: { action: 'token' } })]);
  assert.deepEqual(pair.map((x) => x.body.device.name).sort(), ['SHBN4', 'SHBN5']);
  // the name can be edited (stored in capitals, unique per account); a freed name is used again
  const ren = (id, name, as = '1008-SHBN') => call(po, { method: 'POST', as, body: { action: 'device_rename', id, name } });
  assert.equal((await ren(id2, '  counter   pc ')).body.name, 'COUNTER PC');
  assert.equal((await ren(id3, 'counter pc')).code, 409);
  assert.equal((await ren(id3, '   ')).code, 400);
  assert.equal((await ren(id2, 'x', '1015-SHPL')).code, 403);
  assert.equal((await ren(99999, 'x')).code, 404);
  assert.equal((await check('HQ09999999', t2)).code, 200);                                // renaming does not touch the token
  // removing one computer stops only its bookmark
  assert.equal((await call(po, { method: 'POST', body: { action: 'device_delete', id: id2 } })).code, 200);
  assert.equal((await check('HQ09999999', t2)).code, 401);
  assert.equal((await check('HQ09999999', t1)).code, 200);
  assert.equal((await call(po, { method: 'POST', body: { action: 'device_delete', id: id2 } })).code, 404);
  assert.equal((await call(po, { method: 'POST', as: '1015-SHPL', body: { action: 'device_delete', id: id3 } })).code, 403);
  // replacing one computer's bookmark keeps its name and cuts the old token of that computer only
  r = await call(po, { method: 'POST', body: { action: 'token', id: id3 } });
  assert.deepEqual([r.code, r.body.device.name, r.body.device.id], [200, 'SHBN3', id3]);
  assert.equal((await check('HQ09999999', t3)).code, 401);
  assert.equal((await check('HQ09999999', r.body.token)).code, 200);
  assert.equal((await check('HQ09999999', t1)).code, 200);
  assert.equal((await call(po, { method: 'POST', body: { action: 'token', id: 99999 } })).code, 404);
  // a push marks the computer as used
  await push({ k: t1, po: { po_no: 'HQ05550000', supplier: 'S', amount: 1 }, poCategoryId: pet.id });
  assert.ok((await call(po)).body.devices.find((x) => x.name === 'SHBN1').lastUsed > 0);
  // upgrade: the single bookmark of the earlier version becomes this account's first computer
  await sql`delete from push_devices where account = '1008-SHBN'`;
  await sql`insert into push_tokens (account, token_hash) values ('1008-SHBN', ${hashToken(t1)}) on conflict (account) do update set token_hash = excluded.token_hash`;
  await ensureSchema(sql, true);
  assert.deepEqual((await call(po)).body.devices.map((x) => x.name), ['SHBN1']);
  assert.equal((await check('HQ09999999', t1)).code, 200);
  await ensureSchema(sql, true);                                                          // running it again changes nothing
  assert.equal((await call(po)).body.devices.length, 1);
}

// --- Upgrading an existing (pre-accounts) database keeps its entries and gives them to 1008-SHBN ---------------
{
  const { PGlite } = await import('@electric-sql/pglite');
  const old = new PGlite({ parsers: { 20: (v) => v } });
  await old.exec(`
    create table categories (id serial primary key, department text not null, name text not null, limit_value numeric(14,2) not null, sort_order int not null default 0, unique (department, name));
    create table settings (key text primary key, value text not null);
    create table entries (id bigserial primary key, category_id int not null references categories(id), value numeric(14,2) not null check (value > 0),
      submitted_by text not null, entry_date date not null, cycle_no int not null, created_at timestamptz not null default now());
    insert into categories (department, name, limit_value) values ('FOOD', 'RICE', 100);
    insert into entries (category_id, value, submitted_by, entry_date, cycle_no) values (1, 10, 'OLD ENTRY', '2026-11-10', 1), (1, 20, 'OLD TWO', '2026-11-10', 0);`);
  const oldSql = (strings, ...vals) => old.query(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? `$${i + 1}` : ''), ''), vals).then((x) => x.rows);
  await ensureSchema(oldSql, true);
  const rows = await oldSql`select submitted_by, account from entries order by id`;
  assert.deepEqual(rows.map((x) => x.account), ['1008-SHBN', '1008-SHBN']);
  assert.equal((await oldSql`select count(*)::int n from accounts`)[0].n, 4);
  assert.equal((await oldSql`select count(*)::int n from settings where key in ('admin_hash', 'hq_hash')`)[0].n, 0);   // retired Admin-tab passwords are removed
  const lim = await oldSql`select account, limit_value::float8 v from account_limits order by account`;           // RICE got one row per account
  assert.deepEqual(lim.map((x) => x.account), ['1007-SHPP', '1008-SHBN', '1015-SHPL']);
  assert.deepEqual(lim.map((x) => x.v), ['1007-SHPP', '1008-SHBN', '1015-SHPL'].map((c) => LIMITS.find((l) => l[0] === c && l[2] === 'RICE')[3]));
  await oldSql`update account_limits set limit_value = 5 where account = '1008-SHBN'`;                             // a manual change...
  await ensureSchema(oldSql, true);
  assert.equal((await oldSql`select limit_value::float8 v from account_limits where account = '1008-SHBN'`)[0].v, 5);  // ...survives later start-ups
  await assert.rejects(() => old.query(`insert into entries (category_id, value, submitted_by, entry_date, cycle_no) values (1, 1, 'X', '2026-11-10', 1)`)); // account is now required
  await ensureSchema(oldSql, true);               // running it again changes nothing
  assert.equal((await oldSql`select count(*)::int n from entries`)[0].n, 2);
  assert.equal((await oldSql`select count(*)::int n from accounts`)[0].n, 4);
}

console.log('All DOMS tests passed');
process.exit(0);
