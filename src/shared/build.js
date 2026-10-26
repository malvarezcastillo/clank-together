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

export function outputBase(file) {
  return file.replace(/[\/.]/g, '_');
}

/** Copies the source/include dirs of `repoDir` into `jobDir`, then applies `overrides`. */
export function prepareJobDir({ repoDir, jobDir, project, overrides = {} }) {
  fs.rmSync(jobDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(jobDir, 'out'), { recursive: true });
  for (const d of new Set([...project.sourceDirs, ...project.includeDirs])) {
    const src = path.join(repoDir, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(jobDir, d), { recursive: true });
  }
  for (const [rel, content] of Object.entries(overrides)) {
    const dst = path.join(jobDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
  }
}

/** Fills ${SRC} (repo root as the compiler sees it) and ${TC} (toolchain root) in an argument. */
export function fillPlaceholders(s, roots) {
  return s.replaceAll('${SRC}', roots.src).replaceAll('${TC}', roots.tc ?? '');
}

function clArgs({ cflags, includeDirs, src, out, toPath, roots }) {
  const flags = cflags.map((f) => fillPlaceholders(f, roots));
  const inc = includeDirs.map((d) => `/I${toPath(d)}`);
  // /showIncludes lists every included header (dependency tracking); /Z7 puts debug info in the
  // object, which tells where each function is defined (CoffObject.functionLines). Neither
  // changes codegen.
  const compile = [...flags, ...inc, '/showIncludes', '/Z7', '/FAcs', `/Fa${toPath(out + '.cod')}`, `/Fo${toPath(out + '.obj')}`, toPath(src)];
  const preprocess = [...flags.filter((f) => f.toLowerCase() !== '/c'), ...inc, '/P', `/Fi${toPath(out + '.i')}`, toPath(src)];
  return { compile, preprocess };
}

function fillEnv(env, roots) {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, fillPlaceholders(v, roots)]));
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * @param {object} p
 * @param {string} p.jobDir       prepared by prepareJobDir
 * @param {string[]} p.units      repo-relative .cpp files to compile
 * @param {object} p.project      loaded decomp.json
 * @param {Record<string, object>} p.runners  toolchain name -> runner config
 * @returns {Promise<Array<{file, ok, obj, cod, pre, log}>>}
 */
// preprocess(file): whether to also write the /P output (needed only to lint submitted code).
export async function compileUnits({ jobDir, units, project, runners, timeoutMs = 120_000, preprocess = () => true }) {
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
    if (runner.type === 'docker') results.push(...(await runDocker({ jobDir, list, project, runner, timeoutMs })));
    else if (runner.type === 'native' || runner.type === 'wine') results.push(...(await runLocal({ jobDir, list, project, runner, timeoutMs })));
    else throw new Error(`unknown runner type "${runner.type}"`);
  }
  return results;
}

function collect(jobDir, file, log) {
  const base = path.join(jobDir, 'out', outputBase(file));
  const exists = (p) => (fs.existsSync(p) ? p : null);
  const obj = exists(base + '.obj');
  return { file, ok: !!obj, obj, cod: exists(base + '.cod'), pre: exists(base + '.i'), log, includes: projectIncludes(log, jobDir) };
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

async function runDocker({ jobDir, list, project, runner, timeoutMs }) {
  const toPath = (rel) => 'Z:\\job' + (rel ? '\\' + rel.replace(/\//g, '\\') : '');
  const roots = { src: 'Z:\\job', tc: runner.toolchainRoot ?? 'Z:\\opt\\toolchain' };
  const jobs = runner.jobs ?? 1;
  // One script per unit, run `jobs` at a time inside the container.
  for (const { file, cflags, env, pre } of list) {
    const out = `out/${outputBase(file)}`;
    const { compile, preprocess } = clArgs({ cflags, includeDirs: project.includeDirs, src: file, out, toPath, roots });
    const log = `/job/${out}.log`;
    const exports = Object.entries(fillEnv(env, roots)).map(([k, v]) => `export ${k}=${shQuote(v)}`);
    const unit = ['. /opt/td/env.sh', ...exports, `echo '== ${file}' > ${shQuote(log)}`, `td_cl ${compile.map(shQuote).join(' ')} >> ${shQuote(log)} 2>&1`, ...(pre ? [`td_cl ${preprocess.map(shQuote).join(' ')} >> ${shQuote(log)} 2>&1`] : [])];
    fs.writeFileSync(path.join(jobDir, out + '.sh'), unit.join('\n') + '\n');
  }
  const lines = ['#!/bin/sh', 'set -u', '. /opt/td/env.sh', `ls /job/out/*.sh | xargs -P ${jobs} -n 1 sh`];
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
    runner.image,
    'sh', '/job/build.sh',
  ];
  const docker = runner.docker ?? 'docker';
  const r = await run(docker, args, { timeoutMs, onTimeout: () => spawn(docker, ['kill', name]) });
  return list.map(({ file }) => {
    const logFile = path.join(jobDir, 'out', outputBase(file) + '.log');
    const log = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '') + (r.timedOut ? '\n[build timed out]' : '');
    return collect(jobDir, file, log);
  });
}

async function runLocal({ jobDir, list, project, runner, timeoutMs }) {
  const absJob = path.resolve(jobDir);
  const toPath =
    runner.type === 'wine'
      ? (rel) => 'Z:' + path.posix.join(absJob, rel).replace(/\//g, '\\')
      : (rel) => path.join(absJob, rel);
  const roots = { src: toPath('').replace(/[\\/]$/, ''), tc: runner.toolchainRoot };
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const { file, cflags, env: unitEnv, pre: wantPre } = list[i];
      const env = { ...process.env, ...(runner.env ?? {}), ...fillEnv(unitEnv, roots) };
      const out = `out/${outputBase(file)}`;
      const { compile, preprocess } = clArgs({ cflags, includeDirs: project.includeDirs, src: file, out, toPath, roots });
      const [cmd, pre] = runner.type === 'wine' ? [runner.wine ?? 'wine', [runner.clPath]] : [runner.clPath, []];
      const a = await run(cmd, [...pre, ...compile], { timeoutMs, env, cwd: absJob });
      const b = wantPre ? await run(cmd, [...pre, ...preprocess], { timeoutMs, env, cwd: absJob }) : { output: '', timedOut: false };
      results[i] = collect(jobDir, file, `== ${file}\n${a.output}${b.output}${a.timedOut || b.timedOut ? '\n[build timed out]' : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, runner.jobs ?? 1) }, worker));
  return results;
}

export function run(cmd, args, { timeoutMs = 120_000, env, cwd, onTimeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, windowsHide: true });
    let output = '';
    let timedOut = false;
    const cap = (d) => {
      if (output.length < 200_000) output += d.toString();
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const t = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, output: output + `\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, output, timedOut });
    });
  });
}
