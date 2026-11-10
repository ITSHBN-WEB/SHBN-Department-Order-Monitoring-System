import { neon } from '@neondatabase/serverless';

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
      const steps = [
        () => sql`alter table entries add column if not exists request_id uuid`,
        () => sql`create unique index if not exists entries_request_id_uq on entries (request_id)`,
        () => sql`insert into settings (key, value) values ('test_start', '2026-09-30'), ('test_end', '2026-11-14') on conflict (key) do nothing`,
        () => sql`update entries set submitted_by = upper(submitted_by) where submitted_by <> upper(submitted_by)`,
      ];
      for (const step of steps) {
        try { await step(); } catch (err) { console.error('ensureSchema step failed (continuing):', err.message); }
      }
    })();
  }
  return ready;
}
