// Compiles translation units with the pinned MSVC toolchain.
//
// Runners:
//   docker  cl.exe under Wine inside a locked-down container (required on the server)
//   wine    cl.exe under a local Wine install (Linux contributors, no isolation)
//   native  cl.exe on Windows (contributors only, no isolation)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { unitSettings } from './project.js';
import { CompileCache, compilerId, treeListHash } from './compile-cache.js';
import { acquireSlot } from './slots.js';

export function outputBase(file) {
  return file.replace(/[\/.]/g, '_');
}

/**
 * Copies the source/include dirs of `repoDir` into `jobDir`, then applies `overrides`.
 * `incremental`: keep a job directory left by an earlier run and bring it up to date, copying
 * only files whose size or mtime differ and deleting what the source no longer has (outputs of
 * earlier runs in out/ stay; each unit's are cleared before it compiles). Files written from
 * `overrides` last time are recorded, so they are restored from the source when no longer
 * overridden.
 */
export function prepareJobDir({ repoDir, jobDir, project, overrides = {}, incremental = false }) {
  const record = path.join(jobDir, 'out', '.overrides.json');
  if (!incremental || !fs.existsSync(record)) {
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(jobDir, 'out'), { recursive: true });
    for (const d of new Set([...project.sourceDirs, ...project.includeDirs])) {
      const src = path.join(repoDir, d);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(jobDir, d), { recursive: true });
    }
  } else {
    const stale = new Set(JSON.parse(fs.readFileSync(record, 'utf8')));
    for (const d of new Set([...project.sourceDirs, ...project.includeDirs])) syncTree(path.join(repoDir, d), path.join(jobDir, d), stale, d);
    fs.mkdirSync(path.join(jobDir, 'out'), { recursive: true });
  }
  for (const [rel, content] of Object.entries(overrides)) {
    const dst = path.join(jobDir, rel);
    if (content === null) {
      fs.rmSync(dst, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // Unchanged text keeps its mtime, so nothing that depends on it looks modified.
    let same = false;
    try {
      same = fs.readFileSync(dst).equals(Buffer.from(content));
    } catch {}
    if (!same) fs.writeFileSync(dst, content);
  }
  fs.writeFileSync(record, JSON.stringify(Object.keys(overrides)));
}

/** Mirrors `src` into `dst` by size + mtime; `forced`: repo-relative files to copy regardless. */
function syncTree(src, dst, forced, rel) {
  if (!fs.existsSync(src)) {
    fs.rmSync(dst, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  const have = new Map(fs.readdirSync(dst, { withFileTypes: true }).map((e) => [e.name, e]));
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    const r = `${rel}/${e.name}`;
    const old = have.get(e.name);
    have.delete(e.name);
    if (e.isDirectory()) {
      if (old && !old.isDirectory()) fs.rmSync(d, { force: true });
      syncTree(s, d, forced, r);
      continue;
    }
    if (old?.isDirectory()) fs.rmSync(d, { recursive: true, force: true });
    const a = fs.statSync(s);
    if (old && !forced.has(r)) {
      const b = fs.statSync(d);
      // Whole milliseconds: utimes does not keep every platform's full timestamp precision.
      if (a.size === b.size && Math.floor(a.mtimeMs) === Math.floor(b.mtimeMs)) continue;
    }
    fs.copyFileSync(s, d);
    fs.utimesSync(d, a.atime, a.mtime);
  }
  for (const [name, e] of have) fs.rmSync(path.join(dst, name), { recursive: e.isDirectory(), force: true });
}

/** Fills ${SRC} (repo root as the compiler sees it) and ${TC} (toolchain root) in an argument. */
export function fillPlaceholders(s, roots) {
  return s.replaceAll('${SRC}', roots.src).replaceAll('${TC}', roots.tc ?? '');
}

/**
 * A unit's linkage prelude (project.unitPrelude): `<dir>/<unit path>.h`, forced into the unit with /FI
 * ahead of its own text. It holds the explicit-template declarations that keep standard-library code
 * out of line, so the game source does not carry them. Null when the unit has none.
 */
export function unitPrelude(project, file, exists) {
  const dir = project.unitPrelude;
  if (!dir) return null;
  const rel = `${dir.replace(/\/+$/, '')}/${file}.h`;
  return exists(rel) ? rel : null;
}

function clArgs({ cflags, includeDirs, src, out, toPath, roots, prelude = null }) {
  const flags = cflags.map((f) => fillPlaceholders(f, roots));
  const inc = includeDirs.map((d) => `/I${toPath(d)}`);
  const fi = prelude ? [`/FI${toPath(prelude)}`] : [];
  // /showIncludes lists every included header (dependency tracking); /Z7 puts debug info in the
  // object, which tells where each function is defined (CoffObject.functionLines). Neither
  // changes codegen.
  // `key`: everything that decides the outputs except where they are written (the cache key).
  const key = [...flags, ...inc, ...fi, '/showIncludes', '/Z7', '/FAcs', toPath(src)];
  const compile = [...flags, ...inc, ...fi, '/showIncludes', '/Z7', '/FAcs', `/Fa${toPath(out + '.cod')}`, `/Fo${toPath(out + '.obj')}`, toPath(src)];
  const preprocess = [...flags.filter((f) => f.toLowerCase() !== '/c'), ...inc, ...fi, '/P', `/Fi${toPath(out + '.i')}`, toPath(src)];
  return { key, compile, preprocess };
}

function fillEnv(env, roots) {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, fillPlaceholders(v, roots)]));
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Automatic batches get 30 seconds per work wave, with the caller's timeout as
// a floor and a 20-minute scaling cap. Explicit longer maintenance deadlines win.
export function dockerDeadlineMs({ timeoutMs = 120_000, unitCount, jobs = 1, scaleTimeout = false }) {
  return scaleTimeout ? Math.max(timeoutMs, Math.min(1_200_000, Math.ceil(unitCount / Math.max(1, jobs)) * 30_000)) : timeoutMs;
}

