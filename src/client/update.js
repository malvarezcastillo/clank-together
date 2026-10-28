// Self-update of the td binary (only when td runs as the standalone executable; a checkout or
// npm install updates through git/npm). At most once an hour td compares its own SHA-256 with
// the server's /download/SHA256SUMS; a newer build is downloaded, verified and swapped in for
// the next start. TD_NO_UPDATE=1 turns it off.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CHECK_EVERY_MS = 3600_000;
const STALL_MS = 60_000;
const STATE_DIR = path.join(os.homedir(), '.clank');
const STATE_FILE = path.join(STATE_DIR, 'update.json');
const ASSET = process.platform === 'win32' ? 'td-windows-x64.exe' : 'td-linux-x64';

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {}
}

/** Remembers the server for updates of a td that is used outside a workspace. */
export function rememberServer(server) {
  writeState({ ...readState(), server });
}

async function ownHash(exe, state) {
  const st = fs.statSync(exe);
  const key = `${st.size}:${st.mtimeMs}`;
  if (state.selfKey === key && state.selfHash) return state.selfHash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  state.selfKey = key;
  state.selfHash = hash;
  return hash;
}

/**
 * This td's build: the SHA-256 of the standalone executable (cached by size and mtime), or 'dev'
 * when it runs from a checkout. Sent with every request so the server can tell an outdated td.
 */
let buildCache = null;
export async function ownBuild() {
  if (buildCache) return buildCache;
  try {
    const sea = await import('node:sea').catch(() => null);
    if (!sea?.isSea?.()) return (buildCache = 'dev');
    const state = readState();
    buildCache = await ownHash(process.execPath, state);
    writeState(state);
  } catch {
    buildCache = 'unknown';
  }
  return buildCache;
}

/**
 * Checks for and installs a newer td. Returns a message when an update was installed (it takes
 * effect on the next start), otherwise null. Never throws: an update must not break a command.
 */
export async function maybeUpdate({ server, force = false, log = (m) => process.stderr.write(m + '\n') } = {}) {
  try {
    if (process.env.TD_NO_UPDATE === '1') return null;
    const sea = await import('node:sea').catch(() => null);
    if (!sea?.isSea?.()) return null;
    const exe = process.execPath;
    // Leftover from a Windows update (a running .exe can be renamed, not replaced).
    fs.rmSync(exe + '.old', { force: true });

    const state = readState();
    const base = (server ?? state.server)?.replace(/\/+$/, '');
    if (!base) return null;
    if (!force && state.checkedAt && Date.now() - state.checkedAt < CHECK_EVERY_MS) return null;
    state.checkedAt = Date.now();

    const res = await fetch(`${base}/download/SHA256SUMS`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return writeState(state), null;
    const want = new RegExp(`^([0-9a-f]{64})\\s+${ASSET.replace('.', '\\.')}$`, 'm').exec(await res.text())?.[1];
    if (!want || want === (await ownHash(exe, state))) return writeState(state), null;

    log(`td: downloading an update from ${base} ...`);
    // Slow connections take as long as they need; only a download that stalls is given up.
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(), STALL_MS);
    // A new manifest must not reuse a CDN's cached copy of the previous build.
    const bin = await fetch(`${base}/download/${ASSET}?sha256=${want}`, { signal: stall.signal });
    if (!bin.ok) return clearTimeout(timer), writeState(state), null;
    const parts = [];
    for await (const chunk of bin.body) {
      parts.push(chunk);
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), STALL_MS);
    }
    clearTimeout(timer);
    const data = Buffer.concat(parts);
    if (crypto.createHash('sha256').update(data).digest('hex') !== want) {
      log('td: the update failed its checksum check and was not installed');
      return writeState(state), null;
    }
    const next = exe + '.new';
    fs.writeFileSync(next, data, { mode: 0o755 });
    if (process.platform === 'win32') {
      fs.renameSync(exe, exe + '.old');
      fs.renameSync(next, exe);
    } else {
      fs.renameSync(next, exe);
    }
    delete state.selfKey;
    delete state.selfHash;
    writeState(state);
    return 'td was updated; the new version runs from the next command on';
  } catch {
    return null;
  }
}
