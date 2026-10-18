import { formatRange } from './time.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body, { script = false } = {}) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
${script ? '<script src="/app.js" defer></script>' : ''}
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

function header(config) {
  return `<header>
  <p class="owner">${esc(config.owner.name)}</p>
  <h1>${esc(config.meeting.title)}</h1>
  <p class="meta">${config.meeting.durationMinutes} min · Google Meet</p>
</header>`;
}

export function bookingPage(config, { mode = 'new', token = '', booking = null, error = '' } = {}) {
  const action = mode === 'reschedule' ? `/b/${esc(token)}/reschedule` : '/book';
  const intro = mode === 'reschedule'
    ? `<p class="notice">Reagendando: <strong>${esc(formatRange(booking.start_ms, booking.end_ms, booking.visitor_tz, config.locale))}</strong>. Escolha o novo horário.</p>`
    : (config.meeting.description ? `<p>${esc(config.meeting.description)}</p>` : '');
  const fields = mode === 'reschedule' ? '' : `
    <label>Nome <input name="name" required maxlength="100" autocomplete="name"></label>
    <label>E-mail <input name="email" type="email" required maxlength="254" autocomplete="email"></label>
    <label>Nota <span class="hint">(opcional)</span> <textarea name="note" maxlength="1000" rows="3" placeholder="Sobre o que vamos conversar?"></textarea></label>
    <label class="hp" aria-hidden="true">Site <input name="website" tabindex="-1" autocomplete="off"></label>`;

  return layout(config.meeting.title, `${header(config)}
${intro}
${error ? `<p class="error">${esc(error)}</p>` : ''}
<div id="app" data-token="${esc(token)}" data-locale="${esc(config.locale)}">
  <label class="tz">Seu fuso horário <select id="tz"></select></label>
  <p id="status">Carregando horários…</p>
  <div id="days" class="days"></div>
  <div id="times" class="times"></div>
  <form id="form" method="post" action="${action}" hidden>
    <p id="chosen" class="chosen"></p>
    <input type="hidden" name="start">
    <input type="hidden" name="tz">
    ${fields}
    <div class="actions">
      <button type="button" id="back" class="secondary">Voltar</button>
      <button type="submit">${mode === 'reschedule' ? 'Confirmar novo horário' : 'Confirmar reserva'}</button>
    </div>
  </form>
</div>
<noscript><p class="error">Esta página precisa de JavaScript para mostrar os horários.</p></noscript>`, { script: true });
}

export function managePage(config, booking, token, { flash = '' } = {}) {
  const cancelled = booking.status === 'cancelled';
  const past = booking.start_ms <= Date.now();
  const when = formatRange(booking.start_ms, booking.end_ms, booking.visitor_tz, config.locale);
  const title = cancelled ? 'Reunião cancelada' : flash || 'Detalhes da reunião';
  return layout(title, `${header(config)}
<h2 class="${cancelled ? 'muted' : 'ok'}">${cancelled ? '✕' : '✓'} ${esc(title)}</h2>
<dl>
  <dt>Quando</dt><dd>${esc(when)}</dd>
  <dt>Convidado</dt><dd>${esc(booking.name)} · ${esc(booking.email)}</dd>
  ${booking.note ? `<dt>Nota</dt><dd>${esc(booking.note)}</dd>` : ''}
  ${!cancelled && booking.meet_link ? `<dt>Google Meet</dt><dd><a href="${esc(booking.meet_link)}">${esc(booking.meet_link)}</a></dd>` : ''}
</dl>
${!cancelled && !past ? `<p class="hint">Enviamos a confirmação por e-mail, com os links abaixo.</p>
<div class="actions">
  <a class="button secondary" href="/b/${esc(token)}/cancel">Cancelar</a>
  <a class="button" href="/b/${esc(token)}/reschedule">Reagendar</a>
</div>` : ''}
${cancelled ? '<div class="actions"><a class="button" href="/">Agendar outro horário</a></div>' : ''}`);
}

export function cancelPage(config, booking, token) {
  return layout('Cancelar reunião', `${header(config)}
<h2>Cancelar esta reunião?</h2>
<p><strong>${esc(formatRange(booking.start_ms, booking.end_ms, booking.visitor_tz, config.locale))}</strong></p>
<form method="post" action="/b/${esc(token)}/cancel">
  <div class="actions">
    <a class="button secondary" href="/b/${esc(token)}">Manter</a>
    <button type="submit" class="danger">Sim, cancelar</button>
  </div>
</form>`);
}

export function messagePage(title, text, status = '') {
  return layout(title, `<h2 class="${status}">${esc(title)}</h2><p>${esc(text)}</p><div class="actions"><a class="button" href="/">Ver horários</a></div>`);
}

export function adminPage(config, { google, bookings, key, flash = '' }) {
  const k = encodeURIComponent(key);
  const rows = bookings.map((b) => `<tr>
    <td>${esc(formatRange(b.start_ms, b.end_ms, config.timezone, config.locale))}</td>
    <td>${esc(b.name)}<br><span class="hint">${esc(b.email)}</span></td>
    <td>${b.meet_link ? `<a href="${esc(b.meet_link)}">Meet</a>` : ''}${b.google_error ? `<span class="error">⚠ ${esc(b.google_error)}</span>` : ''}</td>
  </tr>`).join('');
  const status = !google.enabled
    ? 'Desativado (GOOGLE_CLIENT_ID/SECRET vazios no .env). Disponibilidade só pelo banco local.'
    : google.connected
      ? `Conectado. <form method="post" action="/admin/google/disconnect?key=${k}" class="inline"><button class="secondary">Desconectar</button></form>`
      : `<strong>Não conectado</strong> — a página pública não mostra horários até conectar. <a class="button" href="/auth/google?key=${k}">Conectar Google Calendar</a>`;
  return layout('Admin', `<h1>Admin</h1>
${flash ? `<p class="notice">${esc(flash)}</p>` : ''}
<h2>Google Calendar</h2><p>${status}</p>
<p class="hint">Redirect URI para o Console do Google: <code>${esc(google.redirectUri)}</code></p>
<h2>Próximas reuniões (${bookings.length})</h2>
${bookings.length ? `<table>${rows}</table>` : '<p class="hint">Nenhuma.</p>'}`);
}
