import { loadConfig } from './config.mjs';
import { createCore } from './core.mjs';
import { createApp } from './app.mjs';

let core;
let server;
let timer;
let syncing;
let stopping = false;

async function synchronize() {
  if (stopping || syncing) return;
  syncing = core.syncAll();
  try { await syncing; }
  catch { console.error('Discord role synchronization failed; the next scheduled run will retry.'); }
  finally { syncing = null; }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  if (server?.listening) {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await syncing;
  await core?.close();
  clearTimeout(deadline);
}

try {
  const config = loadConfig();
  core = createCore(config);
  core.getSourceUser(0);
  server = createApp(config, core);
  server.on('error', () => {
    console.error('HTTP listener failed; check HOST, PORT and port availability.');
    process.exitCode = 1;
    void shutdown();
  });
  server.listen(config.port, config.host, () => {
    console.info('Discord linked roles service is ready.');
    void synchronize();
    timer = setInterval(() => void synchronize(), config.syncIntervalMs);
    timer.unref();
  });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch (error) {
  // Configuration errors contain field names only. Database/remote errors may contain secrets.
  const known = /^(PUBLIC_URL|DISCORD_CLIENT_ID|DISCORD_CLIENT_SECRET|DISCORD_REDIRECT_URI|TOKEN_ENCRYPTION_KEY|SOURCE_DB_PATH|STATE_DB_PATH|CLANK_API_URL|SYNC_INTERVAL_SECONDS|PORT)\b/;
  console.error(known.test(error?.message || '') ? error.message : 'Service startup failed; check database paths, read permissions and encryption configuration.');
  await core?.close();
  process.exitCode = 1;
}
