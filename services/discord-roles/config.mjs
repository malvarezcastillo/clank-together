import { resolve } from 'node:path';

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpsOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTPS origin`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin without credentials, path, query or fragment`);
  }
  return url.origin;
}

function integer(env, name, fallback, min, max) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function loadConfig(env = process.env) {
  const publicUrl = httpsOrigin(required(env, 'PUBLIC_URL'), 'PUBLIC_URL');
  const discordClientId = required(env, 'DISCORD_CLIENT_ID');
  if (!/^\d{17,20}$/.test(discordClientId)) throw new Error('DISCORD_CLIENT_ID must be a Discord application ID');
  const discordClientSecret = required(env, 'DISCORD_CLIENT_SECRET');
  const encodedKey = required(env, 'TOKEN_ENCRYPTION_KEY');
  let encryptionKey;
  if (/^[a-f\d]{64}$/i.test(encodedKey)) encryptionKey = Buffer.from(encodedKey, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) encryptionKey = Buffer.from(encodedKey, 'base64');
  if (encryptionKey?.length !== 32 || (!/^[a-f\d]{64}$/i.test(encodedKey) && encryptionKey.toString('base64') !== encodedKey)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes as 64 hex characters or canonical base64');
  }
  const redirectUri = `${publicUrl}/api/discord/callback`;
  if (env.DISCORD_REDIRECT_URI && env.DISCORD_REDIRECT_URI !== redirectUri) {
    throw new Error('DISCORD_REDIRECT_URI must equal PUBLIC_URL + /api/discord/callback');
  }
  const sourceDbPath = resolve(required(env, 'SOURCE_DB_PATH'));
  const databasePath = resolve(env.STATE_DB_PATH?.trim() || './data/roles.sqlite');
  if (sourceDbPath === databasePath) throw new Error('SOURCE_DB_PATH and STATE_DB_PATH must be different files');
  const host = env.HOST?.trim() || '127.0.0.1';
  return Object.freeze({
    publicUrl,
    discordClientId,
    discordClientSecret,
    redirectUri,
    encryptionKey,
    sourceDbPath,
    databasePath,
    clankApiUrl: httpsOrigin(env.CLANK_API_URL?.trim() || 'https://rodecomp.online', 'CLANK_API_URL'),
    syncIntervalMs: integer(env, 'SYNC_INTERVAL_SECONDS', 60, 10, 86400) * 1000,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    httpTimeoutMs: 10000,
    host,
    port: integer(env, 'PORT', 19581, 1, 65535),
  });
}
