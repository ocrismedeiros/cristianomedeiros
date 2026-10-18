const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { html, page } = require('./html');
const { validateSubmission, fieldName, MAX_LEN } = require('./validate');
const { formatBytes } = require('./format');
const { createRateLimiter } = require('./ratelimit');

const HONEYPOT = 'website';

function renderField(field, value, error) {
  const name = fieldName(field);
  const id = `field-${field.id}`;
  const req = field.required;
  const errId = `${id}-error`;
  const describedBy = [field.help_text && `${id}-help`, errId].filter(Boolean).join(' ');
  const common = { id, name, describedBy };

  const label = html`<label class="label" for="${id}">${field.label}${req ? html`<span class="req" aria-hidden="true"> *</span>` : ''}</label>`;
  const help = field.help_text ? html`<p class="help" id="${id}-help">${field.help_text}</p>` : '';
  const err = html`<p class="error" id="${errId}" ${error ? '' : 'hidden'}>${error || ''}</p>`;
  const invalid = error ? 'true' : 'false';

  let control;
  switch (field.type) {
    case 'text':
    case 'email':
      control = html`<input type="${field.type}" id="${common.id}" name="${common.name}" value="${value || ''}"
        maxlength="${MAX_LEN[field.type]}" ${req ? 'required' : ''} aria-invalid="${invalid}"
        aria-describedby="${common.describedBy}" ${field.type === 'email' ? 'autocomplete="email"' : ''}>`;
      break;
    case 'textarea':
      control = html`<textarea id="${common.id}" name="${common.name}" rows="5" maxlength="${MAX_LEN.textarea}"
        ${req ? 'required' : ''} aria-invalid="${invalid}" aria-describedby="${common.describedBy}">${value || ''}</textarea>`;
      break;
    case 'select':
      control = html`<select id="${common.id}" name="${common.name}" ${req ? 'required' : ''}
        aria-invalid="${invalid}" aria-describedby="${common.describedBy}">
        <option value="">Choose…</option>
        ${field.optionList.map((o) => html`<option ${o === value ? 'selected' : ''}>${o}</option>`)}
      </select>`;
      break;
    case 'checkbox':
      if (field.optionList.length === 0) {
        return html`<div class="field" data-field="${field.id}">
          <label class="check single"><input type="checkbox" id="${id}" name="${name}" value="yes"
            ${value === 'yes' ? 'checked' : ''} ${req ? 'required' : ''} aria-invalid="${invalid}"
            aria-describedby="${describedBy}">
          <span>${field.label}${req ? html`<span class="req" aria-hidden="true"> *</span>` : ''}</span></label>
          ${help}${err}
        </div>`;
      }
      return html`<fieldset class="field" data-field="${field.id}" ${req ? 'data-required-group' : ''}
          aria-describedby="${describedBy}">
        <legend class="label">${field.label}${req ? html`<span class="req" aria-hidden="true"> *</span>` : ''}</legend>
        ${help}
        ${field.optionList.map(
          (o, i) => html`<label class="check"><input type="checkbox" name="${name}" value="${o}"
            id="${id}-${i}" ${Array.isArray(value) && value.includes(o) ? 'checked' : ''}><span>${o}</span></label>`,
        )}
        ${err}
      </fieldset>`;
    case 'file':
      control = html`<input type="file" id="${common.id}" name="${common.name}" ${req ? 'required' : ''}
        aria-invalid="${invalid}" aria-describedby="${common.describedBy}">
        <p class="help">Max 10 MB.${value ? ' Please select the file again.' : ''}</p>`;
      break;
  }
  return html`<div class="field" data-field="${field.id}">${label}${help}${control}${err}</div>`;
}

function renderForm(form, fields, { values = {}, errors = {}, banner } = {}) {
  const hasErrors = Object.keys(errors).length > 0;
  return page({
    title: form.title,
    accent: form.accent_color,
    bodyClass: 'public',
    scripts: ['/static/form.js'],
    body: html`<main class="form-wrap">
  <h1>${form.title}</h1>
  ${form.description ? html`<p class="lead">${form.description}</p>` : ''}
  ${banner ? html`<div class="banner" role="alert">${banner}</div>` : ''}
  ${hasErrors && !banner ? html`<div class="banner" role="alert">Please fix the highlighted fields.</div>` : ''}
  <form method="post" enctype="multipart/form-data" novalidate data-max-bytes="${10 * 1024 * 1024}">
    ${fields.map((f) => renderField(f, values[f.id], errors[f.id]))}
    <div class="hp" aria-hidden="true">
      <label for="hp-${HONEYPOT}">Leave this empty</label>
      <input type="text" id="hp-${HONEYPOT}" name="${HONEYPOT}" tabindex="-1" autocomplete="off">
    </div>
    <button type="submit" class="submit">${form.submit_label || 'Submit'}</button>
  </form>
</main>`,
  });
}

