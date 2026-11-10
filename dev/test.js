// npm test — exercises the API handlers against an in-memory Postgres.
import assert from 'node:assert/strict';
import { createLocalDb } from './pg.js';
import { currentCycle, describeCycle } from '../lib/cycle.js';
import { ensureSchema } from '../lib/db.js';

const sql = await createLocalDb();
const { default: dashboard } = await import('../api/dashboard.js');
const { default: entries } = await import('../api/entries.js');

const call = (handler, { method = 'GET', query = {}, body } = {}) =>
  new Promise((resolve) => {
    const res = {
      headers: {}, code: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(o) { resolve({ code: this.code, body: o }); },
    };
    handler({ method, query, body }, res);
  });

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
assert.equal(st.test_start, '2026-09-30');
assert.equal(st.test_end, '2026-11-14');

const rice = await catId('RICE'); // limit 178,126
const post = (body) => call(entries, { method: 'POST', body: { categoryId: rice, submittedBy: 'Tester', ...body } });
const noTest = () => sql`delete from settings where key in ('test_start','test_end')`;
const setTest = (a, b) => sql`insert into settings (key, value) values ('test_start', ${a}), ('test_end', ${b})
  on conflict (key) do update set value = excluded.value`;

// --- older database (no request_id column, no test settings) is upgraded automatically ---
await sql.raw('alter table entries drop column request_id');
await sql`delete from settings where key in ('test_start','test_end')`;
await ensureSchema(sql, true);
assert.equal((await sql`select value from settings where key = 'test_start'`)[0].value, '2026-09-30');
assert.equal((await sql`select count(*)::int n from information_schema.columns where table_name = 'entries' and column_name = 'request_id'`)[0].n, 1);

// --- Test Cycle (today inside 30/09 - 14/11) ---------------------------------
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

console.log('All DOMS tests passed');
process.exit(0);
