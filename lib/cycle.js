// Tracking-cycle maths. All dates are plain 'YYYY-MM-DD' strings (Asia/Kuala_Lumpur calendar).
const DAY = 86400000;
const TZ = 'Asia/Kuala_Lumpur';

const toUTC = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Today's calendar date in Kuala Lumpur, e.g. '2026-11-15'. */
export function todayKL(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

export async function loadSettings(sql) {
  const rows = await sql`select key, value from settings`;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const days = parseInt(m.cycle_days, 10);
  return {
    start: /^\d{4}-\d{2}-\d{2}$/.test(m.tracking_start || '') ? m.tracking_start : '2026-11-15',
    days: days > 0 ? days : 45,
  };
}

/** Which cycle is 'today' in? current = 0 when tracking has not started yet. */
export function currentCycle(settings, today) {
  const diff = Math.round((toUTC(today) - toUTC(settings.start)) / DAY);
  return {
    started: diff >= 0,
    current: diff >= 0 ? Math.floor(diff / settings.days) + 1 : 0,
    daysUntilStart: diff < 0 ? -diff : 0,
    diff,
  };
}

/** Date range + progress for cycle n (viewed relative to today). */
export function describeCycle(settings, n, today) {
  const startMs = toUTC(settings.start) + (n - 1) * settings.days * DAY;
  const endMs = startMs + (settings.days - 1) * DAY;
  const t = toUTC(today);
  let status = 'active';
  if (t < startMs) status = 'upcoming';
  else if (t > endMs) status = 'closed';
  const dayNumber =
    status === 'active' ? Math.round((t - startMs) / DAY) + 1 : status === 'closed' ? settings.days : 0;
  return {
    n,
    start: fromUTC(startMs),
    end: fromUTC(endMs),
    days: settings.days,
    status,
    dayNumber,
    daysLeft: status === 'active' ? settings.days - dayNumber : status === 'upcoming' ? settings.days : 0,
  };
}