/**
 * @param {object} p
 * @param {string} p.jobDir       prepared by prepareJobDir
 * @param {string[]} p.units      repo-relative .cpp files to compile
 * @param {object} p.project      loaded decomp.json
 * @param {Record<string, object>} p.runners  toolchain name -> runner config
 * @returns {Promise<Array<{file, ok, obj, cod, pre, log}>>}
 */
// preprocess(file): whether to also write the /P output (needed only to lint submitted code).
// cache: for docker runners, {dir, capMb} of a compile-output cache (the server's); local runners
// use the contributor's machine-wide cache unless the runner sets `cache: false`.
export async function compileUnits({ jobDir, units, project, runners, timeoutMs = 120_000, scaleTimeout = false, preprocess = () => true, cache = null }) {
  const byToolchain = new Map();
  for (const file of units) {
    const { cflags, toolchain, env } = unitSettings(project, file);
    if (!byToolchain.has(toolchain)) byToolchain.set(toolchain, []);
    byToolchain.get(toolchain).push({ file, cflags, env, pre: preprocess(file) });
  }
  const results = [];
  for (const [toolchain, list] of byToolchain) {
    const runner = runners?.[toolchain];
    if (!runner) throw new Error(`no runner configured for toolchain "${toolchain}"`);
    if (runner.type === 'docker') results.push(...(await runDocker({ jobDir, list, project, runner, cache, timeoutMs: dockerDeadlineMs({ timeoutMs, unitCount: list.length, jobs: runner.jobs, scaleTimeout }) })));
    else if (runner.type === 'native' || runner.type === 'wine') results.push(...(await runLocal({ jobDir, list, project, runner, timeoutMs })));
    else throw new Error(`unknown runner type "${runner.type}"`);
  }
  return results;
}

function clearOutputs(jobDir, file) {
  const base = path.join(jobDir, 'out', outputBase(file));
  for (const suffix of ['.obj', '.cod', '.i', '.status', '.log']) fs.rmSync(base + suffix, { force: true });
}

