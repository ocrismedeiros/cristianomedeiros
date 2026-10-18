const { loadConfig, loadEnvFile } = require('./config');
const { createApp } = require('./app');

loadEnvFile();
const config = loadConfig();
const { app, repo } = createApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`formbuilder listening on http://${config.host}:${config.port}`);
  console.log(`  database: ${config.dataDir}/forms.db`);
  console.log(`  uploads:  ${config.uploadDir}/`);
});

function shutdown() {
  server.close(() => {
    repo.raw.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
