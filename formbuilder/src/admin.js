const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { html, adminPage, page } = require('./html');
const { FIELD_TYPES } = require('./db');
const { displayValue, formatBytes } = require('./format');
const { toCsv } = require('./csv');
const { createRateLimiter } = require('./ratelimit');

const COOKIE = 'fb_admin';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const TYPE_LABELS = {
  text: 'Short text',
  textarea: 'Long text',
  email: 'Email',
  select: 'Dropdown',
  checkbox: 'Checkbox',
  file: 'File upload',
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

const str = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function adminRouter({ config, repo }) {
  const router = express.Router();
  const sessionValue = crypto.createHmac('sha256', config.adminToken).update('fb-admin-session-v1').digest('hex');
  const loginLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const secureCookie = config.baseUrl.startsWith('https://');

  const isAuthed = (req) => {
    const cookie = parseCookies(req.headers.cookie)[COOKIE] || '';
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const candidate = bearer ? sha256(bearer).equals(sha256(config.adminToken)) : false;
    return candidate || crypto.timingSafeEqual(sha256(cookie), sha256(sessionValue));
  };

  router.use(express.urlencoded({ extended: false, limit: '200kb' }));

  // Reject cross-site POSTs (cookie is SameSite=Strict too; this is belt and braces).
  router.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try {
        if (new URL(origin).host !== req.headers.host) return res.status(403).send('Cross-origin request blocked');
      } catch {
        return res.status(403).send('Bad origin');
      }
    }
    next();
  });

  router.get('/login', (req, res) => res.send(loginPage()));

  router.post('/login', (req, res) => {
    if (!loginLimiter.hit(req.ip)) return res.status(429).send(loginPage('Too many attempts. Try again later.'));
    const token = str(req.body.token, 500);
    if (!sha256(token).equals(sha256(config.adminToken))) {
      return res.status(401).send(loginPage('Wrong token.'));
    }
    res.cookie(COOKIE, sessionValue, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie,
      path: '/admin',
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.redirect(303, '/admin');
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/admin' });
    res.redirect(303, '/admin/login');
  });

  router.use((req, res, next) => {
    if (isAuthed(req)) return next();
    if (req.method === 'GET') return res.redirect(303, '/admin/login');
    res.status(401).send('Unauthorized');
  });

  // Resolve a stored relative upload path, refusing anything outside uploadDir.
  function uploadPath(rel) {
    const abs = path.resolve(config.uploadDir, rel);
    return abs.startsWith(config.uploadDir + path.sep) ? abs : null;
  }

  function removeResponseFiles(r) {
    for (const v of Object.values(r.data)) {
      const abs = v && typeof v === 'object' && v.path && uploadPath(v.path);
      if (abs) fs.rmSync(abs, { force: true });
    }
  }

  // ---------- Forms ----------

  router.get('/', (req, res) => {
    const forms = repo.listForms();
    res.send(
      adminPage(
        'Forms',
        html`<div class="row-between"><h1>Forms</h1></div>
        <form method="post" action="/admin/forms" class="inline-create card">
          <label>New form title <input name="title" required maxlength="200" placeholder="Contact us"></label>
          <button class="btn primary">Create form</button>
        </form>
        ${
          forms.length === 0
            ? html`<p class="muted">No forms yet.</p>`
            : html`<table class="table">
            <thead><tr><th>Title</th><th>Public URL</th><th>Responses</th><th>Created</th><th></th></tr></thead>
            <tbody>${forms.map(
              (f) => html`<tr>
                <td><a href="/admin/forms/${f.id}">${f.title}</a></td>
                <td><a href="/f/${f.slug}" target="_blank" rel="noopener">/f/${f.slug}</a></td>
                <td><a href="/admin/forms/${f.id}/responses">${f.response_count}</a></td>
                <td>${f.created_at.slice(0, 10)}</td>
                <td class="actions"><a class="btn" href="/admin/forms/${f.id}">Edit</a></td>
              </tr>`,
            )}</tbody></table>`
        }`,
      ),
    );
  });

  router.post('/forms', (req, res) => {
    const title = str(req.body.title, 200) || 'Untitled form';
    let base = slugify(title) || 'form';
    let slug = base;
    for (let n = 2; repo.getFormBySlug(slug); n++) slug = `${base.slice(0, 55)}-${n}`;
    const id = repo.createForm(slug, title);
    res.redirect(303, `/admin/forms/${id}`);
  });

  // Load :formId for all nested routes.
  router.param('formId', (req, res, next, id) => {
    const form = /^\d+$/.test(id) && repo.getForm(Number(id));
    if (!form) return res.status(404).send(adminPage('Not found', html`<h1>Form not found</h1>`));
    req.form = form;
    next();
  });

  router.get('/forms/:formId', (req, res) => res.send(formEditor(req.form, repo.getFields(req.form.id))));

  router.post('/forms/:formId', (req, res) => {
    const form = req.form;
    const b = req.body;
    const errors = [];
    const next = {
      id: form.id,
      title: str(b.title, 200) || form.title,
      slug: str(b.slug, 60).toLowerCase(),
      description: str(b.description, 2000),
      accent_color: str(b.accent_color, 7),
      submit_label: str(b.submit_label, 60) || 'Submit',
      success_message: str(b.success_message, 1000) || 'Thanks! Your response was recorded.',
      notify_email: b.notify_email === 'on',
      webhook_url: str(b.webhook_url, 2000),
    };
    if (!SLUG_RE.test(next.slug)) errors.push('Slug must be lowercase letters, numbers and dashes.');
    else {
      const other = repo.getFormBySlug(next.slug);
      if (other && other.id !== form.id) errors.push('That slug is already used by another form.');
    }
    if (!HEX_RE.test(next.accent_color)) errors.push('Accent color must be a hex value like #4f46e5.');
    if (next.webhook_url) {
      try {
        const u = new URL(next.webhook_url);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      } catch {
        errors.push('Webhook URL must be a valid http(s) URL.');
      }
    }
    if (errors.length) {
      return res.status(422).send(formEditor({ ...form, ...next }, repo.getFields(form.id), errors));
    }
    repo.updateForm(next);
    res.redirect(303, `/admin/forms/${form.id}?saved=1`);
  });

  router.post('/forms/:formId/delete', (req, res) => {
    const form = req.form;
    if (str(req.body.confirm_slug) !== form.slug) {
      return res
        .status(422)
        .send(formEditor(form, repo.getFields(form.id), ['Type the slug exactly to confirm deletion.']));
    }
    // Files may live under an older slug's folder if the slug was renamed.
    for (const r of repo.listResponses(form.id, 'created_at', 'asc')) removeResponseFiles(r);
    repo.deleteForm(form.id);
    fs.rmSync(path.join(config.uploadDir, form.slug), { recursive: true, force: true });
    res.redirect(303, '/admin');
  });

  // ---------- Fields ----------

  function readField(b) {
    const type = FIELD_TYPES.includes(b.type) ? b.type : 'text';
    const options = str(b.options, 10000)
      .split(/\r?\n/)
      .map((s) => s.trim().slice(0, 200))
      .filter(Boolean)
      .join('\n');
    return {
      type,
      label: str(b.label, 300),
      help_text: str(b.help_text, 1000),
      options: type === 'select' || type === 'checkbox' ? options : '',
      required: b.required === 'on',
    };
  }

  function fieldErrors(f) {
    const errors = [];
    if (!f.label) errors.push('Label is required.');
    if (f.type === 'select' && !f.options) errors.push('A dropdown needs at least one option.');
    return errors;
  }

  router.post('/forms/:formId/fields', (req, res) => {
    const field = readField(req.body);
    const errors = fieldErrors(field);
    if (errors.length) return res.status(422).send(formEditor(req.form, repo.getFields(req.form.id), errors, field));
    repo.addField({ ...field, form_id: req.form.id });
    res.redirect(303, `/admin/forms/${req.form.id}#fields`);
  });

  router.param('fieldId', (req, res, next, id) => {
    const field = /^\d+$/.test(id) && repo.getField(req.form.id, Number(id));
    if (!field) return res.status(404).send(adminPage('Not found', html`<h1>Field not found</h1>`));
    req.field = field;
    next();
  });

  router.get('/forms/:formId/fields/:fieldId', (req, res) => res.send(fieldEditor(req.form, req.field)));

  router.post('/forms/:formId/fields/:fieldId', (req, res) => {
    const field = { ...readField(req.body), id: req.field.id, form_id: req.form.id };
    const errors = fieldErrors(field);
    if (errors.length) return res.status(422).send(fieldEditor(req.form, field, errors));
    repo.updateField(field);
    res.redirect(303, `/admin/forms/${req.form.id}#fields`);
  });

  router.post('/forms/:formId/fields/:fieldId/move', (req, res) => {
    repo.moveField(req.form.id, req.field.id, req.body.direction === 'up' ? 'up' : 'down');
    res.redirect(303, `/admin/forms/${req.form.id}#fields`);
  });

  router.post('/forms/:formId/fields/:fieldId/delete', (req, res) => {
    repo.deleteField(req.form.id, req.field.id);
    res.redirect(303, `/admin/forms/${req.form.id}#fields`);
  });

  // ---------- Responses ----------

  function sortParams(req, fields) {
    const sort = String(req.query.sort || 'created_at');
    const valid = sort === 'created_at' || fields.some((f) => String(f.id) === sort);
    return {
      sort: valid ? sort : 'created_at',
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
    };
  }

  router.get('/forms/:formId/responses', (req, res) => {
    const form = req.form;
    const fields = repo.getFields(form.id);
    const { sort, dir } = sortParams(req, fields);
    const rows = repo.listResponses(form.id, sort, dir);

    const th = (key, label) => {
      const active = sort === key;
      const nextDir = active && dir === 'desc' ? 'asc' : 'desc';
      const arrow = active ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
      return html`<th aria-sort="${active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}">
        <a href="?sort=${key}&dir=${nextDir}">${label}${arrow}</a></th>`;
    };

    const cell = (f, r) => {
      const v = r.data[f.id];
      if (f.type === 'file' && v && v.path) {
        return html`<td><a href="/admin/forms/${form.id}/responses/${r.id}/files/${f.id}">${v.name}</a>
          <span class="muted">(${formatBytes(v.size)})</span></td>`;
      }
      return html`<td>${displayValue(f, v)}</td>`;
    };

    res.send(
      adminPage(
        `Responses · ${form.title}`,
        html`<p class="crumbs"><a href="/admin">Forms</a> / <a href="/admin/forms/${form.id}">${form.title}</a> / Responses</p>
        <div class="row-between">
          <h1>Responses <span class="muted">(${rows.length})</span></h1>
          <a class="btn primary" href="/admin/forms/${form.id}/responses.csv?sort=${sort}&dir=${dir}">Export CSV</a>
        </div>
        ${
          rows.length === 0
            ? html`<p class="muted">No responses yet. Share <a href="/f/${form.slug}">/f/${form.slug}</a>.</p>`
            : html`<div class="table-scroll"><table class="table responses">
          <thead><tr>${th('created_at', 'Submitted')}${fields.map((f) => th(String(f.id), f.label))}<th></th></tr></thead>
          <tbody>${rows.map(
            (r) => html`<tr>
              <td class="nowrap">${r.created_at.replace('T', ' ').replace('Z', ' UTC')}</td>
              ${fields.map((f) => cell(f, r))}
              <td class="actions"><form method="post" action="/admin/forms/${form.id}/responses/${r.id}/delete"
                data-confirm="Delete this response permanently?"><button class="btn danger small">Delete</button></form></td>
            </tr>`,
          )}</tbody></table></div>`
        }`,
      ),
    );
  });

  router.get('/forms/:formId/responses.csv', (req, res) => {
    const form = req.form;
    const fields = repo.getFields(form.id);
    const { sort, dir } = sortParams(req, fields);
    const rows = repo.listResponses(form.id, sort, dir);
    const csv = toCsv([
      ['Response ID', 'Submitted (UTC)', ...fields.map((f) => f.label)],
      ...rows.map((r) => [r.id, r.created_at, ...fields.map((f) => displayValue(f, r.data[f.id]))]),
    ]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`${form.slug}-responses-${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  });

  router.post('/forms/:formId/responses/:responseId/delete', (req, res) => {
    const r = repo.getResponse(Number(req.params.responseId));
    if (r && r.form_id === req.form.id) {
      removeResponseFiles(r);
      repo.deleteResponse(req.form.id, r.id);
    }
    res.redirect(303, `/admin/forms/${req.form.id}/responses`);
  });

  router.get('/forms/:formId/responses/:responseId/files/:fileFieldId', (req, res) => {
    const r = repo.getResponse(Number(req.params.responseId));
    const v = r && r.form_id === req.form.id && r.data[req.params.fileFieldId];
    if (!v || !v.path) return res.status(404).send('File not found');
    const abs = uploadPath(v.path);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).send('File not found');
    }
    // Always download (never render inline) so uploaded HTML/SVG can't run in the admin origin.
    res.download(abs, v.name, { headers: { 'Content-Type': 'application/octet-stream' } });
  });

  return router;
}

// ---------- Views ----------

function loginPage(error) {
  return page({
    title: 'Log in · Forms admin',
    bodyClass: 'admin',
    body: html`<main class="login card">
      <h1>Forms admin</h1>
      ${error ? html`<p class="banner">${error}</p>` : ''}
      <form method="post" action="/admin/login">
        <label>Admin token <input type="password" name="token" required autofocus autocomplete="current-password"></label>
        <button class="btn primary">Log in</button>
      </form>
    </main>`,
  });
}

function fieldInputs(field = {}) {
  const type = field.type || 'text';
  return html`
    <label>Type
      <select name="type" data-field-type>
        ${Object.entries(TYPE_LABELS).map(
          ([value, label]) => html`<option value="${value}" ${value === type ? 'selected' : ''}>${label}</option>`,
        )}
      </select>
    </label>
    <label>Label <input name="label" value="${field.label || ''}" required maxlength="300"></label>
    <label>Help text <span class="muted">(optional)</span>
      <input name="help_text" value="${field.help_text || ''}" maxlength="1000"></label>
    <label data-options>Options <span class="muted">(one per line; for checkbox leave empty for a single yes/no box)</span>
      <textarea name="options" rows="4">${field.options || ''}</textarea></label>
    <label class="check"><input type="checkbox" name="required" ${field.required ? 'checked' : ''}> Required</label>`;
}

function errorList(errors) {
  return errors && errors.length
    ? html`<div class="banner" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`
    : '';
}

function formEditor(form, fields, errors = [], draftField) {
  return adminPage(
    form.title,
    html`<p class="crumbs"><a href="/admin">Forms</a> / ${form.title}</p>
    <div class="row-between">
      <h1>${form.title}</h1>
      <div class="btn-row">
        <a class="btn" href="/f/${form.slug}" target="_blank" rel="noopener">View public page</a>
        <a class="btn primary" href="/admin/forms/${form.id}/responses">Responses</a>
      </div>
    </div>
    ${errorList(errors)}

    <section class="card" id="fields">
      <h2>Fields</h2>
      ${
        fields.length === 0
          ? html`<p class="muted">No fields yet. Add one below.</p>`
          : html`<ol class="field-list">${fields.map(
              (f, i) => html`<li>
            <div class="field-meta">
              <strong>${f.label}</strong>${f.required ? html` <span class="pill">required</span>` : ''}
              <span class="muted">${TYPE_LABELS[f.type]}${f.optionList.length ? ` · ${f.optionList.length} options` : ''}</span>
            </div>
            <div class="btn-row">
              <form method="post" action="/admin/forms/${form.id}/fields/${f.id}/move">
                <input type="hidden" name="direction" value="up">
                <button class="btn small" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button></form>
              <form method="post" action="/admin/forms/${form.id}/fields/${f.id}/move">
                <input type="hidden" name="direction" value="down">
                <button class="btn small" ${i === fields.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></form>
              <a class="btn small" href="/admin/forms/${form.id}/fields/${f.id}">Edit</a>
              <form method="post" action="/admin/forms/${form.id}/fields/${f.id}/delete"
                data-confirm="Delete this field? Existing answers stay in the database but are hidden.">
                <button class="btn small danger">Delete</button></form>
            </div>
          </li>`,
            )}</ol>`
      }
      <details class="add-field" ${draftField ? 'open' : ''}>
        <summary class="btn">+ Add field</summary>
        <form method="post" action="/admin/forms/${form.id}/fields" class="stack">
          ${fieldInputs(draftField)}
          <button class="btn primary">Add field</button>
        </form>
      </details>
    </section>

    <section class="card">
      <h2>Settings</h2>
      <form method="post" action="/admin/forms/${form.id}" class="stack">
        <label>Title <input name="title" value="${form.title}" required maxlength="200"></label>
        <label>Slug <span class="muted">(public URL: /f/<em>slug</em>)</span>
          <input name="slug" value="${form.slug}" required maxlength="60" pattern="[a-z0-9](?:[a-z0-9\\-]{0,58}[a-z0-9])?"></label>
        <label>Description <span class="muted">(optional, shown under the title)</span>
          <textarea name="description" rows="3" maxlength="2000">${form.description}</textarea></label>
        <div class="grid-2">
          <label>Accent color <input type="color" name="accent_color" value="${form.accent_color}"></label>
          <label>Submit button label <input name="submit_label" value="${form.submit_label}" maxlength="60"></label>
        </div>
        <label>Thank-you message <textarea name="success_message" rows="2" maxlength="1000">${form.success_message}</textarea></label>
        <h3>Notifications</h3>
        <label class="check"><input type="checkbox" name="notify_email" ${form.notify_email ? 'checked' : ''}>
          Email me each response <span class="muted">(uses SMTP_* and MAIL_TO from .env)</span></label>
        <label>Webhook URL <span class="muted">(optional; response JSON is POSTed here)</span>
          <input type="url" name="webhook_url" value="${form.webhook_url}" placeholder="https://example.com/hook"></label>
        <button class="btn primary">Save settings</button>
      </form>
    </section>

    <section class="card danger-zone">
      <h2>Delete form</h2>
      <p class="muted">Deletes the form, all its responses and its uploads folder. Type <code>${form.slug}</code> to confirm.</p>
      <form method="post" action="/admin/forms/${form.id}/delete" class="inline-create">
        <input name="confirm_slug" aria-label="Type the slug to confirm" autocomplete="off">
        <button class="btn danger">Delete form</button>
      </form>
    </section>`,
  );
}

function fieldEditor(form, field, errors = []) {
  return adminPage(
    `Edit field · ${form.title}`,
    html`<p class="crumbs"><a href="/admin">Forms</a> / <a href="/admin/forms/${form.id}">${form.title}</a> / Edit field</p>
    <h1>Edit field</h1>
    ${errorList(errors)}
    <form method="post" action="/admin/forms/${form.id}/fields/${field.id}" class="card stack">
      ${fieldInputs(field)}
      <div class="btn-row">
        <button class="btn primary">Save field</button>
        <a class="btn" href="/admin/forms/${form.id}#fields">Cancel</a>
      </div>
    </form>`,
  );
}

module.exports = { adminRouter, slugify };
