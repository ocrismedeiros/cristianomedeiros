const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const TOKEN = 'test-token-0123456789abcdef';
let tmp, server, base, repo, cookie, webhook, webhookHits, config;

async function admin(pathname, body) {
  return fetch(base + pathname, {
    method: body ? 'POST' : 'GET',
    redirect: 'manual',
    headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
  });
}

function submit(slug, entries, headers = {}) {
  const fd = new FormData();
  for (const [k, v] of entries) (Array.isArray(v) ? fd.append(k, v[0], v[1]) : fd.append(k, v));
  return fetch(`${base}/f/${slug}`, { method: 'POST', body: fd, redirect: 'manual', headers });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'formbuilder-test-'));
  webhookHits = [];
  webhook = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      webhookHits.push({ headers: req.headers, body: JSON.parse(data) });
      res.end('ok');
    });
  });
  await new Promise((r) => webhook.listen(0, '127.0.0.1', r));

  config = loadConfig({
    ADMIN_TOKEN: TOKEN,
    DATA_DIR: path.join(tmp, 'data'),
    UPLOAD_DIR: path.join(tmp, 'uploads'),
    RATE_LIMIT_MAX: '6',
    WEBHOOK_SECRET: 'shh',
    BASE_URL: 'https://forms.example.com',
  });
  const created = createApp(config);
  repo = created.repo;
  server = created.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  webhook.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('admin requires the token', async () => {
  let res = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/login');

  res = await fetch(base + '/admin/login', {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ token: 'wrong' }),
  });
  assert.equal(res.status, 401);

  res = await fetch(base + '/admin/forms', { method: 'POST', body: new URLSearchParams({ title: 'x' }) });
  assert.equal(res.status, 401);

  res = await fetch(base + '/admin/login', {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ token: TOKEN }),
  });
  assert.equal(res.status, 303);
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(res.headers.get('set-cookie'), /SameSite=Strict/i);

  res = await admin('/admin');
  assert.equal(res.status, 200);
});

test('cross-origin admin POST is rejected', async () => {
  const res = await fetch(base + '/admin/forms', {
    method: 'POST',
    headers: { cookie, origin: 'https://evil.example' },
    body: new URLSearchParams({ title: 'x' }),
  });
  assert.equal(res.status, 403);
});

let form, fields;

test('create a form, add fields, reorder', async () => {
  let res = await admin('/admin/forms', { title: 'Contato Ação' });
  assert.equal(res.status, 303);
  const formId = Number(res.headers.get('location').split('/').pop());
  form = repo.getForm(formId);
  assert.equal(form.slug, 'contato-acao');

  const add = (f) => admin(`/admin/forms/${formId}/fields`, f);
  assert.equal((await add({ type: 'text', label: 'Name', required: 'on' })).status, 303);
  assert.equal((await add({ type: 'email', label: 'Email', required: 'on' })).status, 303);
  assert.equal((await add({ type: 'textarea', label: 'Message' })).status, 303);
  assert.equal((await add({ type: 'select', label: 'Topic', options: 'Sales\nSupport', required: 'on' })).status, 303);
  assert.equal((await add({ type: 'checkbox', label: 'Channels', options: 'Email\nPhone' })).status, 303);
  assert.equal((await add({ type: 'checkbox', label: 'I agree', required: 'on' })).status, 303);
  assert.equal((await add({ type: 'file', label: 'Attachment' })).status, 303);
  assert.equal((await add({ type: 'select', label: 'Empty dropdown' })).status, 422);

  fields = repo.getFields(formId);
  assert.deepEqual(fields.map((f) => f.label), ['Name', 'Email', 'Message', 'Topic', 'Channels', 'I agree', 'Attachment']);

  // Move "Topic" up one.
  res = await admin(`/admin/forms/${formId}/fields/${fields[3].id}/move`, { direction: 'up' });
  assert.equal(res.status, 303);
  fields = repo.getFields(formId);
  assert.deepEqual(fields.map((f) => f.label).slice(0, 4), ['Name', 'Email', 'Topic', 'Message']);

  res = await admin(`/admin/forms/${formId}`, {
    title: 'Contato',
    slug: 'contato',
    description: 'Fale comigo',
    accent_color: '#ff5500',
    submit_label: 'Enviar',
    success_message: 'Valeu!',
    webhook_url: `http://127.0.0.1:${webhook.address().port}/hook`,
  });
  assert.equal(res.status, 303);
  form = repo.getForm(formId);
  assert.equal(form.slug, 'contato');

  res = await admin(`/admin/forms/${formId}`, { title: 'x', slug: 'Bad Slug!', accent_color: '#fff' });
  assert.equal(res.status, 422);
});

