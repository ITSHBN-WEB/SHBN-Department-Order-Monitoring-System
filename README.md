# DOMS – Department Order Monitoring System

Tracks stock value received per category against its limit, in repeating 45-day cycles.
Stack: **Neon** (Postgres) · **Vercel** (static page + 2 serverless functions) · **GitHub**.

- Tracking starts **15/11/2026**; cycle 1 = 15/11/2026 – 29/12/2026, cycle 2 starts 30/12/2026, and so on (automatic).
- Cycle length and start date live in the `settings` table (see "Changing settings").

## Test Cycle (30/09/2026 – 14/11/2026)

- Until live tracking starts, the app runs in a **Test Cycle**: entries are saved as practice data (cycle 0), tagged "Test" in Recent Activity, and **never counted in the live cycles**.
- On 15/11/2026 the app switches to live Cycle 1 on its own, starting from zero. Test data stays viewable via the cycle arrows (Test Cycle <-> Cycle 1).
- Clear the practice data any time (Neon SQL Editor): `delete from entries where cycle_no = 0;`
- Change the window: `update settings set value = '2026-09-30' where key = 'test_start';` (and `test_end`). To turn it off: `update settings set value = '' where key in ('test_start','test_end');`
- The app upgrades an older database by itself (adds missing columns/settings on first request), so you don't have to re-run `db/setup.sql` after updating the code.
- "Submitted By" is always stored in UPPERCASE.
- Note: 30/09 – 14/11 is 46 days (inclusive), one more than a normal cycle.

## Multiple users submitting at once

- Entries are append-only inserts and totals are always summed from them, so simultaneous submits can't overwrite each other or lose a value.
- Each submission has a unique request id (unique index in the DB): a double-click or network retry is saved only once.
- The "over limit" result is the category total as of *that* entry, matching Recent Activity.
- The dashboard auto-refreshes every 30 seconds so everyone sees each other's entries.
- `npm test` covers 25 simultaneous users and a double-click sent 6 times at once.

## Admin tab (edit / delete entries)

- Sidebar -> **Admin**, password **8888** (checked on the server for every request, not just in the browser).
- To change it without editing code: in Vercel add the environment variable `ADMIN_PASSWORD` and redeploy.
- Flow: pick the **Period (cycle)** -> filter by **Department** -> optionally a **Category** -> **Edit** (category, value, submitted by) or **Delete** a row -> press **Save changes**.
- Edits and deletions are staged first (rows are highlighted, **Undo** is available) and only written when you press Save. All changes are saved together, all-or-nothing.
- Edited entries show an "Edited" tag. The admin session locks after 15 minutes of inactivity, or with the Lock button.
- Dashboard totals follow immediately, because they are always calculated from the entries.

## Deploy (once)

1. **Neon** – create a project. Choose region **AWS Asia Pacific (Singapore)** (matches `vercel.json` region `sin1`).
   Open **SQL Editor**, paste all of `db/setup.sql`, run it. Then copy the connection string (Dashboard → Connect → *pooled*), e.g. `postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
2. **GitHub** – create a repo and push this folder (`node_modules` is git-ignored).
3. **Vercel** – Add New Project → import the repo → framework preset **Other** → add Environment Variable
   `DATABASE_URL` = the Neon connection string → Deploy.

Every push to `main` triggers a new deployment and counts toward your 13-deployment limit, so test locally first and batch your changes.

## Test locally (no Neon needed, doesn't use a deployment)

```
npm install
npm test               # API + cycle logic tests
DEMO=1 npm run dev     # http://localhost:3000 with sample data (in-memory, resets on restart)
```

## Changing settings (no redeploy needed – run in Neon SQL Editor)

```sql
update settings set value = '2026-11-15' where key = 'tracking_start';
update settings set value = '45'         where key = 'cycle_days';
update categories set limit_value = 300000 where name = 'BEVERAGES';
```
Re-running `db/setup.sql` is safe (and is required once if you ran an older version: it adds the request-id column and test settings): it refreshes limits from the Excel list and never deletes entries.

## Layout

```
public/index.html   the whole UI (sidebar, dashboard, New Entry, Recent Activity)
api/dashboard.js    GET  – categories, totals, recent activity, cycle info
api/entries.js      POST – validate + save an entry
lib/                Neon connection + cycle maths
db/setup.sql        tables + seed from Department_Value.xlsx
dev/                local server and tests (not deployed)
```
