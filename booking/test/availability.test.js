import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSlots, subtractInterval, validateConfig } from '../src/availability.js';
import { tzOffsetMs, zonedToUtc } from '../src/time.js';

const H = 3_600_000;
const M = 60_000;
const base = {
  timezone: 'America/Sao_Paulo',
  meeting: { durationMinutes: 30 },
  slotStepMinutes: 30,
  bufferMinutes: 15,
  daysAhead: 14,
  minNoticeMinutes: 0,
  weekly: { mon: [['10:00', '17:00']], tue: [['10:00', '17:00']], wed: [['10:00', '17:00']], thu: [['10:00', '17:00']], fri: [['10:00', '17:00']] },
};
const iso = (ms) => new Date(ms).toISOString();

test('zonedToUtc handles fixed offset and DST zones', () => {
  assert.equal(iso(zonedToUtc(2026, 10, 19, 10, 0, 'America/Sao_Paulo')), '2026-10-19T13:00:00.000Z');
  // New York: EDT (-4) before Nov 1 2026, EST (-5) after.
  assert.equal(iso(zonedToUtc(2026, 10, 30, 10, 0, 'America/New_York')), '2026-10-30T14:00:00.000Z');
  assert.equal(iso(zonedToUtc(2026, 11, 2, 10, 0, 'America/New_York')), '2026-11-02T15:00:00.000Z');
  assert.equal(tzOffsetMs(Date.parse('2026-07-01T00:00:00Z'), 'Europe/Lisbon'), 1 * H);
});

test('weekday windows produce 14 slots per day, none on weekends', () => {
  const now = Date.parse('2026-10-19T03:00:00Z'); // Monday 00:00 in São Paulo
  const slots = generateSlots(base, now, []);
  assert.equal(slots.length, 10 * 14); // 10 weekdays in 14 days, 10:00–16:30 every 30 min
  assert.equal(iso(slots[0]), '2026-10-19T13:00:00.000Z');
  assert.equal(iso(slots[13]), '2026-10-19T19:30:00.000Z'); // last slot 16:30 local, ends at 17:00
  assert.ok(!slots.some((s) => [0, 6].includes(new Date(s - 3 * H).getUTCDay())));
});

test('busy intervals block overlapping slots plus buffer', () => {
  const now = Date.parse('2026-10-19T03:00:00Z');
  const busy = [{ start: Date.parse('2026-10-19T14:00:00Z'), end: Date.parse('2026-10-19T14:30:00Z') }]; // 11:00–11:30 local
  const day = generateSlots(base, now, busy).filter((s) => s < Date.parse('2026-10-20T00:00:00Z')).map(iso);
  // 10:30 ends 11:00 but the 15-min buffer touches the meeting; 11:00 overlaps; 11:30 starts inside buffer.
  assert.ok(day.includes('2026-10-19T13:00:00.000Z')); // 10:00
  assert.ok(!day.includes('2026-10-19T13:30:00.000Z')); // 10:30
  assert.ok(!day.includes('2026-10-19T14:00:00.000Z')); // 11:00
  assert.ok(!day.includes('2026-10-19T14:30:00.000Z')); // 11:30
  assert.ok(day.includes('2026-10-19T15:00:00.000Z')); // 12:00
});

test('min notice, blackout dates and today-only remainder', () => {
  const now = Date.parse('2026-10-19T15:10:00Z'); // Monday 12:10 local
  const cfg = { ...base, minNoticeMinutes: 60, blackoutDates: ['2026-10-20'] };
  const slots = generateSlots(cfg, now, []);
  assert.equal(iso(slots[0]), '2026-10-19T16:30:00.000Z'); // 13:30 is the first slot ≥ 13:10
  assert.ok(!slots.some((s) => iso(s).startsWith('2026-10-20')));
});

test('subtractInterval removes a booking from merged busy blocks', () => {
  const out = subtractInterval([{ start: 0, end: 90 * M }], 30 * M, 60 * M);
  assert.deepEqual(out, [{ start: 0, end: 30 * M }, { start: 60 * M, end: 90 * M }]);
});

test('validateConfig rejects bad windows and timezones', () => {
  assert.throws(() => validateConfig({ ...base, timezone: 'Mars/Base' }), /timezone/);
  assert.throws(() => validateConfig({ ...base, weekly: { mon: [['17:00', '10:00']] } }), /janela/);
  assert.throws(() => validateConfig({ ...base, weekly: { monday: [] } }), /desconhecido/);
});
