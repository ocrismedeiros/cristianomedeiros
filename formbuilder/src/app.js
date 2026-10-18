const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { createNotifier } = require('./notify');
const { publicRouter } = require('./public');
const { adminRouter } = require('./admin');

function createApp(config, { notifier } = {}) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const repo = openDb(config.dataDir);
  notifier = notifier || createNotifier(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "form-action 'self'; base-uri 'none'; object-src 'none'" +
        (req.path.startsWith('/f/') ? '' : "; frame-ancestors 'none'"),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    if (req.path.startsWith('/admin')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use(publicRouter({ config, repo, notifier }));
  app.use('/admin', adminRouter({ config, repo }));

  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).type('text').send(err.expose ? err.message : 'Something went wrong');
  });

  return { app, repo };
}

module.exports = { createApp };
