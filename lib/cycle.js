// Tracking-cycle maths. All dates are plain 'YYYY-MM-DD' strings (Asia/Kuala_Lumpur calendar).
//   cycle_no 0  = the Test Cycle (practice data, kept separate from live cycles)
//   cycle_no 1+ = live 45-day cycles, starting at settings.start
const DAY = 86400000;
const TZ = 'Asia/Kuala_Lumpur';

const toUTC = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/** Today's calendar date in Kuala Lumpur, e.g. '2026-11-15'. */
export function todayKL(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

export async function loadSettings(sql) {
  const rows = await sql`select key, value from settings`;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const days = parseInt(m.cycle_days, 10);
  const test = isDate(m.test_start) && isDate(m.test_end) && m.test_start <= m.test_end
    ? { start: m.test_start, end: m.test_end } : null;
  return {
    start: isDate(m.tracking_start) ? m.tracking_start : '2026-11-15',
    days: days > 0 ? days : 45,
    test,
  };
}

/**
 * Where are we today?
 *  phase 'live'     -> inside a live cycle (current = 1, 2, ...)
 *  phase 'test'     -> inside the Test Cycle window (current = 0)
 *  phase 'upcoming' -> nothing open yet (current = null)
 */
export function currentCycle(settings, today) {
  const diff = Math.round((toUTC(today) - toUTC(settings.start)) / DAY);
  if (diff >= 0) {
    return { phase: 'live', started: true, current: Math.floor(diff / settings.days) + 1, opensOn: settings.start, daysUntilStart: 0 };
  }
  const t = settings.test;
  if (t && today >= t.start && today <= t.end) {
    return { phase: 'test', started: true, current: 0, opensOn: t.start, daysUntilStart: 0 };
  }
  const opensOn = t && today < t.start ? t.start : settings.start;
  return {
    phase: 'upcoming', started: false, current: null, opensOn,
    daysUntilStart: Math.round((toUTC(opensOn) - toUTC(today)) / DAY),
  };
}

/** Date range + progress for cycle n (0 = Test Cycle), relative to today. */
export function describeCycle(settings, n, today) {
  let startMs, endMs, days;
  if (n === 0 && settings.test) {
    startMs = toUTC(settings.test.start);
    endMs = toUTC(settings.test.end);
    days = Math.round((endMs - startMs) / DAY) + 1;
  } else {
    days = settings.days;
    startMs = toUTC(settings.start) + (n - 1) * days * DAY;
    endMs = startMs + (days - 1) * DAY;
  }
  const t = toUTC(today);
  let status = 'active';
  if (t < startMs) status = 'upcoming';
  else if (t > endMs) status = 'closed';
  const dayNumber = status === 'active' ? Math.round((t - startMs) / DAY) + 1 : status === 'closed' ? days : 0;
  return {
    n, test: n === 0, start: fromUTC(startMs), end: fromUTC(endMs), days, status, dayNumber,
    daysLeft: status === 'active' ? days - dayNumber : status === 'upcoming' ? days : 0,
  };
}
