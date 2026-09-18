// Pure scheduling logic (no Node/Netlify APIs) so it can be tested anywhere.
// All instants are epoch milliseconds (UTC).

const MIN = 60_000;
const DAY = 86_400_000;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const fmtCache = new Map();
function partsIn(tz, t) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(t))) p[type] = +value;
  return p;
}

// Offset of `tz` at instant t, in ms (wall clock minus UTC).
export function tzOffset(tz, t) {
  const p = partsIn(tz, t);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return wall - Math.floor(t / 1000) * 1000;
}

// Wall-clock time in `tz` -> UTC instant.
export function wallToUtc(tz, y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffset(tz, guess);
  const off = tzOffset(tz, t);
  if (guess - off !== t) t = guess - off;
  return t;
}

// Calendar date (in tz) of instant t, as a UTC-midnight timestamp for easy day stepping.
function dayIn(tz, t) {
  const p = partsIn(tz, t);
  return Date.UTC(p.year, p.month - 1, p.day);
}

export const iso = t => new Date(t).toISOString().replace(".000Z", "Z");

/**
 * Open start times for `event` within [rangeStart, rangeEnd).
 * getBusy(from, to) -> Promise<[startMs, endMs][]> of existing commitments.
 */
export async function computeSlots(cfg, event, rangeStart, rangeEnd, getBusy, now = Date.now()) {
  const tz = cfg.timezone;
  const dur = event.duration * MIN;
  const step = (cfg.slot_interval || event.duration) * MIN;
  const buf = (cfg.buffer_minutes || 0) * MIN;
  const lo = Math.max(rangeStart, now + (cfg.min_notice_hours || 0) * 3_600_000);
  const hi = Math.min(rangeEnd, now + (cfg.max_days_ahead ?? 60) * DAY);
  if (lo >= hi) return [];

  const busy = await getBusy(lo - buf, hi + dur + buf);
  const slots = [];
  for (let day = dayIn(tz, lo) - DAY, last = dayIn(tz, hi); day <= last; day += DAY) {
    const dt = new Date(day);
    const [Y, M, D] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    for (const [ws, we] of cfg.working_hours[WEEKDAYS[dt.getUTCDay()]] || []) {
      const [sh, sm] = ws.split(":").map(Number);
      const [eh, em] = we.split(":").map(Number);
      const wEnd = wallToUtc(tz, Y, M, D, eh, em);
      for (let t = wallToUtc(tz, Y, M, D, sh, sm); t + dur <= wEnd; t += step) {
        if (t < lo || t >= hi) continue;
        const tEnd = t + dur;
        if (!busy.some(([bs, be]) => bs - buf < tEnd && be + buf > t)) slots.push(t);
      }
    }
  }
  return slots;
}

// Deterministic fake meetings so the page is usable before Google is connected.
export function demoBusy(tz, start, end) {
  const busy = [];
  for (let day = dayIn(tz, start); day <= dayIn(tz, end); day += DAY) {
    const dt = new Date(day);
    let h = 2166136261;
    for (const c of dt.toISOString().slice(0, 10)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    for (let i = 0; i <= h % 3; i++) {
      const hour = 9 + ((h >>> (i * 4)) % 8);
      const s = wallToUtc(tz, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), hour, 0);
      busy.push([s, s + ((h >>> i) & 1 ? 60 : 30) * MIN]);
    }
  }
  return busy;
}
