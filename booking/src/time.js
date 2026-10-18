// Timezone math on top of Intl, no libraries.

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of an instant in a timezone.
export function zonedParts(ms, tz) {
  const parts = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) parts[type] = value;
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour, minute: +parts.minute, second: +parts.second,
  };
}

// Offset of tz from UTC at the given instant, in ms (e.g. -3h for São Paulo).
export function tzOffsetMs(ms, tz) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(whole, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

// The UTC instant at which the wall clock in tz reads y-m-d hh:mm.
export function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMs(guess, tz);
  let ms = guess - offset;
  // Re-check across a DST boundary between the guess and the result.
  const offset2 = tzOffsetMs(ms, tz);
  if (offset2 !== offset) ms = guess - offset2;
  return ms;
}

export function formatInZone(ms, tz, locale, opts = {}) {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(new Date(ms));
}

// "segunda-feira, 19 de outubro de 2026, 10:00 – 10:30 (America/Sao_Paulo)"
export function formatRange(startMs, endMs, tz, locale) {
  const day = formatInZone(startMs, tz, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hm = { hour: '2-digit', minute: '2-digit' };
  return `${day}, ${formatInZone(startMs, tz, locale, hm)} – ${formatInZone(endMs, tz, locale, hm)} (${tz})`;
}
