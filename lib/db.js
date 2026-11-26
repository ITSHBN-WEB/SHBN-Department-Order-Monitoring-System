import { neon } from '@neondatabase/serverless';
import { ACCOUNT_SEED, LIMITS } from './seed.js';
import { PO_CATEGORY_SEED } from './poseed.js';

let cached;

/**
 * Returns a tagged-template SQL function:  await sql`select * from t where id = ${id}`
 * In production this talks to Neon over HTTPS using the DATABASE_URL env var.
 * The local dev server / tests inject an in-memory Postgres via globalThis.__DOMS_SQL__.
 */
export function getSql() {
  if (globalThis.__DOMS_SQL__) return globalThis.__DOMS_SQL__;
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    cached = neon(url);
  }
  return cached;
}

let ready;

/**
 * Brings an older database up to date automatically (idempotent, runs once per server instance),
 * so a new deployment never depends on remembering to re-run db/setup.sql.
 */
export function ensureSchema(sql, force = false) {
  if (!ready || force) {
    ready = (async () => {
      const codes = ACCOUNT_SEED.map((a) => a.code), hashes = ACCOUNT_SEED.map((a) => a.hash);
      const lim = { a: LIMITS.map((x) => x[0]), d: LIMITS.map((x) => x[1]), n: LIMITS.map((x) => x[2]), v: LIMITS.map((x) => x[3]) };
      const po = { n: PO_CATEGORY_SEED.map((x) => x[0]), c: PO_CATEGORY_SEED.map((x) => x[1]), r: PO_CATEGORY_SEED.map((x) => x[2]), a: PO_CATEGORY_SEED.map((x) => x[3]), o: PO_CATEGORY_SEED.map((_, i) => i + 1) };
      const steps = [
        // accounts / sign-in (existing entries are given to 1008-SHBN)
        () => sql`create table if not exists accounts (code text primary key, password_hash text not null)`,
        () => sql`insert into accounts (code, password_hash) select * from unnest(${codes}::text[], ${hashes}::text[]) on conflict (code) do nothing`,
        // the old Admin-tab passwords are gone: only Central Admin (signed in) can adjust records
        () => sql`delete from settings where key in ('admin_hash', 'hq_hash')`,
        () => sql`alter table entries add column if not exists account text`,
        () => sql`update entries set account = '1008-SHBN' where account is null`,
        () => sql`alter table entries alter column account set not null`,
        // per-account category limits (one-time load from the workbook; the 'limits_v2' marker stops it overwriting later edits)
        () => sql`create table if not exists account_limits (
                    account text not null references accounts(code), category_id int not null references categories(id),
                    limit_value numeric(14,2) not null check (limit_value >= 0), primary key (account, category_id))`,
        () => sql`
          with m as (insert into settings (key, value) values ('limits_v2', '1') on conflict (key) do nothing returning key)
          insert into account_limits (account, category_id, limit_value)
          select u.account, c.id, u.limit_value
          from unnest(${lim.a}::text[], ${lim.d}::text[], ${lim.n}::text[], ${lim.v}::numeric[]) as u(account, department, name, limit_value)
          join categories c on c.department = u.department and c.name = u.name
          where exists (select 1 from m)
          on conflict (account, category_id) do update set limit_value = excluded.limit_value`,
        () => sql`create index if not exists entries_account_idx on entries (account, cycle_no, category_id)`,
        () => sql`alter table entries add column if not exists request_id uuid`,
        () => sql`alter table entries add column if not exists edited_at timestamptz`,
        () => sql`create unique index if not exists entries_request_id_uq on entries (request_id)`,
        () => sql`insert into settings (key, value) values ('test_start', '2026-10-01'), ('test_end', '2026-10-30') on conflict (key) do nothing`,
        // One-time move to the new dates (live cycle 1 from 01/11/2026, Test Cycle 01/10 - 30/10/2026).
        // The 'dates_v2' marker makes this run once only, so later changes made in the database are never overwritten.
        () => sql`
          with m as (insert into settings (key, value) values ('dates_v2', '1') on conflict (key) do nothing returning key)
          insert into settings (key, value)
          select k, v from (values ('tracking_start', '2026-11-01'), ('test_start', '2026-10-01'), ('test_end', '2026-10-30')) t(k, v)
          where exists (select 1 from m)
          on conflict (key) do update set value = excluded.value`,
        () => sql`update entries set submitted_by = upper(submitted_by) where submitted_by <> upper(submitted_by)`,
        // Push to DOMS: bookmark tokens, PO categories (from SUMMARY_PO.xlsx), and the pushed purchase orders
        () => sql`create table if not exists push_tokens (account text primary key references accounts(code), token_hash text not null, created_at timestamptz not null default now())`,
        () => sql`create table if not exists po_categories (
                    id serial primary key, name text not null unique, category_id int not null references categories(id),
                    report text not null, attn text not null, sort_order int not null)`,
        () => sql`insert into po_categories (name, category_id, report, attn, sort_order)
                  select u.name, c.id, u.report, u.attn, u.ord
                  from unnest(${po.n}::text[], ${po.c}::text[], ${po.r}::text[], ${po.a}::text[], ${po.o}::int[]) as u(name, cat, report, attn, ord)
                  join categories c on c.name = u.cat
                  on conflict (name) do nothing`,
        // one row per saved (printed) summary report; saving it is what adds the POs to the category budgets
        () => sql`create table if not exists po_reports (
                    id bigserial primary key, account text not null references accounts(code), report text not null,
                    saved_at timestamptz not null default now(), report_date date not null, cycle_no int not null,
                    po_count int not null, total numeric(14,2) not null)`,
        // a pushed PO waits here (report_id null) until it is saved in a summary report; entry_id is filled when that happens
        () => sql`create table if not exists purchase_orders (
                    id bigserial primary key, account text not null references accounts(code), po_no text not null, reference text not null default '',
                    supplier text not null, date_received date, date_verified date, amount numeric(14,2) not null check (amount > 0),
                    po_category_id int not null references po_categories(id), brand text not null default '', remark text not null default '',
                    entry_id bigint references entries(id) on delete cascade, cycle_no int, report_id bigint references po_reports(id),
                    pushed_at timestamptz not null default now(), unique (account, po_no))`,
        () => sql`alter table purchase_orders alter column entry_id drop not null`,
        () => sql`alter table purchase_orders alter column cycle_no drop not null`,
        () => sql`alter table purchase_orders add column if not exists report_id bigint references po_reports(id)`,
        () => sql`create index if not exists po_reports_saved_idx on po_reports (account, saved_at)`,
        () => sql`create index if not exists purchase_orders_report_idx on purchase_orders (report_id)`,
        () => sql`create index if not exists purchase_orders_pushed_idx on purchase_orders (account, pushed_at)`,
        // log of every record adjustment (edit / delete) made by Central Admin; holds before / after values
        () => sql`create table if not exists adjustments (
                    id bigserial primary key, at timestamptz not null default now(), by_account text not null,
                    action text not null check (action in ('edit', 'delete')), entry_id bigint, account text, cycle_no int,
                    category text, department text, value numeric(14,2), submitted_by text,
                    new_category text, new_value numeric(14,2), new_submitted_by text)`,
      ];
      for (const step of steps) {
        try { await step(); } catch (err) { console.error('ensureSchema step failed (continuing):', err.message); }
      }
    })();
  }
  return ready;
}
