import { neon } from '@neondatabase/serverless';
import { ACCOUNT_SEED, ADMIN_HASH, HQ_HASH, LIMITS } from './seed.js';

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
      const steps = [
        // accounts / sign-in (existing entries are given to 1008-SHBN)
        () => sql`create table if not exists accounts (code text primary key, password_hash text not null)`,
        () => sql`insert into accounts (code, password_hash) select * from unnest(${codes}::text[], ${hashes}::text[]) on conflict (code) do nothing`,
        () => sql`insert into settings (key, value) values ('admin_hash', ${ADMIN_HASH}), ('hq_hash', ${HQ_HASH}) on conflict (key) do nothing`,
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
      ];
      for (const step of steps) {
        try { await step(); } catch (err) { console.error('ensureSchema step failed (continuing):', err.message); }
      }
    })();
  }
  return ready;
}
