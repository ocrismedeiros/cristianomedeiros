const path = require('node:path');

// Load .env (Node >= 20.12) without pulling in dotenv. Real env vars win.
function loadEnvFile() {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function int(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function loadConfig(env = process.env) {
  const root = path.join(__dirname, '..');
  const cfg = {
    port: int(env, 'PORT', 3000),
    host: env.HOST || '127.0.0.1',
    adminToken: env.ADMIN_TOKEN || '',
    baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
    dataDir: path.resolve(root, env.DATA_DIR || 'data'),
    uploadDir: path.resolve(root, env.UPLOAD_DIR || 'uploads'),
    maxUploadBytes: 10 * 1024 * 1024,
    rateLimit: {
      max: int(env, 'RATE_LIMIT_MAX', 10),
      windowMs: int(env, 'RATE_LIMIT_WINDOW_MIN', 15) * 60 * 1000,
    },
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env, 'SMTP_PORT', 587),
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || env.SMTP_USER || '',
      to: env.MAIL_TO || '',
    },
    webhookSecret: env.WEBHOOK_SECRET || '',
    trustProxy: env.TRUST_PROXY || 'loopback',
  };
  if (cfg.adminToken.length < 16) {
    throw new Error('ADMIN_TOKEN must be set and at least 16 characters long');
  }
  return cfg;
}

module.exports = { loadConfig, loadEnvFile };
