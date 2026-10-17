// Contributor operations, shared by the `td` CLI and the MCP server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Api } from './api.js';
import { Workspace, sha256File } from './workspace.js';
import { checkUnits } from '../shared/check.js';
import { reconcile } from '../shared/reconcile.js';
import { lintSubmission, matchesAny } from '../shared/lint.js';
import { isUnit, loadToolchainLock } from '../shared/project.js';
import { hex } from '../shared/annotations.js';
import { run } from '../shared/build.js';

export function api(ws) {
  return new Api(ws.config.server, ws.config.token);
}

/**
 * Creates a workspace: clones the repo, downloads and verifies the target,
 * fetches the symbol snapshot and records toolchain settings.
 */
export async function setup({ server, dir, token, exe, runner, vc, sdk, image, toolchain, log = console.log }) {
  const anon = new Api(server);
  const info = await anon.get('/api/info');
  if (!info.version) throw new Error('the server has no target version yet');

  const abs = path.resolve(dir);
  const existing = new Workspace(abs);
  const useToken = token ?? existing.config.token;
  if (!useToken) {
    throw new Error(`pass --token <API token>. Register at ${server}, wait for an admin to approve you, then create a token under "Account"`);
  }
  // Check the token first: the target download may be limited to approved contributors.
  const authed = new Api(server, useToken);
  const me = await authed.get('/api/me');
  log(`authenticated as ${me.name} (${me.role})`);

  if (!fs.existsSync(path.join(abs, '.git'))) {
    log(`cloning ${info.git} into ${abs}`);
    execFileSync('git', ['clone', '-q', info.git, abs], { stdio: 'inherit' });
  }
  const ws = new Workspace(abs);
  ws.config.server = server.replace(/\/+$/, '');
  ws.config.token = useToken;
  ws.config.user = me.name;
  fs.mkdirSync(ws.tdDir, { recursive: true });
  ensureIgnored(ws);

  if (exe) {
    const got = sha256File(exe);
    if (got !== info.version.sha256) throw new Error(`${exe} is not the target of version ${info.version.id}: sha256 ${got}, expected ${info.version.sha256}`);
    fs.copyFileSync(exe, ws.targetFile);
  } else if (!fs.existsSync(ws.targetFile) || sha256File(ws.targetFile) !== info.version.sha256) {
    if (!info.version.download) throw new Error(`this project does not distribute the target; pass --exe <path to your copy> (sha256 ${info.version.sha256})`);
    log(`downloading target ${info.version.id} (${(info.version.size / 1048576).toFixed(1)} MiB)`);
    await authed.download(info.version.download, ws.targetFile, info.version.sha256);
  }
  log(`target verified: sha256 ${info.version.sha256}`);

  const lock = loadToolchainLock(abs)[info.toolchain] ?? {};
  ws.config.runners = { [info.toolchain]: runnerConfig({ runner, vc, sdk, image: image ?? lock.image, toolchain, project: ws.project }) };
  ws.save();
  await refreshSymbols(ws);
  ws.config.envDigest = await computeEnvDigest(ws, info.toolchain);
  if (lock.clSha256 && ws.config.envDigest !== lock.clSha256) {
    log(`WARNING: your cl.exe (sha256 ${ws.config.envDigest}) is not the pinned one (${lock.clSha256}); results may differ from the server`);
  }
  ws.save();
  return ws;
}

function ensureIgnored(ws) {
  const gi = path.join(ws.dir, '.git', 'info', 'exclude');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes('.td/')) fs.appendFileSync(gi, `${cur.endsWith('\n') || !cur ? '' : '\n'}.td/\n`);
}

