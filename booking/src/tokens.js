import { createHmac, timingSafeEqual } from 'node:crypto';

// Manage links look like /b/<bookingId>.<signature>. Whoever holds the link can
// view, cancel or reschedule that one booking; nothing else.

function sign(secret, bookingId) {
  return createHmac('sha256', secret).update(`booking:${bookingId}`).digest('base64url').slice(0, 32);
}

export function makeToken(secret, bookingId) {
  return `${bookingId}.${sign(secret, bookingId)}`;
}

// Returns the booking id, or null if the token is malformed or forged.
export function verifyToken(secret, token) {
  if (typeof token !== 'string') return null;
  const [id, sig, extra] = token.split('.');
  if (!id || !sig || extra !== undefined || !/^[a-f0-9]{16,64}$/.test(id)) return null;
  const expected = Buffer.from(sign(secret, id));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}

// Signed, short-lived OAuth state so /auth/google/callback can't be driven by a third party.
export function makeState(secret, now = Date.now()) {
  const payload = String(now);
  return `${payload}.${createHmac('sha256', secret).update(`state:${payload}`).digest('base64url')}`;
}

export function verifyState(secret, state, now = Date.now(), maxAgeMs = 10 * 60_000) {
  if (typeof state !== 'string') return false;
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`state:${payload}`).digest('base64url'));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const age = now - Number(payload);
  return age >= 0 && age <= maxAgeMs;
}
