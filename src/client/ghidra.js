// Pinned, headless Ghidra for contributors and their agents.
//
// The local Ghidra project is a disposable cache: it is rebuilt from the target
// exe plus the symbol snapshot, so everyone sees the same names. Nothing done in
// Ghidra flows back except through source code and symbol requests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../shared/build.js';
import { hex } from '../shared/annotations.js';
import { loadToolchainLock } from '../shared/project.js';
import { Api } from './api.js';

const SCRIPT_NAMES = ['ApplySymbols.java', 'DecompileAt.java', 'DisassembleAt.java', 'ExportFunctions.java', 'ExportOriginals.java'];

/**
 * The Ghidra scripts: next to the sources when run from a checkout or npm install; extracted
 * into the workspace when td runs as a single executable (they are embedded as assets).
 */
async function scriptsDir(ws) {
  const sea = await import('node:sea').catch(() => null);
  if (sea?.isSea?.()) {
    const dir = path.join(ws.tdDir, 'ghidra_scripts');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SCRIPT_NAMES) fs.writeFileSync(path.join(dir, name), sea.getAsset(name, 'utf8'));
    return dir;
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ghidra_scripts');
}
const PROJECT_NAME = 'td';
const PROGRAM = 'target.exe';

export function ghidraHome(ws) {
  return ws.config.ghidraHome ?? null;
}

function headless(ws) {
  const home = ghidraHome(ws);
  if (!home) throw new Error('Ghidra is not configured; run `td ghidra install` or `td config ghidraHome <dir>`');
  const exe = path.join(home, 'support', os.platform() === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
  if (!fs.existsSync(exe)) throw new Error(`analyzeHeadless not found at ${exe}`);
  return exe;
}

async function runHeadless(ws, args, timeoutMs) {
  const exe = headless(ws);
  const projDir = path.join(ws.tdDir, 'ghidra');
  fs.mkdirSync(projDir, { recursive: true });
  const full = [projDir, PROJECT_NAME, ...args, '-scriptPath', await scriptsDir(ws)];
  // .bat files need a shell on Windows.
  const r = os.platform() === 'win32' ? await run('cmd.exe', ['/d', '/s', '/c', exe, ...full], { timeoutMs }) : await run(exe, full, { timeoutMs });
  if (r.code !== 0) throw new Error(`Ghidra failed (exit ${r.code}):\n${r.output.slice(-4000)}`);
  return r.output;
}

/** Downloads and unpacks the Ghidra release pinned in data/toolchain.lock.json. */
export async function installGhidra(ws) {
  const lock = loadToolchainLock(ws.dir).ghidra;
  if (!lock?.url || !lock?.sha256) throw new Error('data/toolchain.lock.json has no ghidra { url, sha256, dir } entry');
  const toolsDir = path.join(ws.tdDir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  const zip = path.join(toolsDir, path.basename(new URL(lock.url).pathname));
  if (!fs.existsSync(zip)) {
    console.log(`downloading ${lock.url}`);
    await new Api('').download(lock.url, zip, lock.sha256);
  }
  // Windows' own tar.exe (bsdtar) unpacks zip files; a GNU tar earlier on PATH (Git Bash) would not.
  const winTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const r = os.platform() === 'win32' ? await run(winTar, ['-xf', zip, '-C', toolsDir], { timeoutMs: 600_000 }) : await run('unzip', ['-q', '-o', zip, '-d', toolsDir], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`could not unpack Ghidra: ${r.output}`);
  ws.config.ghidraHome = path.join(toolsDir, lock.dir);
  ws.save();
  return ws.config.ghidraHome;
}

function writeSymbolFile(ws) {
  const file = path.join(ws.tdDir, 'ghidra-symbols.tsv');
  const lines = [];
  for (const s of ws.symbols.values()) {
    if (s.addr == null) continue;
    lines.push([hex(s.addr), s.kind, s.id, s.name ?? '', s.decorated ?? '', s.library ? 1 : 0].join('\t'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** (Re)creates the local Ghidra project from the target exe and the symbol snapshot. */
export async function buildGhidraProject(ws) {
  const projDir = path.join(ws.tdDir, 'ghidra');
  fs.rmSync(projDir, { recursive: true, force: true });
  const symFile = writeSymbolFile(ws);
  await runHeadless(ws, ['-import', ws.targetFile, '-overwrite', '-postScript', 'ApplySymbols.java', symFile], 3_600_000);
  ws.config.ghidraSnapshot = JSON.parse(fs.readFileSync(ws.symbolsFile, 'utf8')).head;
  ws.save();
}

/** Re-applies the symbol snapshot to an existing project (after `td sync`). */
export async function syncGhidraProject(ws) {
  const symFile = writeSymbolFile(ws);
  await runHeadless(ws, ['-process', PROGRAM, '-noanalysis', '-postScript', 'ApplySymbols.java', symFile], 1_800_000);
}

async function query(ws, script, args) {
  const out = path.join(os.tmpdir(), `td-ghidra-${process.pid}-${Date.now()}.txt`);
  try {
    await runHeadless(ws, ['-process', PROGRAM, '-noanalysis', '-readOnly', '-postScript', script, ...args, out], 600_000);
    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(out, { force: true });
  }
}

export function decompile(ws, addr) {
  return query(ws, 'DecompileAt.java', ['0x' + hex(addr)]);
}

export function disassemble(ws, addr) {
  return query(ws, 'DisassembleAt.java', ['0x' + hex(addr)]);
}

/**
 * Downloads the server's Ghidra project (built and refreshed on the server, with the shared symbol
 * names) into the workspace, replacing the local one. Nothing happens when it is up to date.
 */
export async function downloadGhidraProject(ws, { force = false } = {}) {
  const client = new Api(ws.config.server, ws.config.token);
  const info = await client.get('/api/ghidra-project');
  if (!force && ws.config.ghidraPackage === info.sha256 && fs.existsSync(path.join(ws.tdDir, 'ghidra', `${PROJECT_NAME}.gpr`))) {
    return { updated: false, info };
  }
  const tgz = path.join(ws.tdDir, 'ghidra-project.tar.gz');
  console.error(`downloading the Ghidra project of ${info.version} (${(info.size / 1048576).toFixed(0)} MB)...`);
  await client.download(info.download, tgz, info.sha256);
  const projDir = path.join(ws.tdDir, 'ghidra');
  fs.rmSync(projDir, { recursive: true, force: true });
  fs.mkdirSync(projDir, { recursive: true });
  const tar = os.platform() === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  const r = await run(tar, ['-xzf', tgz, '-C', projDir], { timeoutMs: 1800_000 });
  if (r.code !== 0) throw new Error(`could not unpack the Ghidra project: ${r.output}`);
  fs.rmSync(tgz, { force: true });
  ws.config.ghidraPackage = info.sha256;
  ws.save();
  return { updated: true, info };
}
