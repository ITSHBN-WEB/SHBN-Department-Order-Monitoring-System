// npm test — exercises the API handlers against an in-memory Postgres.
import assert from 'node:assert/strict';
import { createLocalDb } from './pg.js';
import { currentCycle, describeCycle } from '../lib/cycle.js';
import { ensureSchema } from '../lib/db.js';
import { hashPassword, signSession } from '../lib/auth.js';
import { LIMITS } from '../lib/seed.js';

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
    };
    handler({ method, query, body, headers: { cookie: cookie ?? (as ? cookieFor(as) : '') } }, res);
  });

// Test-only passwords (the real ones are never in the repo; the seeded hashes are checked by hand).
await sql`update settings set value = ${hashPassword('test-admin')} where key = 'admin_hash'`;
await sql`update settings set value = ${hashPassword('test-hq')} where key = 'hq_hash'`;

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
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
const adm = (body, as) => call(admin, { method: 'POST', as, body: { password: 'test-admin', ...body } });
assert.equal((await call(admin, { method: 'POST', body: { action: 'list', cycle: 2 } })).code, 401);          // no password
assert.equal((await call(admin, { method: 'POST', body: { password: '1234', action: 'login' } })).code, 401); // wrong password
assert.equal((await call(admin, { method: 'POST', as: null, body: { password: 'test-admin', action: 'login' } })).code, 401); // right password but not signed in
assert.equal((await call(admin, { method: 'GET' })).code, 405);
assert.equal((await adm({ action: 'login' })).code, 200);

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

// --- Accounts: sign-in ----------------------------------------------------------------------
const { default: auth } = await import('../api/auth.js');
const seeded = await sql`select code, password_hash from accounts order by code`;
assert.deepEqual(seeded.map((a) => a.code), ['1007-SHPP', '1008-SHBN', '1015-SHPL']);
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
assert.deepEqual(r.body, { accounts: ['1007-SHPP', '1008-SHBN', '1015-SHPL'] });
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
  assert.equal((await call(admin, { method: 'POST', cookie: bad, as: null, body: { action: 'login', password: 'test-admin' } })).code, 401);
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

// --- Admin: per-account scope (admin password) vs head office (hq password) ----------------------
const ids = Object.fromEntries((await sql`select account, min(id)::int as id from entries group by account`).map((x) => [x.account, x.id]));
r = await adm({ action: 'meta' }, '1015-SHPL');
assert.deepEqual([r.body.scope, r.body.account, r.body.accounts], ['account', '1015-SHPL', ['1015-SHPL']]);
r = await adm({ action: 'list', cycle: 1 }, '1015-SHPL');
assert.equal(r.body.entries.length, 2);
assert.ok(r.body.entries.every((e) => e.account === '1015-SHPL'));
r = await adm({ action: 'list', cycle: 1, account: '1008-SHBN' }, '1015-SHPL');   // trying to look at another account
assert.ok(r.body.entries.every((e) => e.account === '1015-SHPL'));                // ...is ignored
r = await adm({ action: 'save', deletes: [ids['1008-SHBN']], updates: [{ id: ids['1007-SHPP'], categoryId: rice2, value: 1, submittedBy: 'HACK' }] }, '1015-SHPL');
assert.deepEqual([r.code, r.body.updated, r.body.deleted, r.body.missing], [200, 0, 0, 2]);   // nothing outside its own account changed
assert.equal((await sql`select count(*)::int n from entries where id = ${ids['1008-SHBN']} and submitted_by = 'T'`)[0].n, 1);
assert.equal((await sql`select count(*)::int n from entries where id = ${ids['1007-SHPP']} and submitted_by = 'HACK'`)[0].n, 0);
r = await adm({ action: 'save', deletes: [ids['1015-SHPL']] }, '1015-SHPL');       // its own entry: fine
assert.deepEqual([r.body.deleted, r.body.missing], [1, 0]);

const hqCall = (body, as = '1007-SHPP') => call(admin, { method: 'POST', as, body: { password: 'test-hq', ...body } });
r = await hqCall({ action: 'meta' });
assert.deepEqual([r.body.scope, r.body.accounts], ['hq', ['1007-SHPP', '1008-SHBN', '1015-SHPL']]);
assert.equal(r.body.cycles.find((c) => c.n === 1).count, (await sql`select count(*)::int n from entries where cycle_no = 1`)[0].n);   // counts cover all accounts
r = await hqCall({ action: 'list', cycle: 1 });
assert.deepEqual([...new Set(r.body.entries.map((e) => e.account))].sort(), ['1007-SHPP', '1008-SHBN', '1015-SHPL']);
r = await hqCall({ action: 'list', cycle: 1, account: '1008-SHBN' });
assert.ok(r.body.entries.length > 0 && r.body.entries.every((e) => e.account === '1008-SHBN'));
// head office edits and deletes entries belonging to other accounts
r = await hqCall({ action: 'save', updates: [{ id: ids['1008-SHBN'], categoryId: rice2, value: 4321, submittedBy: 'hq fix' }], deletes: [ids['1007-SHPP']] });
assert.deepEqual([r.code, r.body.updated, r.body.deleted, r.body.missing], [200, 1, 1, 0]);
const fixed = (await sql`select value::float8 v, submitted_by s, account from entries where id = ${ids['1008-SHBN']}`)[0];
assert.deepEqual([fixed.v, fixed.s, fixed.account], [4321, 'HQ FIX', '1008-SHBN']);              // account itself is never changed
assert.equal((await riceOf('1008-SHBN')).received, 4321 + 1 + 5);
// the two admin passwords are not interchangeable with account passwords
assert.equal((await call(admin, { method: 'POST', as: '1008-SHBN', body: { password: 'pw-bn', action: 'login' } })).code, 401);

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
  assert.equal((await oldSql`select count(*)::int n from accounts`)[0].n, 3);
  assert.equal((await oldSql`select count(*)::int n from settings where key in ('admin_hash', 'hq_hash')`)[0].n, 2);
  const lim = await oldSql`select account, limit_value::float8 v from account_limits order by account`;           // RICE got one row per account
  assert.deepEqual(lim.map((x) => x.account), ['1007-SHPP', '1008-SHBN', '1015-SHPL']);
  assert.deepEqual(lim.map((x) => x.v), ['1007-SHPP', '1008-SHBN', '1015-SHPL'].map((c) => LIMITS.find((l) => l[0] === c && l[2] === 'RICE')[3]));
  await oldSql`update account_limits set limit_value = 5 where account = '1008-SHBN'`;                             // a manual change...
  await ensureSchema(oldSql, true);
  assert.equal((await oldSql`select limit_value::float8 v from account_limits where account = '1008-SHBN'`)[0].v, 5);  // ...survives later start-ups
  await assert.rejects(() => old.query(`insert into entries (category_id, value, submitted_by, entry_date, cycle_no) values (1, 1, 'X', '2026-11-10', 1)`)); // account is now required
  await ensureSchema(oldSql, true);               // running it again changes nothing
  assert.equal((await oldSql`select count(*)::int n from entries`)[0].n, 2);
  assert.equal((await oldSql`select count(*)::int n from accounts`)[0].n, 3);
}

console.log('All DOMS tests passed');
process.exit(0);