function collect(jobDir, file, log, { completed, timedOut, wantPre }) {
  const base = path.join(jobDir, 'out', outputBase(file));
  const exists = (p) => (fs.existsSync(p) ? p : null);
  const ok = completed && !timedOut && !!exists(base + '.obj') && (!wantPre || !!exists(base + '.i'));
  return { file, ok, timedOut, obj: ok ? exists(base + '.obj') : null, cod: ok ? exists(base + '.cod') : null, pre: ok && wantPre ? exists(base + '.i') : null, log, includes: projectIncludes(log, jobDir) };
}

/**
 * Repo-relative headers a unit includes, from cl /showIncludes ("Note: including file: <path>").
 * Paths outside the job directory (compiler and SDK headers) are left out.
 */
export function projectIncludes(log, jobDir) {
  const roots = ['z:\\job\\', path.resolve(jobDir).toLowerCase() + path.sep, 'z:' + path.resolve(jobDir).toLowerCase().replace(/\//g, '\\') + '\\'];
  const out = new Set();
  for (const m of (log ?? '').matchAll(/Note: including file:\s*(.+?)\s*$/gm)) {
    const p = m[1].trim();
    const lower = p.toLowerCase();
    const root = roots.find((r) => lower.startsWith(r));
    if (root) out.add(p.slice(root.length).replace(/\\/g, '/'));
  }
  return [...out];
}

/** The local ID of a Docker image (what `docker run` would start), or null when unknown. */
async function imageId(docker, image) {
  const r = await run(docker, ['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 60_000 });
  const id = r.code === 0 ? r.output.trim() : '';
  return /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

// Docker runner (the server). With `cache` (compileUnits), units whose inputs match an earlier
// compile take its outputs and only the rest go into the container; when every unit hits, no
// container starts. The container runs the image by ID, the same ID the cache key holds. Each
// unit's /P pass runs alongside its compile; its output is kept only when the compile succeeds.
async function runDocker({ jobDir, list, project, runner, timeoutMs, cache: cacheOptions = null }) {
  const toPath = (rel) => 'Z:\\job' + (rel ? '\\' + rel.replace(/\//g, '\\') : '');
  const roots = { src: 'Z:\\job', tc: runner.toolchainRoot ?? 'Z:\\opt\\toolchain' };
  const jobs = runner.jobs ?? 1;
  const docker = runner.docker ?? 'docker';
  const results = new Array(list.length);
  const id = cacheOptions ? await imageId(docker, runner.image) : null;
  const cache = id ? new CompileCache({ jobDir, dir: cacheOptions.dir, capMb: cacheOptions.capMb }) : null;
  const context = cache ? { image: id, tree: treeListHash(jobDir, [...project.sourceDirs, ...project.includeDirs]) } : null;
  const todo = [];
  // One script per unit, run `jobs` at a time inside the container.
  list.forEach(({ file, cflags, env, pre }, i) => {
    const out = `out/${outputBase(file)}`;
    const prelude = unitPrelude(project, file, (rel) => fs.existsSync(path.join(jobDir, rel)));
    const { key: keyArgs, compile, preprocess } = clArgs({ cflags, includeDirs: project.includeDirs, src: file, out, toPath, roots, prelude });
    const filled = fillEnv(env, roots);
    clearOutputs(jobDir, file);
    const key = cache ? cache.manifestKey({ runner, args: keyArgs, root: roots.src, env: filled, file, prelude, context }) : null;
    const hit = key && cache.restore(key, path.join(jobDir, out), { wantPre: pre, root: roots.src });
    if (hit) {
      results[i] = { ...collect(jobDir, file, hit.log, { completed: true, timedOut: false, wantPre: pre }), cached: true };
      return;
    }
    todo.push({ i, file, pre, key });
    const log = shQuote(`/job/${out}.log`);
    const preLog = shQuote(`/job/${out}.pre.log`);
    const exports = Object.entries(filled).map(([k, v]) => `export ${k}=${shQuote(v)}`);
    const status = shQuote(`/job/${out}.status`);
    const cl = (args) => `td_cl ${args.map(shQuote).join(' ')}`;
    const unit = ['. /opt/td/env.sh', ...exports, `echo '== ${file}' > ${log}`,
      ...(pre
        ? [`${cl(preprocess)} > ${preLog} 2>&1 &`, 'p=$!', `${cl(compile)} >> ${log} 2>&1; c=$?`, 'wait $p; q=$?',
          `[ $c -eq 0 ] || { echo failed > ${status}; exit 1; }`, `cat ${preLog} >> ${log}`, `[ $q -eq 0 ] || { echo failed > ${status}; exit 1; }`]
        : [`${cl(compile)} >> ${log} 2>&1 || { echo failed > ${status}; exit 1; }`]),
      `echo complete > ${status}`];
    fs.writeFileSync(path.join(jobDir, out + '.sh'), unit.join('\n') + '\n');
  });
  if (todo.length) {
    const scripts = todo.map(({ file }) => shQuote(`/job/out/${outputBase(file)}.sh`));
    const lines = ['#!/bin/sh', 'set -u', '. /opt/td/env.sh', `printf '%s\\0' ${scripts.join(' ')} | xargs -0 -P ${jobs} -n 1 sh`];
    fs.writeFileSync(path.join(jobDir, 'build.sh'), lines.join('\n') + '\n');
    // With userns-remap the container user maps to an unprivileged host UID, so it
    // needs write access to the job dir. The jobs parent dir stays private (0700).
    fs.chmodSync(jobDir, 0o777);
    fs.chmodSync(path.join(jobDir, 'out'), 0o777);

    // Containerized workers share jobs through a named volume, not daemon-host paths.
    const jobSubpath = runner.jobVolume ? path.relative(runner.jobVolumeRoot, jobDir) : null;
    if (jobSubpath !== null && (!jobSubpath || jobSubpath.startsWith('..') || path.isAbsolute(jobSubpath))) {
      throw new Error('compiler job must be inside jobVolumeRoot');
    }
    const name = `td-${crypto.randomBytes(6).toString('hex')}`;
    const args = [
      'run', '--rm', '--name', name,
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,exec,size=512m',
      '--memory', runner.memory ?? '1g',
      '--memory-swap', runner.memory ?? '1g',
      '--cpus', String(runner.cpus ?? 1),
      '--pids-limit', String(runner.pids ?? 256),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--user', runner.user ?? '1000:1000',
      ...(runner.runtime ? ['--runtime', runner.runtime] : []),
      ...(runner.jobVolume
        ? ['--mount', `type=volume,source=${runner.jobVolume},target=/job,volume-subpath=${jobSubpath}`]
        : ['-v', `${path.resolve(jobDir)}:/job:rw`]),
      id ?? runner.image,
      'sh', '/job/build.sh',
    ];
    const r = await run(docker, args, { timeoutMs, onTimeout: async () => {
      const killed = await run(docker, ['kill', name]);
      if (killed.code !== 0) throw new Error(`could not cancel compiler container ${name}: ${killed.output}`);
    } });
    for (const { i, file, pre, key } of todo) {
      const base = path.join(jobDir, 'out', outputBase(file));
      const status = fs.existsSync(base + '.status') ? fs.readFileSync(base + '.status', 'utf8').trim() : '';
      const timedOut = r.timedOut && status !== 'complete' && status !== 'failed';
      const log = (fs.existsSync(base + '.log') ? fs.readFileSync(base + '.log', 'utf8') : '') + (timedOut ? '\n[build timed out]' : '');
      results[i] = collect(jobDir, file, log, { completed: status === 'complete', timedOut, wantPre: pre });
      if (key && results[i].ok) cache.store(key, base, { includes: results[i].includes, log, hasPre: pre, root: roots.src });
    }
  }
  cache?.prune();
  return results;
}

// Local runners (contributors): each compiler process takes a machine-wide slot (slots.js), so
// several agents compiling at once share the cores instead of oversubscribing them, and each
// unit's outputs go through the machine-wide compile cache (compile-cache.js). The /P pass runs
// alongside the compile; it is discarded when the compile fails.
async function runLocal({ jobDir, list, project, runner, timeoutMs }) {
  const absJob = path.resolve(jobDir);
  const toPath =
    runner.type === 'wine'
      ? (rel) => 'Z:' + path.posix.join(absJob, rel).replace(/\//g, '\\')
      : (rel) => path.join(absJob, rel);
  const roots = { src: toPath('').replace(/[\\/]$/, ''), tc: runner.toolchainRoot };
  const cache = new CompileCache({ jobDir: absJob, dir: runner.cache === false ? null : undefined });
  const context = cache.enabled ? { compiler: compilerId(runner), tree: treeListHash(absJob, [...project.sourceDirs, ...project.includeDirs]) } : null;
  const slot = runner.slots === false ? async () => () => {} : () => acquireSlot();
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const { file, cflags, env: unitEnv, pre: wantPre } = list[i];
      const filled = fillEnv(unitEnv, roots);
      const env = { ...process.env, ...(runner.env ?? {}), ...filled };
      const out = `out/${outputBase(file)}`;
      const base = path.join(absJob, out);
      const prelude = unitPrelude(project, file, (rel) => fs.existsSync(path.join(absJob, rel)));
      const { key: keyArgs, compile, preprocess } = clArgs({ cflags, includeDirs: project.includeDirs, src: file, out, toPath, roots, prelude });
      const [cmd, pre] = runner.type === 'wine' ? [runner.wine ?? 'wine', [runner.clPath]] : [runner.clPath, []];
      clearOutputs(jobDir, file);
      const key = cache.enabled ? cache.manifestKey({ runner, args: keyArgs, root: roots.src, env: filled, file, prelude, context }) : null;
      const hit = key && cache.restore(key, base, { wantPre, root: roots.src });
      if (hit) {
        results[i] = { ...collect(jobDir, file, hit.log, { completed: true, timedOut: false, wantPre }), cached: true };
        continue;
      }
      const step = async (args) => {
        const release = await slot();
        try {
          return await run(cmd, [...pre, ...args], { timeoutMs, env, cwd: absJob });
        } finally {
          release();
        }
      };
      const [a, b] = await Promise.all([step(compile), wantPre ? step(preprocess) : { code: 0, output: '', timedOut: false }]);
      const timedOut = a.timedOut || (a.code === 0 && b.timedOut);
      const log = `== ${file}\n${a.output}${a.code === 0 ? b.output : ''}${timedOut ? '\n[build timed out]' : ''}`;
      results[i] = collect(jobDir, file, log, { completed: a.code === 0 && b.code === 0, timedOut, wantPre });
      if (key && results[i].ok) cache.store(key, base, { includes: results[i].includes, log, hasPre: wantPre, root: roots.src });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, runner.jobs ?? 1) }, worker));
  cache.prune();
  return results;
}

export function run(cmd, args, { timeoutMs = 120_000, env, cwd, onTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd, windowsHide: true });
    let output = '';
    let timedOut = false;
    let cancellation = Promise.resolve();
    const cap = (d) => {
      if (output.length < 200_000) output += d.toString();
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const t = setTimeout(() => {
      timedOut = true;
      cancellation = Promise.resolve().then(() => onTimeout?.());
      // Attach a handler immediately; close still awaits and propagates failure.
      cancellation.catch(() => child.kill('SIGKILL'));
      if (!onTimeout) child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, output: output + `\n${e.message}`, timedOut });
    });
    child.on('close', async (code) => {
      clearTimeout(t);
      try {
        await cancellation;
        resolve({ code, output, timedOut });
      } catch (e) {
        reject(e);
      }
    });
  });
}
