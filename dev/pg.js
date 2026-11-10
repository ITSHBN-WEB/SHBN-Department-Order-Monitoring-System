// Local-only helper: an in-memory Postgres (PGlite) exposing the same tagged-template
// interface as the Neon driver. Never used in production.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function createLocalDb() {
  // Like Neon / node-postgres, return bigint (int8) columns as strings so tests catch id-type bugs.
  const db = new PGlite({ parsers: { 20: (v) => v } });
  await db.exec(readFileSync(join(root, 'db/setup.sql'), 'utf8'));
  const sql = (strings, ...vals) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < vals.length ? `$${i + 1}` : ''), '');
    return db.query(text, vals).then((r) => r.rows);
  };
  sql.raw = (text) => db.exec(text);
  globalThis.__DOMS_SQL__ = sql;
  return sql;
}
