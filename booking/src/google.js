import { randomUUID } from 'node:crypto';

// Google Calendar over plain REST + fetch (no googleapis SDK).
// The refresh token lives in the SQLite settings table; the access token in memory.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events', // create/update/delete the booking events
  'https://www.googleapis.com/auth/calendar.readonly', // free/busy on the calendars that block slots
];
const REFRESH_KEY = 'google_refresh_token';

export class GoogleError extends Error {}

export function createGoogle({ env, config, db, log = console }) {
  const enabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const redirectUri = `${env.PUBLIC_URL}/auth/google/callback`;
  const calendarId = encodeURIComponent(config.google?.calendarId || 'primary');
  const busyCalendars = config.google?.busyCalendars || ['primary'];
  const sendUpdates = config.google?.sendUpdates || 'all';
  let access = null; // { token, expiresAt }

  function isConnected() {
    return enabled && Boolean(db.getSetting(REFRESH_KEY));
  }

  function authUrl(state) {
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent', // always return a refresh token
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params}`;
  }

  async function tokenRequest(body) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(`token: ${res.status} ${json.error || ''} ${json.error_description || ''}`.trim());
    return json;
  }

  async function exchangeCode(code) {
    const json = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
    if (!json.refresh_token) throw new GoogleError('Google não devolveu refresh_token. Revogue o acesso em myaccount.google.com/permissions e conecte de novo.');
    db.setSetting(REFRESH_KEY, json.refresh_token);
    access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  }

  async function accessToken() {
    if (access && access.expiresAt > Date.now()) return access.token;
    const refresh = db.getSetting(REFRESH_KEY);
    if (!refresh) throw new GoogleError('Google Calendar não conectado (abra /admin para conectar).');
    const json = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' });
    access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
    return access.token;
  }

  async function call(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(`${method} ${path.split('?')[0]}: ${res.status} ${json.error?.message || ''}`.trim());
    return json;
  }

  async function busy(from, to) {
    const json = await call('POST', '/freeBusy', {
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      items: busyCalendars.map((id) => ({ id })),
    });
    const out = [];
    for (const [id, cal] of Object.entries(json.calendars || {})) {
      if (cal.errors?.length) throw new GoogleError(`freeBusy ${id}: ${cal.errors.map((e) => e.reason).join(', ')}`);
      for (const b of cal.busy || []) out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
    }
    return out;
  }

  function meetLinkOf(event) {
    return event?.hangoutLink || event?.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || null;
  }

  async function createEvent(booking) {
    let event = await call('POST', `/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=${sendUpdates}`, {
      summary: `${config.meeting.title} · ${booking.name}`,
      description: [config.meeting.description, booking.note && `Nota do convidado:\n${booking.note}`].filter(Boolean).join('\n\n'),
      start: { dateTime: new Date(booking.start_ms).toISOString(), timeZone: config.timezone },
      end: { dateTime: new Date(booking.end_ms).toISOString(), timeZone: config.timezone },
      attendees: [{ email: booking.email, displayName: booking.name }],
      conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      extendedProperties: { private: { bookingId: booking.id } },
      reminders: { useDefault: true },
    });
    // Meet creation is usually synchronous, but the API allows it to be "pending".
    for (let i = 0; i < 3 && !meetLinkOf(event); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      event = await call('GET', `/calendars/${calendarId}/events/${encodeURIComponent(event.id)}`);
    }
    return { eventId: event.id, meetLink: meetLinkOf(event) };
  }

  async function moveEvent(eventId, booking) {
    await call('PATCH', `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`, {
      start: { dateTime: new Date(booking.start_ms).toISOString(), timeZone: config.timezone },
      end: { dateTime: new Date(booking.end_ms).toISOString(), timeZone: config.timezone },
    });
  }

  async function deleteEvent(eventId) {
    try {
      await call('DELETE', `/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`);
    } catch (err) {
      if (!/: 410\b|: 404\b/.test(err.message)) throw err; // already gone is fine
    }
  }

  function disconnect() {
    db.deleteSetting(REFRESH_KEY);
    access = null;
  }

  return { enabled, isConnected, authUrl, exchangeCode, busy, createEvent, moveEvent, deleteEvent, disconnect, redirectUri };
}
