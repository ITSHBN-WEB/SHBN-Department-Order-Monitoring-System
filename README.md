# DOMS – Department Order Monitoring System

Tracks stock value received per category against its limit, in repeating 45-day cycles.
Stack: **Neon** (Postgres) · **Vercel** (static page + 2 serverless functions) · **GitHub**.

- Live tracking starts **01/11/2026**; cycle 1 = 01/11/2026 – 15/12/2026, cycle 2 starts 16/12/2026, and so on (automatic).
- Cycle length and start date live in the `settings` table (see "Changing settings").

## Test Cycle (01/10/2026 – 30/10/2026)

- Until live tracking starts, the app runs in a **Test Cycle**: entries are saved as practice data (cycle 0), tagged "Test" in Recent Activity, and **never counted in the live cycles**.
- From 01/11/2026 the app runs live Cycle 1, starting from zero. Test data stays viewable via the cycle arrows (Test Cycle <-> Cycle 1).
- Clear the practice data any time (Neon SQL Editor): `delete from entries where cycle_no = 0;`
- Change the window: `update settings set value = '2026-10-01' where key = 'test_start';` (and `test_end`). To turn it off: `update settings set value = '' where key in ('test_start','test_end');`
- The app upgrades an older database by itself (adds missing columns/settings on first request), so you don't have to re-run `db/setup.sql` after updating the code.
- "Submitted By" is always stored in UPPERCASE.
- Dates on existing databases are moved to these ones automatically, once, on first start after deploying; later changes you make in the database are never overwritten.

## Multiple users submitting at once

- Entries are append-only inserts and totals are always summed from them, so simultaneous submits can't overwrite each other or lose a value.
- Each submission has a unique request id (unique index in the DB): a double-click or network retry is saved only once.
- The "over limit" result is the category total as of *that* entry, matching Recent Activity.
- The dashboard auto-refreshes every 30 seconds so everyone sees each other's entries.
- `npm test` covers 25 simultaneous users and a double-click sent 6 times at once.

## Accounts and sign-in

- Three accounts: **1008-SHBN**, **1015-SHPL**, **1007-SHPP**. Everyone signs in on the first screen with their account code and password.
- **Each account's data is completely separate**: its own entries, totals, recent activity and Admin list. All accounts use the same category limits and the same cycle dates.
- Passwords are stored only as salted hashes (never in plain text, never in this repo). The sign-in lasts 12 hours or until **Log out** (which also forgets the remembered name).
- Existing entries made before accounts existed are assigned to **1008-SHBN** automatically (once, on the first start after deploying).
- Change a password: `node scripts/hash-password.js "NewPassword"` prints the hash and the SQL to run in the Neon SQL Editor.
- Optional: set `SESSION_SECRET` in Vercel to use your own session-signing key (otherwise one is derived from `DATABASE_URL`).

## Admin tab (edit / delete entries)

- Sidebar -> **Admin**. You must be signed in, and then enter an admin password (checked on the server for every request):
  - **Account admin password** -> edit/delete only the signed-in account's own entries.
  - **Head-office password** -> edit/delete entries of **all** accounts. Extra "Account" filter and column; an entry's account itself cannot be changed.
- Flow: pick the **Period (cycle)** -> filter by **Department** -> optionally a **Category** -> **Edit** (category, value, submitted by) or **Delete** a row -> press **Save changes**.
- Edits and deletions are staged first (rows are highlighted, **Undo** is available) and only written when you press Save. All changes are saved together, all-or-nothing.
- Edited entries show an "Edited" tag. The admin view locks after 15 minutes of inactivity, or with the Lock button.
- Change the admin passwords with `scripts/hash-password.js` (it prints the SQL for `admin_hash` and `hq_hash`).

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
update settings set value = '2026-11-01' where key = 'tracking_start';
update settings set value = '45'         where key = 'cycle_days';
update categories set limit_value = 300000 where name = 'BEVERAGES';
```
Re-running `db/setup.sql` is safe (it is not required after updating the code: the app upgrades an older database by itself): it refreshes limits from the Excel list and never deletes entries.

## Layout

```
public/index.html   the whole UI (sidebar, dashboard, New Entry, Recent Activity)
api/dashboard.js    GET  – categories, totals, recent activity, cycle info
api/entries.js      POST – validate + save an entry
api/auth.js         sign in / sign out / who am I
api/admin.js        Admin tab API (account scope or head-office scope)
lib/                Neon connection + cycle maths
db/setup.sql        tables + seed from Department_Value.xlsx
dev/                local server and tests (not deployed)
```
