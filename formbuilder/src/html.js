// Tiny auto-escaping template tag. Interpolations are escaped unless they
// are the result of another html`` call (or raw()). Arrays are joined.

class Safe {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(value);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Safe(out);
}

const raw = (s) => new Safe(String(s));

function page({ title, body, bodyClass = '', accent, scripts = [] }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="stylesheet" href="/static/style.css">
${accent ? html`<style>:root{--accent:${raw(accent)}}</style>` : ''}
</head>
<body class="${bodyClass}">
${body}
${scripts.map((s) => html`<script src="${s}" defer></script>`)}
</body>
</html>`.toString();
}

function adminPage(title, body) {
  return page({
    title: `${title} · Forms admin`,
    bodyClass: 'admin',
    scripts: ['/static/admin.js'],
    body: html`<header class="topbar">
  <a href="/admin" class="brand">Forms</a>
  <form method="post" action="/admin/logout"><button class="link">Log out</button></form>
</header>
<main class="admin-main">${body}</main>`,
  });
}

module.exports = { html, raw, escape, page, adminPage };
