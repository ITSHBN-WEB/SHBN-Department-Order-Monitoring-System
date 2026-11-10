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
