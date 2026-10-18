# formbuilder

A personal, self-hosted replacement for Tally: one Node + Express + SQLite app,
server-rendered HTML, no frontend framework, no telemetry, no third-party form
service. Respondent data lives only in your SQLite file and uploads folder.

- **Admin** at `/admin` (single `ADMIN_TOKEN`, no accounts): create forms, add
  fields (short text, long text, email, dropdown, checkbox, file upload), mark
  required, reorder, edit, delete.
- **Public form** at `/f/<slug>`: single column, one accent color per form,
  client + server validation, honeypot field, per-IP rate limit.
- **Responses** stored in SQLite; uploads saved to `uploads/<form-slug>/`
  (10 MB per file). Sortable table per form, CSV export, per-response delete,
  admin-only file download.
- **Notifications** per form (both optional): email each response via your
  SMTP, and/or POST the response JSON to a webhook URL.

Not included on purpose: partial submissions, conditional logic, payments,
team workspaces, template gallery.

## Requirements

- Node.js 20.12+ (22 LTS recommended)
- Build tools are only needed if `better-sqlite3` has no prebuilt binary for
  your platform (`apt install build-essential python3`).

## Install on the VPS

```bash
git clone <this repo> /opt/formbuilder-src
cp -r /opt/formbuilder-src/formbuilder /opt/formbuilder
cd /opt/formbuilder
npm ci --omit=dev
cp .env.example .env
openssl rand -hex 32          # paste into ADMIN_TOKEN in .env
nano .env                     # BASE_URL, SMTP_*, MAIL_TO, ...
npm start                     # smoke test, then Ctrl+C
```

Then open `https://<your domain>/admin` and log in with the token.

## Environment variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | — (required, ≥16 chars) | The only admin credential. Login sets an HttpOnly, SameSite=Strict cookie for 30 days. Also accepted as `Authorization: Bearer <token>`. Changing it logs out every session. |
| `BASE_URL` | empty | Public URL, e.g. `https://forms.example.com`. Used for links in emails/webhooks; when it starts with `https://` the admin cookie is marked `Secure`. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback behind Caddy. |
| `PORT` | `3000` | Listen port. |
| `DATA_DIR` | `data` | Folder holding `forms.db`. Relative to the app folder. |
| `UPLOAD_DIR` | `uploads` | Folder holding uploaded files. Relative to the app folder. |
| `RATE_LIMIT_MAX` | `10` | Max form POSTs per IP per window (valid or not). |
| `RATE_LIMIT_WINDOW_MIN` | `15` | Rate-limit window in minutes. |
| `SMTP_HOST` | empty | SMTP server. Email notifications are skipped (with a log line) if empty. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (port 465). With `false`, STARTTLS is used when offered. |
| `SMTP_USER` / `SMTP_PASS` | empty | SMTP credentials. |
| `MAIL_FROM` | `SMTP_USER` | Sender address. |
| `MAIL_TO` | empty | Where response emails go (you). |
| `WEBHOOK_SECRET` | empty | If set, webhooks include `X-Formbuilder-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. |
| `TRUST_PROXY` | `loopback` | Express `trust proxy` setting, so the rate limiter sees the real client IP from Caddy's `X-Forwarded-For`. |

Real environment variables override values in `.env`.

## Where things live on disk

Assuming the app is in `/opt/formbuilder` with default settings:

```
/opt/formbuilder/
├── .env                       # secrets — chmod 600
├── data/
│   ├── forms.db               # all forms, fields and responses (SQLite, WAL mode)
│   ├── forms.db-wal           # WAL files — part of the DB, keep them with it
│   └── forms.db-shm
└── uploads/
    └── <form-slug>/<uuid>.<ext>   # uploaded files; original names are kept in the DB
```

Uploads are **never served publicly**. They are only reachable through the
admin download link (forced `Content-Disposition: attachment`). If you rename a
form's slug, existing files stay in the old folder (the DB stores each file's
path), new files go to the new one.

### Backups

```bash
sqlite3 /opt/formbuilder/data/forms.db ".backup '/backups/forms-$(date +%F).db'"
rsync -a /opt/formbuilder/uploads/ /backups/uploads/
```

Use `.backup` (or stop the service) rather than copying `forms.db` while it runs.

## Caddy

```caddyfile
forms.example.com {
	encode zstd gzip

	# 10 MB per file; this allows two file fields per form plus text.
	# Raise it if a form has more file fields.
	request_body {
		max_size 25MB
	}

	reverse_proxy 127.0.0.1:3000
}
```

Caddy adds `X-Forwarded-For` automatically; with `TRUST_PROXY=loopback` the
app uses it for the per-IP rate limit. Optional extra lock-down for the admin,
e.g. only from your IP:

```caddyfile
	@admin_blocked {
		path /admin*
		not remote_ip 203.0.113.7
	}
	respond @admin_blocked 404
```

## systemd service

`/etc/systemd/system/formbuilder.service`:

```ini
[Unit]
Description=formbuilder
After=network.target

[Service]
Type=simple
User=formbuilder
WorkingDirectory=/opt/formbuilder
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/formbuilder/data /opt/formbuilder/uploads
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/formbuilder --shell /usr/sbin/nologin formbuilder
sudo mkdir -p /opt/formbuilder/data /opt/formbuilder/uploads
sudo chown -R formbuilder: /opt/formbuilder
sudo chmod 600 /opt/formbuilder/.env
sudo systemctl daemon-reload && sudo systemctl enable --now formbuilder
journalctl -u formbuilder -f      # notification failures are logged here
```

## Field types

| Type | Notes |
|---|---|
| Short text | max 500 chars |
| Long text | max 10,000 chars |
| Email | format-checked on client and server |
| Dropdown | options one per line; the answer must be one of them |
| Checkbox | with options → multiple choice; with no options → a single yes/no box (e.g. consent; "required" means it must be checked) |
| File upload | one file, 10 MB max |

Deleting a field hides its column but keeps the stored answers in the DB.

## Webhook payload

```json
{
  "form": { "id": 1, "slug": "contato", "title": "Contato" },
  "response": {
    "id": 42,
    "created_at": "2026-10-18T12:00:00Z",
    "fields": [
      { "id": 3, "label": "Name", "type": "text", "value": "Maria" },
      { "id": 4, "label": "Channels", "type": "checkbox", "value": ["Email", "Phone"] },
      { "id": 5, "label": "Briefing", "type": "file",
        "value": { "name": "briefing.pdf", "size": 52311, "type": "application/pdf",
                   "url": "https://forms.example.com/admin/forms/1/responses/42/files/5" } }
    ]
  }
}
```

Webhook and email are fire-and-forget after the response is saved, with a
10 s timeout and no retries; failures are logged and never block the respondent.
The file `url` needs an admin login to download.

Verify the signature (Node):

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
```

## Spam protection

- Hidden honeypot field `website`: if filled, the bot sees the thank-you page
  and nothing is stored.
- Per-IP rate limit on public POSTs (in memory; resets on restart).
- The admin login is separately limited to 10 attempts per 15 minutes per IP.

## Development

```bash
npm install
ADMIN_TOKEN=dev-token-1234567890 npm start
npm test          # end-to-end tests with temp DB/uploads, local webhook and SMTP sinks
```