const byLabel = (label) => fields.find((f) => f.label === label);
const name = (label) => `f_${byLabel(label).id}`;

test('public page renders with accent color and honeypot', async () => {
  const res = await fetch(`${base}/f/contato`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /--accent:#ff5500/);
  assert.match(body, /name="website"/);
  assert.match(body, /Fale comigo/);
  assert.equal((await fetch(`${base}/f/nope`)).status, 404);
});

test('server-side validation rejects bad input', async () => {
  const res = await submit('contato', [
    [name('Name'), ''],
    [name('Email'), 'not-an-email'],
    [name('Topic'), 'Hacking'],
    [name('Channels'), 'Fax'],
  ]);
  assert.equal(res.status, 422);
  const body = await res.text();
  assert.match(body, /This field is required/);
  assert.match(body, /Enter a valid email address/);
  assert.match(body, /Choose one of the listed options/);
  assert.match(body, /This box must be checked/);
  assert.equal(repo.countResponses(form.id), 0);
});

test('honeypot submissions are silently dropped', async () => {
  const res = await submit('contato', [
    [name('Name'), 'Bot'],
    [name('Email'), 'bot@example.com'],
    [name('Topic'), 'Sales'],
    [name('I agree'), 'yes'],
    ['website', 'http://spam.example'],
  ]);
  assert.equal(res.status, 303);
  assert.equal(repo.countResponses(form.id), 0);
});

test('valid submission is stored, file saved, webhook fired', async () => {
  const res = await submit('contato', [
    [name('Name'), 'Zé <b>da</b> Silva'],
    [name('Email'), 'ze@example.com'],
    [name('Topic'), 'Support'],
    [name('Message'), '=HYPERLINK("http://x")'],
    [name('Channels'), 'Email'],
    [name('Channels'), 'Phone'],
    [name('I agree'), 'yes'],
    [name('Attachment'), [new Blob(['hello world'], { type: 'text/plain' }), 'relatório.txt']],
  ]);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/f/contato/thanks');
  assert.match(await (await fetch(base + '/f/contato/thanks')).text(), /Valeu!/);

  const [r] = repo.listResponses(form.id, 'created_at', 'desc');
  assert.deepEqual(r.data[byLabel('Channels').id], ['Email', 'Phone']);
  const file = r.data[byLabel('Attachment').id];
  assert.equal(file.name, 'relatório.txt');
  assert.ok(file.path.startsWith('contato' + path.sep));
  assert.equal(fs.readFileSync(path.join(config.uploadDir, file.path), 'utf8'), 'hello world');

  // Webhook is fire-and-forget; give it a moment.
  for (let i = 0; i < 50 && webhookHits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(webhookHits.length, 1);
  const hit = webhookHits[0];
  assert.match(hit.headers['x-formbuilder-signature'], /^sha256=[0-9a-f]{64}$/);
  assert.equal(hit.body.form.slug, 'contato');
  const fileVal = hit.body.response.fields.find((f) => f.type === 'file').value;
  assert.equal(fileVal.name, 'relatório.txt');
  assert.equal(fileVal.path, undefined);
  assert.match(fileVal.url, /^https:\/\/forms\.example\.com\/admin\/forms\/\d+\/responses\/\d+\/files\/\d+$/);
});

test('oversized file is rejected and not kept', async () => {
  const big = new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)]);
  const res = await submit('contato', [
    [name('Name'), 'Big'],
    [name('Attachment'), [big, 'big.bin']],
  ]);
  assert.equal(res.status, 413);
  assert.match(await res.text(), /too large/);
  assert.equal(fs.readdirSync(path.join(config.uploadDir, 'contato')).length, 1);
});

