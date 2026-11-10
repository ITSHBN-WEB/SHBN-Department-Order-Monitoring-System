# DOMS – Department Order Monitoring System

Tracks stock value received per category against its limit, in repeating 45-day cycles.
Stack: **Neon** (Postgres) · **Vercel** (static page + 2 serverless functions) · **GitHub**.

- Tracking starts **15/11/2026**; cycle 1 = 15/11/2026 – 29/12/2026, cycle 2 starts 30/12/2026, and so on (automatic).
- Cycle length and start date live in the `settings` table (see "Changing settings").

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
Re-running `db/setup.sql` is safe: it refreshes limits from the Excel list and never deletes entries.

## Layout

```
public/index.html   the whole UI (sidebar, dashboard, New Entry, Recent Activity)
api/dashboard.js    GET  – categories, totals, recent activity, cycle info
api/entries.js      POST – validate + save an entry
lib/                Neon connection + cycle maths
db/setup.sql        tables + seed from Department_Value.xlsx
dev/                local server and tests (not deployed)
```