function messagePage(form, title, message, status = 200) {
  return {
    status,
    body: page({
      title: form ? form.title : title,
      accent: form && form.accent_color,
      bodyClass: 'public',
      body: html`<main class="form-wrap message"><h1>${title}</h1><p class="lead">${message}</p></main>`,
    }),
  };
}

function safeExt(originalname) {
  const ext = path.extname(originalname || '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function removeFiles(files) {
  for (const list of Object.values(files || {})) {
    for (const f of list) fs.rm(f.path, { force: true }, () => {});
  }
}

function publicRouter({ config, repo, notifier }) {
  const router = express.Router();
  const limiter = createRateLimiter(config.rateLimit);

  router.get('/f/:slug', (req, res) => {
    const form = repo.getFormBySlug(req.params.slug);
    if (!form) return send(res, messagePage(null, 'Not found', 'This form does not exist.', 404));
    res.send(renderForm(form, repo.getFields(form.id)));
  });

  router.get('/f/:slug/thanks', (req, res) => {
    const form = repo.getFormBySlug(req.params.slug);
    if (!form) return send(res, messagePage(null, 'Not found', 'This form does not exist.', 404));
    send(res, messagePage(form, 'Thank you', form.success_message));
  });

  router.post('/f/:slug', (req, res, next) => {
    const form = repo.getFormBySlug(req.params.slug);
    if (!form) return send(res, messagePage(null, 'Not found', 'This form does not exist.', 404));

    if (!limiter.hit(req.ip)) {
      res.set('Retry-After', String(limiter.retryAfterSec(req.ip)));
      return send(res, messagePage(form, 'Slow down', 'Too many submissions from your network. Try again later.', 429));
    }

    const fields = repo.getFields(form.id);
    const fileFields = fields.filter((f) => f.type === 'file');
    const dir = path.join(config.uploadDir, form.slug);

    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir)),
        filename: (_req, file, cb) => cb(null, crypto.randomUUID() + safeExt(file.originalname)),
      }),
      defParamCharset: 'utf8',
      limits: {
        fileSize: config.maxUploadBytes,
        files: fileFields.length,
        fields: fields.length * 50 + 10,
        fieldSize: 64 * 1024,
      },
    }).fields(fileFields.map((f) => ({ name: fieldName(f), maxCount: 1 })));

    upload(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          const field = fields.find((f) => fieldName(f) === err.field);
          if (err.code === 'LIMIT_FILE_SIZE' && field) {
            return res.status(413).send(
              renderForm(form, fields, {
                errors: { [field.id]: `File is too large (max ${formatBytes(config.maxUploadBytes)}).` },
                banner: 'A file was too large. Your answers were not saved; please fill the form again.',
              }),
            );
          }
          return send(res, messagePage(form, 'Invalid submission', 'The submission could not be processed.', 400));
        }
        return next(err);
      }
      handleSubmission(form, fields, req, res);
    });
  });

  function handleSubmission(form, fields, req, res) {
    const body = req.body || {};

    // Honeypot: pretend everything went fine, store nothing.
    if (typeof body[HONEYPOT] === 'string' && body[HONEYPOT].trim() !== '') {
      removeFiles(req.files);
      return res.redirect(303, `/f/${encodeURIComponent(form.slug)}/thanks`);
    }

    const { data, errors } = validateSubmission(fields, body, req.files);
    if (Object.keys(errors).length > 0) {
      removeFiles(req.files);
      return res.status(422).send(renderForm(form, fields, { values: data, errors }));
    }

    for (const [fieldId, value] of Object.entries(data)) {
      if (value && value.file) {
        const f = value.file;
        data[fieldId] = {
          name: f.originalname,
          path: path.relative(config.uploadDir, f.path),
          size: f.size,
          type: f.mimetype,
        };
      }
    }

    const id = repo.addResponse(form.id, data);
    const response = repo.getResponse(id);
    notifier.notify(form, fields, response);
    res.redirect(303, `/f/${encodeURIComponent(form.slug)}/thanks`);
  }

  return router;
}

function send(res, { status, body }) {
  res.status(status).send(body);
}

module.exports = { publicRouter };
