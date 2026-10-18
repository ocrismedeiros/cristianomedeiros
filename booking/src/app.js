import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateSlots, searchRange, subtractInterval } from './availability.js';
import { bookingEmails } from './mailer.js';
import { isValidTimeZone } from './time.js';
import { makeState, makeToken, verifyState, verifyToken } from './tokens.js';
import * as views from './views.js';

const STATIC = {
  '/app.js': ['text/javascript; charset=utf-8', readFileSync(new URL('../public/app.js', import.meta.url))],
  '/style.css': ['text/css; charset=utf-8', readFileSync(new URL('../public/style.css', import.meta.url))],
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', // manage tokens live in URLs; never leak them to the Meet link etc.
};
const EMAIL = /^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]{2,}$/;
const BUSY_CACHE_MS = 60_000;
const ALERT_EVERY_MS = 60 * 60_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ env, config, db, google, mailer, log = console, now = () => Date.now() }) {
  const duration = config.meeting.durationMinutes * 60_000;
  let busyCache = null; // { at, busy }
  let lastAlert = 0;
  const hits = new Map(); // ip -> [timestamps], for POST rate limiting

  // --- availability --------------------------------------------------------

  async function googleBusy({ fresh }) {
    if (!google.enabled) return [];
    if (!google.isConnected()) throw new HttpError(503, 'A agenda está temporariamente indisponível. Tente novamente mais tarde.');
    const t = now();
    if (!fresh && busyCache && t - busyCache.at < BUSY_CACHE_MS) return busyCache.busy;
    const { from, to } = searchRange(config, t);
    try {
      const busy = await google.busy(from, to);
      busyCache = { at: t, busy };
      return busy;
    } catch (err) {
      log.error('[google] free/busy falhou:', err.message);
      alertOwner(`Não consegui ler sua agenda do Google: ${err.message}\nA página de reservas está sem horários até isso ser resolvido. Reconecte em ${env.PUBLIC_URL}/admin`);
      throw new HttpError(503, 'A agenda está temporariamente indisponível. Tente novamente em alguns minutos.');
    }
  }

  // Must be called with Google busy times already fetched: everything from here
  // to the write is synchronous, so two requests can't both take the same slot.
  function openSlots(gBusy, exclude = null) {
    const t = now();
    const { from, to } = searchRange(config, t);
    const g = exclude ? subtractInterval(gBusy, exclude.start_ms, exclude.end_ms) : gBusy;
    return generateSlots(config, t, [...g, ...db.busyBookings(from - duration, to + duration, exclude?.id)]);
  }

  function alertOwner(text) {
    if (now() - lastAlert < ALERT_EVERY_MS || !env.OWNER_EMAIL) return;
    lastAlert = now();
    mailer.send({ to: env.OWNER_EMAIL, subject: '⚠ Página de reservas: problema com o Google Calendar', text })
      .catch((err) => log.error('[mail] alerta falhou:', err.message));
  }

  // --- side effects --------------------------------------------------------

  const manageUrl = (id) => `${env.PUBLIC_URL}/b/${makeToken(env.SIGNING_SECRET, id)}`;

  function notify(kind, booking, previous) {
    for (const msg of bookingEmails({ kind, booking, previous, manageUrl: manageUrl(booking.id), config, env })) {
      mailer.send(msg).catch((err) => log.error(`[mail] ${kind} para ${msg.to} falhou:`, err.message));
    }
  }

  async function syncGoogle(kind, booking) {
    if (!google.isConnected()) return;
    try {
      // A reschedule of a booking whose event never got created creates it now.
      if (kind === 'booked' || (kind === 'rescheduled' && !booking.google_event_id)) {
        const { eventId, meetLink } = await google.createEvent(booking);
        db.setGoogle(booking.id, eventId, meetLink, null);
      } else if (kind === 'rescheduled') {
        await google.moveEvent(booking.google_event_id, booking);
        db.setGoogle(booking.id, booking.google_event_id, booking.meet_link, null);
      } else if (booking.google_event_id && kind === 'cancelled') {
        await google.deleteEvent(booking.google_event_id);
      }
    } catch (err) {
      log.error(`[google] ${kind} ${booking.id} falhou:`, err.message);
      db.setGoogle(booking.id, booking.google_event_id, booking.meet_link, err.message);
    }
  }

  // --- input ---------------------------------------------------------------

  async function readForm(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) throw new HttpError(413, 'Formulário muito grande.');
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
  const oneLine = (s, max) => clean(s, max).replace(/\s+/g, ' ');

  function rateLimit(req) {
    // Behind a reverse proxy every request comes from the proxy; use the client IP it forwards.
    const forwarded = env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
    const ip = forwarded || req.socket.remoteAddress || '?';
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < 10 * 60_000);
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 10_000) hits.clear();
    if (recent.length > 20) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  }

  function bookingFromToken(token) {
    const id = verifyToken(env.SIGNING_SECRET, token);
    const booking = id && db.getBooking(id);
    if (!booking) throw new HttpError(404, 'Link inválido ou expirado.');
    return booking;
  }

  function requireModifiable(booking) {
    if (booking.status === 'cancelled') throw new HttpError(410, 'Esta reunião já foi cancelada.');
    if (booking.start_ms <= now()) throw new HttpError(410, 'Esta reunião já aconteceu ou está em andamento.');
  }

  function requireAdmin(url) {
    const given = Buffer.from(url.searchParams.get('key') || '');
    const expected = Buffer.from(env.ADMIN_KEY || '');
    if (!env.ADMIN_KEY || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(404, 'Página não encontrada.');
    }
    return env.ADMIN_KEY;
  }

  // --- handlers ------------------------------------------------------------

  async function createBooking(req, res) {
    rateLimit(req);
    const form = await readForm(req);
    if (form.get('website')) return redirect(res, '/'); // honeypot
    const name = oneLine(form.get('name'), 100);
    const email = oneLine(form.get('email'), 254).toLowerCase();
    const note = clean(form.get('note'), 1000);
    const tz = isValidTimeZone(form.get('tz')) ? form.get('tz') : config.timezone;
    const start = Date.parse(form.get('start') || '');
    const fail = (msg) => html(res, 400, views.bookingPage(config, { error: msg }));
    if (!name) return fail('Informe seu nome.');
    if (!EMAIL.test(email)) return fail('Informe um e-mail válido.');

    const gBusy = await googleBusy({ fresh: true });
    if (!openSlots(gBusy).includes(start)) {
      return html(res, 409, views.bookingPage(config, { error: 'Esse horário acabou de ficar indisponível. Escolha outro.' }));
    }
    const id = randomBytes(12).toString('hex');
    db.insertBooking({ id, name, email, note, visitor_tz: tz, start_ms: start, end_ms: start + duration });
    busyCache = null;
    log.info(`[booking] ${id} ${new Date(start).toISOString()} ${email}`);

    await syncGoogle('booked', db.getBooking(id));
    notify('booked', db.getBooking(id));
    redirect(res, `/b/${makeToken(env.SIGNING_SECRET, id)}?done=booked`);
  }

  async function reschedule(req, res, token) {
    rateLimit(req);
    const booking = bookingFromToken(token);
    requireModifiable(booking);
    const form = await readForm(req);
    const start = Date.parse(form.get('start') || '');
    const gBusy = await googleBusy({ fresh: true });
    if (!openSlots(gBusy, booking).includes(start)) {
      return html(res, 409, views.bookingPage(config, { mode: 'reschedule', token, booking, error: 'Esse horário acabou de ficar indisponível. Escolha outro.' }));
    }
    db.rescheduleBooking(booking.id, start, start + duration);
    busyCache = null;
    const updated = db.getBooking(booking.id);
    log.info(`[booking] ${booking.id} reagendada para ${new Date(start).toISOString()}`);

    await syncGoogle('rescheduled', updated);
    notify('rescheduled', db.getBooking(booking.id), booking);
    redirect(res, `/b/${token}?done=rescheduled`);
  }

  async function cancel(req, res, token) {
    rateLimit(req);
    const booking = bookingFromToken(token);
    requireModifiable(booking);
    db.cancelBooking(booking.id);
    busyCache = null;
    log.info(`[booking] ${booking.id} cancelada`);
    const cancelled = db.getBooking(booking.id);
    await syncGoogle('cancelled', cancelled);
    notify('cancelled', cancelled);
    redirect(res, `/b/${token}`);
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && STATIC[pathname]) {
      const [type, body] = STATIC[pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=300' });
      return res.end(body);
    }
    if (method === 'GET' && pathname === '/') return html(res, 200, views.bookingPage(config));
    if (method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, google: google.isConnected() });

    if (method === 'GET' && pathname === '/api/slots') {
      const token = url.searchParams.get('token');
      const exclude = token ? bookingFromToken(token) : null;
      const slots = openSlots(await googleBusy({ fresh: false }), exclude?.status === 'confirmed' ? exclude : null);
      return json(res, 200, { slots, durationMinutes: config.meeting.durationMinutes, ownerTimezone: config.timezone });
    }
    if (method === 'POST' && pathname === '/book') return createBooking(req, res);

    const m = /^\/b\/([^/]+)(\/cancel|\/reschedule)?$/.exec(pathname);
    if (m) {
      const [, token, action] = m;
      if (method === 'GET' && !action) {
        const flash = { booked: 'Reunião confirmada', rescheduled: 'Reunião reagendada' }[url.searchParams.get('done')];
        return html(res, 200, views.managePage(config, bookingFromToken(token), token, { flash }));
      }
      if (method === 'GET' && action === '/cancel') {
        const booking = bookingFromToken(token);
        requireModifiable(booking);
        return html(res, 200, views.cancelPage(config, booking, token));
      }
      if (method === 'GET' && action === '/reschedule') {
        const booking = bookingFromToken(token);
        requireModifiable(booking);
        return html(res, 200, views.bookingPage(config, { mode: 'reschedule', token, booking }));
      }
      // Cancelling only happens on POST, so email link scanners that prefetch GETs can't cancel.
      if (method === 'POST' && action === '/cancel') return cancel(req, res, token);
      if (method === 'POST' && action === '/reschedule') return reschedule(req, res, token);
    }

    if (method === 'GET' && pathname === '/admin') {
      const key = requireAdmin(url);
      return html(res, 200, views.adminPage(config, {
        key,
        google: { enabled: google.enabled, connected: google.isConnected(), redirectUri: google.redirectUri },
        bookings: db.upcomingBookings(now()),
        flash: { connected: 'Google Calendar conectado.', disconnected: 'Google Calendar desconectado.' }[url.searchParams.get('done')],
      }));
    }
    if (method === 'GET' && pathname === '/auth/google') {
      requireAdmin(url);
      if (!google.enabled) throw new HttpError(400, 'Preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env.');
      return redirect(res, google.authUrl(makeState(env.SIGNING_SECRET, now())));
    }
    if (method === 'GET' && pathname === '/auth/google/callback') {
      if (!verifyState(env.SIGNING_SECRET, url.searchParams.get('state'), now())) throw new HttpError(400, 'Estado OAuth inválido ou expirado. Tente conectar de novo.');
      if (url.searchParams.get('error')) throw new HttpError(400, `Google recusou: ${url.searchParams.get('error')}`);
      await google.exchangeCode(url.searchParams.get('code'));
      busyCache = null;
      log.info('[google] conectado');
      return redirect(res, `/admin?key=${encodeURIComponent(env.ADMIN_KEY)}&done=connected`);
    }
    if (method === 'POST' && pathname === '/admin/google/disconnect') {
      requireAdmin(url);
      google.disconnect();
      return redirect(res, `/admin?key=${encodeURIComponent(env.ADMIN_KEY)}&done=disconnected`);
    }

    throw new HttpError(404, 'Página não encontrada.');
  }

  return async function handler(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    try {
      await route(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error(err);
      const message = status === 500 ? 'Algo deu errado. Tente novamente.' : err.message;
      if (res.headersSent) return res.end();
      if (url.pathname.startsWith('/api/')) return json(res, status, { error: message });
      html(res, status, views.messagePage(status === 404 ? 'Não encontrado' : 'Não foi possível concluir', message, 'error'));
    }
  };
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}
