#!/usr/bin/env node
// Builds `td` as standalone executables (Node single executable applications): contributors need
// no Node.js. Output in dist/: td-windows-x64.exe, td-linux-x64, SHA256SUMS.
//
//   node tools/build-td/build.mjs
//
// Needs network access once (esbuild and postject through npx, the Linux Node runtime from
// nodejs.org, checked against its published SHA256SUMS). Uses the Node runtime that runs this
// script for Windows, so build with the same Node version as NODE_VERSION.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const NODE_VERSION = 'v22.21.0';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const SCRIPTS = ['ApplySymbols.java', 'DecompileAt.java', 'DisassembleAt.java', 'ExportFunctions.java', 'ExportOriginals.java'];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (process.version !== NODE_VERSION) throw new Error(`build with Node ${NODE_VERSION} (this is ${process.version})`);
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. One CommonJS file (single executable applications run a CommonJS script).
sh(npx, ['--yes', 'esbuild@0.24.0', 'src/client/cli.js', '--bundle', '--platform=node', '--target=node22', '--format=cjs', '--log-level=warning', `--outfile=${path.join(DIST, 'td.cjs')}`]);

// 2. The preparation blob: code plus the embedded Ghidra scripts. No code cache or snapshot, so
//    the same blob works for every platform's Node runtime.
const config = {
  main: path.join(DIST, 'td.cjs'),
  output: path.join(DIST, 'td.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: Object.fromEntries(SCRIPTS.map((s) => [s, path.join(ROOT, 'ghidra_scripts', s)])),
};
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { stdio: 'inherit' });

// 3. Runtimes: this Node for Windows (when building on Windows), the official Linux build otherwise.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-build-'));
const targets = [];
if (process.platform === 'win32') {
  const exe = path.join(DIST, 'td-windows-x64.exe');
  fs.copyFileSync(process.execPath, exe);
  targets.push(exe);
} else {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = /^([0-9a-f]{64})\s+win-x64\/node\.exe$/m.exec(sums)?.[1];
  if (!want) throw new Error('no checksum for the Windows runtime');
  const exe = path.join(DIST, 'td-windows-x64.exe');
  fs.writeFileSync(exe, Buffer.from(await (await fetch(`${base}/win-x64/node.exe`)).arrayBuffer()));
  if (sha256(exe) !== want) throw new Error('Windows runtime checksum mismatch');
  targets.push(exe);
}
{
  const name = `node-${NODE_VERSION}-linux-x64`;
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = new RegExp(`^([0-9a-f]{64})\\s+${name}\\.tar\\.gz$`, 'm').exec(sums)?.[1];
  if (!want) throw new Error('no checksum for the Linux runtime');
  const tgz = path.join(tmp, `${name}.tar.gz`);
  fs.writeFileSync(tgz, Buffer.from(await (await fetch(`${base}/${name}.tar.gz`)).arrayBuffer()));
  if (sha256(tgz) !== want) throw new Error('Linux runtime checksum mismatch');
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-xzf', tgz, '-C', tmp, `${name}/bin/node`], { stdio: 'inherit' });
  const bin = path.join(DIST, 'td-linux-x64');
  fs.copyFileSync(path.join(tmp, name, 'bin', 'node'), bin);
  targets.push(bin);
}

// 4. Inject the blob into each runtime.
for (const t of targets) {
  const args = ['--yes', 'postject@1.0.0-alpha.6', t, 'NODE_SEA_BLOB', config.output, '--sentinel-fuse', FUSE];
  sh(npx, args);
}

fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), targets.map((t) => `${sha256(t)}  ${path.basename(t)}`).join('\n') + '\n');
for (const f of ['td.cjs', 'td.blob', 'sea-config.json']) fs.rmSync(path.join(DIST, f));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fs.readFileSync(path.join(DIST, 'SHA256SUMS'), 'utf8'));