test('admin response table escapes HTML, sorts, and exports CSV', async () => {
  await submit('contato', [
    [name('Name'), 'Ana'],
    [name('Email'), 'ana@example.com'],
    [name('Topic'), 'Sales'],
    [name('I agree'), 'yes'],
  ]);

  let res = await admin(`/admin/forms/${form.id}/responses?sort=${byLabel('Name').id}&dir=asc`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Zé &lt;b&gt;da&lt;\/b&gt; Silva/);
  assert.ok(body.indexOf('Ana') < body.indexOf('Zé'), 'sorted ascending by name');

  res = await admin(`/admin/forms/${form.id}/responses?sort=${byLabel('Name').id}&dir=desc`);
  const desc = await res.text();
  assert.ok(desc.indexOf('Zé') < desc.indexOf('>Ana<'), 'sorted descending by name');

  res = await admin(`/admin/forms/${form.id}/responses.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = Buffer.from(await res.arrayBuffer()).toString('utf8');
  assert.ok(csv.startsWith('\uFEFFResponse ID,Submitted (UTC),Name,Email,Topic,Message'));
  assert.match(csv, /'=HYPERLINK\(""http:\/\/x""\)/);
  assert.match(csv, /"Email, Phone"/);

  // File download is admin-only and forced to download.
  const [r] = repo.listResponses(form.id, 'created_at', 'asc');
  const fileUrl = `/admin/forms/${form.id}/responses/${r.id}/files/${byLabel('Attachment').id}`;
  assert.equal((await fetch(base + fileUrl, { redirect: 'manual' })).status, 303);
  res = await admin(fileUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.equal(await res.text(), 'hello world');
});

test('deleting a response removes its file', async () => {
  const [r] = repo.listResponses(form.id, 'created_at', 'asc');
  const file = r.data[byLabel('Attachment').id];
  const res = await admin(`/admin/forms/${form.id}/responses/${r.id}/delete`, {});
  assert.equal(res.status, 303);
  assert.equal(fs.existsSync(path.join(config.uploadDir, file.path)), false);
  assert.equal(repo.countResponses(form.id), 1);
});

test('per-IP rate limit kicks in', async () => {
  // 6 allowed per window; earlier tests already used 5.
  assert.equal((await submit('contato', [[name('Name'), 'Sixth']])).status, 422);
  const res = await submit('contato', [[name('Name'), 'Seventh']]);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('deleting a form requires typing the slug', async () => {
  let res = await admin(`/admin/forms/${form.id}/delete`, { confirm_slug: 'nope' });
  assert.equal(res.status, 422);
  res = await admin(`/admin/forms/${form.id}/delete`, { confirm_slug: 'contato' });
  assert.equal(res.status, 303);
  assert.equal(repo.getForm(form.id), undefined);
  assert.equal(fs.existsSync(path.join(config.uploadDir, 'contato')), false);
});

test('email notification is sent over SMTP', async () => {
  const net = require('node:net');
  const { createNotifier } = require('../src/notify');
  let message = '';
  const smtp = net.createServer((sock) => {
    let inData = false;
    sock.write('220 sink ESMTP\r\n');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            sock.write('250 queued\r\n');
          } else message += line + '\n';
        } else if (/^(EHLO|HELO)/i.test(line)) sock.write('250 sink\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          sock.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  const notifier = createNotifier(
    loadConfig({
      ADMIN_TOKEN: TOKEN,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.address().port),
      MAIL_FROM: 'forms@example.com',
      MAIL_TO: 'me@example.com',
      BASE_URL: 'https://forms.example.com',
    }),
  );
  const f = { id: 1, slug: 'x', title: 'Lead form', notify_email: true, webhook_url: '' };
  const flds = [{ id: 5, label: 'Name', type: 'text' }];
  await notifier.notify(f, flds, { id: 9, created_at: '2026-01-01T00:00:00Z', data: { 5: 'Maria' } });
  smtp.close();
  assert.match(message, /Subject: New response: Lead form/);
  assert.match(message, /Maria/);
  assert.match(message, /https:\/\/forms\.example\.com\/admin\/forms\/1\/responses/);
});