function runnerConfig({ runner, vc, sdk, image, toolchain, project }) {
  // --toolchain: a toolchain root laid out like the project's compile commands expect (${TC});
  // the compiler path and include environment come from config/compile.json.
  if (toolchain) {
    if (!project.compile?.compiler) throw new Error('this project has no compile.json compiler entry; use --vc instead of --toolchain');
    const type = runner ?? (os.platform() === 'win32' ? 'native' : 'wine');
    const root = type === 'wine' ? 'Z:' + path.posix.resolve(toolchain).replace(/\//g, '\\') : path.win32.resolve(toolchain);
    const clPath = project.compile.compiler.replaceAll('${TC}', type === 'wine' ? path.posix.resolve(toolchain) : root).replace(type === 'wine' ? /\\/g : /\//g, type === 'wine' ? '/' : '\\');
    if (!fs.existsSync(clPath)) throw new Error(`compiler not found at ${clPath}`);
    const jobs = Math.max(1, os.cpus().length - 2);
    if (type === 'wine') return { type, clPath, wine: 'wine', toolchainRoot: root, jobs, env: { WINEDEBUG: '-all' } };
    return { type, clPath, toolchainRoot: root, jobs, env: { PATH: `${path.dirname(clPath)};${process.env.PATH ?? ''}` } };
  }
  const type = runner ?? (os.platform() === 'win32' && vc ? 'native' : 'docker');
  if (type === 'docker') {
    if (!image) throw new Error('no docker image configured; pass --image or set it in toolchain.lock.json');
    return { type, image };
  }
  if (!vc) throw new Error(`--vc <path to the VC directory of Visual Studio 2010> is required for the ${type} runner`);
  const p = type === 'wine' ? path.posix : path.win32;
  const clPath = p.join(vc, 'bin', 'cl.exe');
  if (type === 'wine') return { type, clPath, wine: 'wine', env: { WINEDEBUG: '-all' } };
  const include = [p.join(vc, 'include'), ...(sdk ? [p.join(sdk, 'Include')] : [])].join(';');
  const lib = [p.join(vc, 'lib'), ...(sdk ? [p.join(sdk, 'Lib')] : [])].join(';');
  const ide = p.join(vc, '..', 'Common7', 'IDE');
  return { type, clPath, env: { INCLUDE: include, LIB: lib, PATH: `${p.join(vc, 'bin')};${ide};${process.env.PATH ?? ''}` } };
}

async function computeEnvDigest(ws, toolchain) {
  const r = ws.config.runners?.[toolchain];
  if (!r) return null;
  if (r.type !== 'docker') return fs.existsSync(r.clPath) ? sha256File(r.clPath) : null;
  const out = await run('docker', ['run', '--rm', '--network', 'none', r.image, 'sha256sum', '/opt/msvc/bin/cl.exe'], { timeoutMs: 120_000 });
  return /^[0-9a-f]{64}/.exec(out.output)?.[0] ?? null;
}

export async function refreshSymbols(ws) {
  const snap = await api(ws).get('/api/symbols');
  fs.writeFileSync(ws.symbolsFile, JSON.stringify(snap));
  ws._symbols = null;
  return snap;
}

/** Fast-forwards the clone to the server's main and refreshes the symbol snapshot. */
export async function sync(ws) {
  ws.git('fetch', '-q', 'origin');
  let pulled = true;
  try {
    ws.git('merge', '-q', '--ff-only', '@{u}');
  } catch {
    pulled = false;
  }
  const snap = await refreshSymbols(ws);
  return { head: ws.head(), fastForwarded: pulled, symbols: snap.symbols.length, note: pulled ? null : 'could not fast-forward (local commits or conflicting changes); merge origin/main yourself' };
}

/** Compiles and compares locally with the same pipeline the server uses. */
export async function check(ws, files) {
  const project = ws.project;
  const targets = files?.length ? files : ws.changedFiles();
  const units = targets.filter(isUnit);
  if (!units.length) throw new Error('nothing to check: pass .cpp files or modify some');
  const result = await checkUnits({
    repoDir: ws.dir,
    jobDir: path.join(ws.tdDir, 'build'),
    project,
    units,
    symbols: ws.symbols,
    nameIndex: ws.nameIndex,
    pe: ws.pe,
    runners: ws.config.runners,
  });
  const rec = reconcile(result, ws.symbols);
  return summarize(result, rec, new Set(targets));
}

/** `files`: the files the user asked about; annotation problems elsewhere in the repo are not theirs. */
export function summarize(result, rec, files = null) {
  return {
    annotationErrors: files ? result.annotationErrors.filter((e) => files.has(e.file)) : result.annotationErrors,
    units: result.units.map((u) => ({
      file: u.file,
      compiled: u.compiled,
      log: u.compiled ? undefined : u.log,
      lintErrors: u.lintErrors,
      errors: u.errors,
      unannotated: u.unannotated,
      functions: u.functions.map((f) => ({
        id: f.id,
        name: f.demangled,
        addr: f.addr != null ? '0x' + hex(f.addr) : null,
        status: f.status,
        score: f.score,
        size: f.size,
        diffRegions: f.diffRegions?.slice(0, 12),
        relocations: f.relocations,
      })),
    })),
    referenceConflicts: rec.conflicts,
    unknownReferences: rec.unknown.map((x) => ({ symbol: x.decorated, addr: '0x' + hex(x.addr) })),
  };
}

/** Submits files for a leased task. Defaults to all changed files the task allows. */
export async function submit(ws, taskId, { files, notes, agentMeta } = {}) {
  const ctx = await api(ws).get(`/api/tasks/${taskId}`);
  const candidates = files?.length ? files : ws.changedFiles().filter((f) => matchesAny(f, ctx.allowedPaths));
  if (!candidates.length) throw new Error(`no changed files match the task's allowed paths (${ctx.allowedPaths.join(', ')})`);
  const contents = {};
  for (const f of candidates) contents[f.replace(/\\/g, '/')] = fs.readFileSync(path.join(ws.dir, f), 'utf8');
  const errors = lintSubmission(contents, { allowedPaths: ctx.allowedPaths, limits: ws.project.lintLimits, allowedPragmas: ws.project.allowedPragmas });
  if (errors.length) {
    const e = new Error('submission fails the static gate:\n' + errors.map((x) => `  ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${x.message}`).join('\n'));
    e.details = errors;
    throw e;
  }
  return api(ws).post(`/api/tasks/${taskId}/submit`, { baseCommit: ws.head(), files: contents, notes, agentMeta, envDigest: ws.config.envDigest });
}

export function relPath(ws, f) {
  return path.relative(ws.dir, path.resolve(f)).replace(/\\/g, '/');
}
