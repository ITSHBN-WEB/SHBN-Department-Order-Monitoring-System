// Local dev server:  npm run dev  ->  http://localhost:3000
// Uses an in-memory Postgres (PGlite) so you can try the UI without touching Neon.
// Data resets every time you restart. Set DEMO=1 to pre-load sample entries.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { createLocalDb } from './pg.js';
import { todayKL } from '../lib/cycle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = await createLocalDb();

if (process.env.DEMO) {
  // DEMO=1    -> sample entries inside the Test Cycle (default settings, today must be 30/09-14/11/2026)
  // DEMO=live -> pretend live tracking started 12 days ago and add sample entries to cycle 1
  const live = process.env.DEMO === 'live';
  if (live) {
    const start = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
    await sql`update settings set value = ${start} where key = 'tracking_start'`;
  }
  const today = todayKL();
  const cycleNo = live ? 1 : 0;
  const demo = [
    ['BEVERAGES', 120000, 'Aminah'], ['BEVERAGES', 95000, 'Farid'],
    ['CONFECTIONERY', 61000, 'Aminah'], ['RICE', 181500, 'Kirikko'],
    ['MILK POWDER', 90500, 'Farid'], ['FROZEN / CHILL / DAIRY', 150000, 'Siti'],
    ['MEAT & POULTRY', 40250, 'Siti'], ['VEGETABLES', 61000, 'Siti'],
    ['BABY CARE', 70100, 'Kirikko'], ['PET FOOD', 4200, 'Aminah'],
    ['BATTERY / LIGHT SOURCE', 2900, 'Farid'], ['COOKING OIL', 33000, 'Aminah'],
  ];
  for (const [name, value, by] of demo) {
    await sql`insert into entries (category_id, value, submitted_by, entry_date, cycle_no, created_at)
      select id, ${value}, ${by}, ${today}, ${cycleNo}, now() - (random() * interval '10 days') from categories where name = ${name}`;
  }
  console.log('DEMO data loaded into', live ? 'live cycle 1' : 'the Test Cycle');
}

const { default: dashboard } = await import('../api/dashboard.js');
const { default: entries } = await import('../api/entries.js');
const { default: admin } = await import('../api/admin.js');
const routes = { '/api/dashboard': dashboard, '/api/entries': entries, '/api/admin': admin };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[url.pathname];
  if (handler) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.query = Object.fromEntries(url.searchParams);
    try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = undefined; }
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
    return handler(req, res);
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const data = await readFile(join(root, 'public', file));
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(process.env.PORT || 3000, () => console.log('DOMS dev server on http://localhost:' + (process.env.PORT || 3000)));
