# DOMS – Department Order Monitoring System

Tracks stock value received per category against its limit, in repeating 45-day cycles.
Stack: **Neon** (Postgres) · **Vercel** (static page + 4 serverless functions) · **GitHub**.

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

## Limits per account

- `data/Department_Value.xlsx` has one sheet per account: **SHBN -> 1008-SHBN**, **SHPL -> 1015-SHPL**, **SHPP -> 1007-SHPP** (same 31 categories, different limits).
- The limits are loaded into the `account_limits` table automatically, once, on the first start after deploying. After that, edits you make in the database are never overwritten.
- Change one limit (Neon SQL Editor, no redeploy):
  ```sql
  update account_limits set limit_value = 300000
   where account = '1015-SHPL' and category_id = (select id from categories where name = 'BEVERAGES');
  ```
- To reload everything from a new workbook, send it to me and I'll regenerate `db/setup.sql`; re-running that file refreshes all limits (entries are never touched).

## Accounts and sign-in

- Three accounts: **1008-SHBN**, **1015-SHPL**, **1007-SHPP**. Everyone signs in on the first screen with their account code and password.
- A fourth account, **CENTRAL-ADMIN**, sees all three accounts' data and cannot submit entries (see "Central Admin" below). It has no limits or entries of its own, and it is the only account that can edit or delete entries (Record Adjustments tab).
- **Each account's data is completely separate**: its own entries, totals, recent activity, tracked against **its own category limits** (see below). All accounts share the same cycle dates.
- Passwords are stored only as salted hashes (never in plain text, never in this repo). The sign-in lasts 12 hours or until **Log out** (which also forgets the remembered name).
- Existing entries made before accounts existed are assigned to **1008-SHBN** automatically (once, on the first start after deploying).
- Change a password: `node scripts/hash-password.js "NewPassword"` prints the hash and the SQL to run in the Neon SQL Editor.
- Optional: set `SESSION_SECRET` in Vercel to use your own session-signing key (otherwise one is derived from `DATABASE_URL`).

## Record Adjustments tab (edit / delete entries)

- Sidebar -> **Record Adjustments**. This tab exists **only for the Central Admin account**: no other account sees it, and the server refuses its requests from anyone else. No extra password is asked.
- Central Admin can edit/delete entries of **all** accounts (Account filter and column; an entry's account itself cannot be changed).
- Flow: pick the **Period (cycle)** -> filter by **Account** and/or **Department** -> optionally a **Category** -> **Edit** (category, value, submitted by) or **Delete** a row -> press **Save changes**.
- Edits and deletions are staged first (rows are highlighted, **Undo** is available) and only written when you press Save. All changes are saved together, all-or-nothing.
- Edited entries show an "Edited" tag. Every edit/delete is also written to the `adjustments` table (before/after values) and shown in the **Recent Activity** box at the right of the tab.

## Dashboard features

- **New Entry:** pick a category (department fills in automatically), enter **Value** and **Submitted By**. The Value box accepts numbers only, adds thousands commas while typing and pads to 2 decimals when you leave it (`1` -> `1.00`, `9120` -> `9,120.00`). **Clear** empties the form and forgets the saved name.
- **Over budget summary:** a red box under the total cards lists every category that has passed its limit (amount over and %). Shown for every account.
- **Header badge:** animated holographic DOMS logo (pure SVG/CSS, respects reduced-motion).

## Central Admin

- Sign in as **CENTRAL-ADMIN**. The right-hand panel shows **Filters** instead of Recent Activity:
  - **Account:** All accounts, or one account.
  - **Department** and **Category:** tick several to compare. Totals follow the ticks.
- With **All accounts**, nothing is added together: each category lists the three accounts one under the other (1008-SHBN, 1007-SHPP, 1015-SHPL), each with its own bar, received / limit and status. The top cards show one card per account.

## Push to DOMS (PO Entry, PO Summary Report, Submitted Summary Report) – 1008-SHBN only for now
Only the 1008-SHBN account sees the **PO Entry**, **PO Summary Report**, **Submitted Summary Report** and **DOMS Bookmark** tabs (under Dashboard). Other accounts and Central Admin do not.

**Set up the bookmark (once per computer)**
1. **DOMS Bookmark** tab > **Add this computer**. The computer is named SHBN1, the next one SHBN2, and so on. Use **Rename** to give it a better name (e.g. COUNTER PC).
2. Drag the **Push to DOMS** button to the bookmarks bar.
3. Every computer has its own bookmark and they all work at the same time. Do the same on each computer (open DOMS there and press **Add this computer**), or copy the bookmark with your browser's bookmark sync.
4. **Replace this bookmark** gives this computer a new bookmark (the old one stops working, other computers are not affected). **Remove** cuts one computer off. The list also shows when each computer was last used.
5. The bookmark contains a private token (like a password): do not share it.

**Use it**
1. On the portal open the PO detail page (View PO Detail) and click the bookmark.
2. A popup shows what was read: PO No, Supplier (the box after the supplier code), PO Date > Date Received PO, Posted By / Date (date only) > Date Verified PO, Grand Total (RM) > PO Amount.
3. Choose the **Category**, check the **Brand**, add a **Remark** (optional), then **Send to DOMS**. A PO No already in DOMS is blocked.
4. The pushed PO is **PENDING**: it does not change any budget. It shows in **PO Entry** (a pending PO can be edited with Edit, or removed with Remove and pushed again; every field except the PO No can be changed).
5. **PO Summary Report** tab: pick Food, Frozen/RTD or Nonfood to preview the pending POs on the printable form. Untick any PO to leave it for a later report, then press **Save entry & Print**. Saving adds each ticked PO amount to its category budget (current cycle, visible in the Dashboard and Recent Activity) and prints the report. The saved POs leave the preview. The form shows a TOTAL row under each category.
6. **Submitted Summary Report** tab: every saved report, filtered by saved date range (default last 30 days) and by report (All / Food / Frozen/RTD / Nonfood). Press **View / Print** to open one and print it again, **Edit** to change its POs (supplier, category within the same report, brand, dates, amount, remark; the PO No is fixed) or remove a PO from it, and **Delete** to delete the whole report. Edits, removals and deletes also change the category budgets: the PO's budget entry moves or changes with it, and a deleted report takes its POs and their values off the budgets (the PO numbers can then be pushed again).

Each report has its own Attn To, Department and PO categories (BEVERAGES is on Food, READY TO DRINKS on Frozen/RTD; both count to the BEVERAGES budget). The form prints A4 portrait (page numbers 1/2, 2/2 appear at the bottom right when it runs to two pages; signature lines for Verify by / Approved by) and shows the portal PO No.
If the popup says a field was "not found", the portal page layout differs from what the bookmark expects: send a screenshot and the readers can be adjusted.

Editing a saved entry's value in Record Adjustments updates the PO amount; deleting it also removes the PO from the saved report (and the report disappears if it ends up with no POs), so it can be pushed again.
New tables are created automatically on the first request after deploy (db/setup.sql also contains them).

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
public/index.html   the whole UI (sidebar, dashboard, New Entry, Recent Activity, Central Admin filters, Record Adjustments)
api/dashboard.js    GET  – categories, totals, recent activity, cycle info
api/entries.js      POST – validate + save an entry
api/auth.js         sign in / sign out / who am I
api/admin.js        Record Adjustments API (Central Admin only) + adjustments log
lib/                Neon connection + cycle maths
db/setup.sql        tables + seed (categories, accounts, per-account limits) from Department_Value.xlsx
dev/                local server and tests (not deployed)
```
