import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { validateConfig } from './availability.js';
import { openDb } from './db.js';
import { createGoogle } from './google.js';
import { createMailer } from './mailer.js';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const env = { ...process.env };
env.PORT ||= '3000';
env.PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${env.PORT}`).replace(/\/+$/, '');

if (!env.SIGNING_SECRET || env.SIGNING_SECRET.length < 32) {
  console.error('SIGNING_SECRET ausente ou curto no .env (mínimo 32 caracteres). Gere com:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const config = validateConfig(JSON.parse(readFileSync(new URL(env.CONFIG_PATH || '../config.json', import.meta.url), 'utf8')));
const db = openDb(env.DATABASE_PATH || new URL('../data/booking.db', import.meta.url).pathname);
const log = console;
const google = createGoogle({ env, config, db, log });
const mailer = createMailer({ env, log });
const server = createServer(createApp({ env, config, db, google, mailer, log }));

server.listen(Number(env.PORT), () => {
  log.info(`Página de reservas em ${env.PUBLIC_URL} (porta ${env.PORT})`);
  if (!google.enabled) log.warn('Google desativado: disponibilidade só pelas reservas locais.');
  else if (!google.isConnected()) log.warn(`Google não conectado: abra ${env.PUBLIC_URL}/admin?key=… para conectar. Até lá, a página não mostra horários.`);
  if (!env.SMTP_HOST) log.warn('SMTP_HOST vazio: e-mails só são impressos no console.');
  else mailer.verify().catch((err) => log.error('[mail] SMTP não respondeu:', err.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.raw.close(); process.exit(0); }));
}
