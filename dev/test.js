// npm test — exercises the API handlers against an in-memory Postgres.
import assert from 'node:assert/strict';
import { createLocalDb } from './pg.js';
import { currentCycle, describeCycle } from '../lib/cycle.js';

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
const s = { start: '2026-11-15', days: 45 };
assert.deepEqual(currentCycle(s, '2026-11-14'), { started: false, current: 0, daysUntilStart: 1, diff: -1 });
assert.equal(currentCycle(s, '2026-11-15').current, 1);
assert.equal(currentCycle(s, '2026-12-29').current, 1);  // day 45
assert.equal(currentCycle(s, '2026-12-30').current, 2);  // day 46 -> next cycle
assert.equal(describeCycle(s, 1, '2026-11-15').end, '2026-12-29');
assert.equal(describeCycle(s, 2, '2026-12-30').start, '2026-12-30');
assert.equal(describeCycle(s, 1, '2026-11-15').dayNumber, 1);
assert.equal(describeCycle(s, 1, '2026-12-29').daysLeft, 0);

// --- seed data ------------------------------------------------------------
const cats = await sql`select count(*)::int n, sum(limit_value)::float8 total from categories`;
assert.equal(cats[0].n, 31);
assert.equal(cats[0].total, 2217415);

// --- before tracking starts -----------------------------------------------
await setStart(iso(5));
let r = await call(dashboard);
assert.equal(r.body.started, false);
assert.equal(r.body.daysUntilStart, 5);
assert.equal(r.body.cycle.status, 'upcoming');
r = await call(entries, { method: 'POST', body: { categoryId: await catId('RICE'), value: 100, submittedBy: 'Tester' } });
assert.equal(r.code, 400);
assert.match(r.body.error, /Tracking begins/);

// --- active cycle -----------------------------------------------------------
await setStart(iso(-3));
const rice = await catId('RICE'); // limit 178,126
r = await call(entries, { method: 'POST', body: { categoryId: rice, value: '100000', submittedBy: '  Ali   Baba ' } });
assert.equal(r.code, 201);
assert.equal(r.body.overLimit, false);
r = await call(entries, { method: 'POST', body: { categoryId: rice, value: 78126.5, submittedBy: 'Siti' } });
assert.equal(r.body.received, 178126.5);
assert.equal(r.body.overLimit, true);            // 0.50 over the limit

// validation
for (const bad of [
  { categoryId: rice, value: 0, submittedBy: 'x' },
  { categoryId: rice, value: -5, submittedBy: 'x' },
  { categoryId: rice, value: 'abc', submittedBy: 'x' },
  { categoryId: rice, value: 10, submittedBy: '   ' },
  { categoryId: 99999, value: 10, submittedBy: 'x' },
  { value: 10, submittedBy: 'x' },
]) assert.equal((await call(entries, { method: 'POST', body: bad })).code, 400, JSON.stringify(bad));

r = await call(dashboard);
assert.equal(r.body.started, true);
assert.equal(r.body.cycle.n, 1);
assert.equal(r.body.cycle.status, 'active');
assert.equal(r.body.cycle.dayNumber, 4);
const riceRow = r.body.categories.find((c) => c.name === 'RICE');
assert.equal(riceRow.received, 178126.5);
assert.equal(riceRow.department, 'FOOD');
assert.equal(r.body.recent.length, 2);
assert.equal(r.body.recent[0].overLimit, true);   // the entry that tipped it over
assert.equal(r.body.recent[1].overLimit, false);
assert.equal(r.body.recent[1].submittedBy, 'Ali Baba');

// --- cycle rollover: totals reset, old cycle still viewable --------------------
await setStart(iso(-46));                         // today is now day 1 of cycle 2
r = await call(dashboard);
assert.equal(r.body.currentCycle, 2);
assert.equal(r.body.categories.find((c) => c.name === 'RICE').received, 0);
r = await call(dashboard, { query: { cycle: '1' } });
assert.equal(r.body.cycle.status, 'closed');
assert.equal(r.body.categories.find((c) => c.name === 'RICE').received, 178126.5); // old entries stay in cycle 1
// now put an entry in cycle 2 and check both views
r = await call(entries, { method: 'POST', body: { categoryId: rice, value: 500, submittedBy: 'Zul' } });
assert.equal(r.body.cycle, 2);
assert.equal(r.body.received, 500);
r = await call(dashboard, { query: { cycle: '1' } });
const row1 = r.body.categories.find((c) => c.name === 'RICE');
assert.equal(row1.received, 178126.5);            // cycle 1 totals preserved
assert.equal(row1.receivedCurrent, 500);
r = await call(dashboard, { query: { cycle: '99' } });
assert.equal(r.body.cycle.n, 2);                  // out-of-range falls back to current

console.log('All DOMS tests passed');
process.exit(0);
