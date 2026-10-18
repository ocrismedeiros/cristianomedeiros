import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { makeToken, verifyToken } from '../src/tokens.js';

const SECRET = 'x'.repeat(40);
const config = {
  owner: { name: 'Teste' },
  timezone: 'America/Sao_Paulo',
  locale: 'pt-BR',
  meeting: { title: 'Reunião', description: '', durationMinutes: 30 },
  slotStepMinutes: 30, bufferMinutes: 15, daysAhead: 14, minNoticeMinutes: 0,
  weekly: { mon: [['10:00', '17:00']], tue: [['10:00', '17:00']] },
  google: {},
};
const NOW = Date.parse('2026-10-19T03:00:00Z'); // Monday 00:00 São Paulo
const SLOT = '2026-10-19T13:00:00.000Z'; // Monday 10:00 local

const sent = [];
const gcal = { events: new Map(), busyList: [] };
const google = {
  enabled: true,
  redirectUri: 'http://test/auth/google/callback',
  isConnected: () => true,
  busy: async () => gcal.busyList,
  createEvent: async (b) => { gcal.events.set('ev1', { ...b }); return { eventId: 'ev1', meetLink: 'https://meet.google.com/abc-defg-hij' }; },
  moveEvent: async (id, b) => gcal.events.set(id, { ...b }),
  deleteEvent: async (id) => gcal.events.delete(id),
};
const env = { SIGNING_SECRET: SECRET, PUBLIC_URL: 'http://test', OWNER_EMAIL: 'owner@example.com', ADMIN_KEY: 'k' };
const quiet = { info() {}, warn() {}, error() {} };
let server, base;

before(async () => {
  const db = openDb(':memory:');
  server = createServer(createApp({ env, config, db, google, mailer: { send: async (m) => sent.push(m) }, log: quiet, now: () => NOW }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, fields) => fetch(base + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
});
const slots = async (q = '') => (await (await fetch(`${base}/api/slots${q}`)).json()).slots.map((s) => new Date(s).toISOString());

test('tokens reject tampering', () => {
  const t = makeToken(SECRET, 'a'.repeat(24));
  assert.equal(verifyToken(SECRET, t), 'a'.repeat(24));
  assert.equal(verifyToken(SECRET, t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null);
  assert.equal(verifyToken('y'.repeat(40), t), null);
});

test('book → confirm → reschedule → cancel', async () => {
  assert.ok((await slots()).includes(SLOT));

  // Booking
  let res = await post('/book', { name: 'Ana', email: 'ana@example.com', note: 'Oi <b>', start: SLOT, tz: 'Europe/Lisbon' });
  assert.equal(res.status, 303);
  const manage = res.headers.get('location').split('?')[0];
  const token = manage.slice(3);
  let page = await (await fetch(base + manage)).text();
  assert.match(page, /meet\.google\.com\/abc-defg-hij/);
  assert.match(page, /14:00/); // 10:00 São Paulo = 14:00 Lisbon (WEST)
  assert.match(page, /Oi &lt;b&gt;/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['ana@example.com', 'owner@example.com']);
  assert.match(sent[0].text, new RegExp(`/b/${token.replace('.', '\\.')}/cancel`));

  // Slot and its neighbour (buffer) are gone; double booking is refused.
  const after1 = await slots();
  assert.ok(!after1.includes(SLOT));
  assert.ok(!after1.includes('2026-10-19T13:30:00.000Z'));
  res = await post('/book', { name: 'Bia', email: 'bia@example.com', start: SLOT, tz: 'UTC' });
  assert.equal(res.status, 409);

  // When rescheduling, the booking's own slot is offered again.
  gcal.busyList = [{ start: Date.parse(SLOT), end: Date.parse(SLOT) + 30 * 60_000 }]; // its own Google event
  assert.ok((await slots(`?token=${token}`)).includes(SLOT));
  res = await post(`/b/${token}/reschedule`, { start: '2026-10-20T15:00:00.000Z' });
  assert.equal(res.status, 303);
  assert.equal(new Date(gcal.events.get('ev1').start_ms).toISOString(), '2026-10-20T15:00:00.000Z');
  assert.equal(sent.length, 4);
  assert.match(sent[2].subject, /reagendada/i);
  gcal.busyList = [];

  // GET on the cancel link only asks for confirmation.
  page = await (await fetch(`${base}/b/${token}/cancel`)).text();
  assert.match(page, /Cancelar esta reunião\?/);
  assert.ok(gcal.events.has('ev1'));
  res = await post(`/b/${token}/cancel`, {});
  assert.equal(res.status, 303);
  assert.ok(!gcal.events.has('ev1'));
  assert.ok((await slots()).includes('2026-10-20T15:00:00.000Z'));
  res = await post(`/b/${token}/cancel`, {});
  assert.equal(res.status, 410);
});

test('validation and forged links', async () => {
  assert.equal((await post('/book', { name: '', email: 'a@b.co', start: SLOT })).status, 400);
  assert.equal((await post('/book', { name: 'X', email: 'nope', start: SLOT })).status, 400);
  assert.equal((await post('/book', { name: 'X', email: 'x@example.com', start: '2026-10-19T13:10:00.000Z' })).status, 409);
  assert.equal((await post('/book', { name: 'X', email: 'x@example.com', start: '2026-10-24T13:00:00.000Z' })).status, 409); // Saturday
  assert.equal((await fetch(`${base}/b/${'a'.repeat(24)}.forged`)).status, 404);
  assert.equal((await fetch(`${base}/admin?key=wrong`)).status, 404);
  assert.equal((await fetch(`${base}/admin?key=k`)).status, 200);
});
