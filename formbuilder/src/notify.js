const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { displayValue } = require('./format');

function createNotifier(config) {
  const { smtp } = config;
  const transport =
    smtp.host &&
    nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });

  // File answers: expose metadata and an admin download link, never the disk path.
  function payloadValue(form, response, field) {
    const v = response.data[field.id];
    if (v === undefined) return null;
    if (field.type !== 'file' || !v) return v;
    const url = config.baseUrl
      ? `${config.baseUrl}/admin/forms/${form.id}/responses/${response.id}/files/${field.id}`
      : null;
    return { name: v.name, size: v.size, type: v.type, url };
  }

  function buildPayload(form, fields, response) {
    return {
      form: { id: form.id, slug: form.slug, title: form.title },
      response: {
        id: response.id,
        created_at: response.created_at,
        fields: fields.map((f) => ({
          id: f.id,
          label: f.label,
          type: f.type,
          value: payloadValue(form, response, f),
        })),
      },
    };
  }

  async function sendEmail(form, fields, response) {
    if (!transport || !smtp.to) {
      console.warn(`[notify] form ${form.slug}: email enabled but SMTP_HOST/MAIL_TO not configured`);
      return;
    }
    const lines = fields.map((f) => `${f.label}:\n${displayValue(f, response.data[f.id]) || '—'}\n`);
    const link = config.baseUrl ? `\n${config.baseUrl}/admin/forms/${form.id}/responses\n` : '';
    await transport.sendMail({
      from: smtp.from,
      to: smtp.to,
      subject: `New response: ${form.title}`,
      text: `${form.title} — response #${response.id} at ${response.created_at}\n\n${lines.join('\n')}${link}`,
    });
  }

  async function postWebhook(form, fields, response) {
    const body = JSON.stringify(buildPayload(form, fields, response));
    const headers = { 'content-type': 'application/json', 'user-agent': 'formbuilder-webhook/1' };
    if (config.webhookSecret) {
      headers['x-formbuilder-signature'] =
        'sha256=' + crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');
    }
    const res = await fetch(form.webhook_url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }

  // Fire-and-forget: a failing notification never blocks or fails the submission.
  function notify(form, fields, response) {
    const jobs = [];
    if (form.notify_email) jobs.push(['email', sendEmail(form, fields, response)]);
    if (form.webhook_url) jobs.push(['webhook', postWebhook(form, fields, response)]);
    return Promise.all(
      jobs.map(([kind, p]) =>
        p.catch((err) => console.error(`[notify] form ${form.slug} ${kind} failed: ${err.message}`)),
      ),
    );
  }

  return { notify, buildPayload };
}

module.exports = { createNotifier };
