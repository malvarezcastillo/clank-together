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

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ghidra_scripts');
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
  const full = [projDir, PROJECT_NAME, ...args, '-scriptPath', SCRIPTS_DIR];
  // .bat files need a shell on Windows.
  const r = os.platform() === 'win32' ? await run('cmd.exe', ['/d', '/s', '/c', exe, ...full], { timeoutMs }) : await run(exe, full, { timeoutMs });
  if (r.code !== 0) throw new Error(`Ghidra failed (exit ${r.code}):\n${r.output.slice(-4000)}`);
  return r.output;
}

/** Downloads and unpacks the Ghidra release pinned in toolchain.lock.json. */
export async function installGhidra(ws) {
  const lock = loadToolchainLock(ws.dir).ghidra;
  if (!lock?.url || !lock?.sha256) throw new Error('toolchain.lock.json has no ghidra { url, sha256, dir } entry');
  const toolsDir = path.join(ws.tdDir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  const zip = path.join(toolsDir, path.basename(new URL(lock.url).pathname));
  if (!fs.existsSync(zip)) {
    console.log(`downloading ${lock.url}`);
    await new Api('').download(lock.url, zip, lock.sha256);
  }
  const r = os.platform() === 'win32' ? await run('tar', ['-xf', zip, '-C', toolsDir], { timeoutMs: 600_000 }) : await run('unzip', ['-q', '-o', zip, '-d', toolsDir], { timeoutMs: 600_000 });
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
