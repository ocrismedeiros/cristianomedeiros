import { isValidTimeZone, zonedParts, zonedToUtc } from './time.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;
const DAY = 86_400_000;

export function validateConfig(config) {
  const errors = [];
  if (!isValidTimeZone(config.timezone)) errors.push(`timezone inválido: ${config.timezone}`);
  if (!(config.meeting?.durationMinutes > 0)) errors.push('meeting.durationMinutes deve ser > 0');
  if (!(config.slotStepMinutes > 0)) errors.push('slotStepMinutes deve ser > 0');
  if (!(config.bufferMinutes >= 0)) errors.push('bufferMinutes deve ser >= 0');
  if (!(config.daysAhead > 0)) errors.push('daysAhead deve ser > 0');
  for (const key of Object.keys(config.weekly || {})) {
    if (!DAY_KEYS.includes(key)) errors.push(`weekly: dia desconhecido "${key}" (use ${DAY_KEYS.join(', ')})`);
    for (const win of config.weekly[key]) {
      if (!Array.isArray(win) || win.length !== 2 || !HHMM.test(win[0]) || !HHMM.test(win[1]) || win[0] >= win[1]) {
        errors.push(`weekly.${key}: janela inválida ${JSON.stringify(win)} (use ["10:00","17:00"])`);
      }
    }
  }
  if (errors.length) throw new Error('config.json inválido:\n  ' + errors.join('\n  '));
  return config;
}

function hhmm(str) {
  const [, h, m] = HHMM.exec(str);
  return [+h, +m];
}

// The window of instants slots can fall in, for querying busy times.
export function searchRange(config, now) {
  return { from: now, to: now + (config.daysAhead + 1) * DAY };
}

/**
 * Bookable slot start times (UTC ms) for the next `daysAhead` days in the owner's timezone,
 * minus anything that overlaps a busy interval padded by the buffer on both sides.
 * `busy` is a list of { start, end } in UTC ms (Google busy times + existing bookings).
 */
export function generateSlots(config, now, busy) {
  const tz = config.timezone;
  const duration = config.meeting.durationMinutes * MIN;
  const step = config.slotStepMinutes * MIN;
  const buffer = config.bufferMinutes * MIN;
  const earliest = now + (config.minNoticeMinutes || 0) * MIN;
  const blackout = new Set(config.blackoutDates || []);

  const today = zonedParts(now, tz);
  const base = Date.UTC(today.year, today.month - 1, today.day);
  const slots = [];

  for (let i = 0; i < config.daysAhead; i++) {
    const date = new Date(base + i * DAY);
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (blackout.has(iso)) continue;

    for (const [from, to] of config.weekly[DAY_KEYS[date.getUTCDay()]] || []) {
      const windowStart = zonedToUtc(y, m, d, ...hhmm(from), tz);
      const windowEnd = zonedToUtc(y, m, d, ...hhmm(to), tz);
      for (let s = windowStart; s + duration <= windowEnd; s += step) {
        if (s < earliest) continue;
        const e = s + duration;
        if (busy.some((b) => b.start < e + buffer && b.end > s - buffer)) continue;
        slots.push(s);
      }
    }
  }
  return slots;
}

// Remove [start, end) from a list of intervals (used to ignore a booking's own
// Google event while rescheduling it).
export function subtractInterval(intervals, start, end) {
  const out = [];
  for (const b of intervals) {
    if (b.end <= start || b.start >= end) {
      out.push(b);
      continue;
    }
    if (b.start < start) out.push({ start: b.start, end: start });
    if (b.end > end) out.push({ start: end, end: b.end });
  }
  return out;
}
