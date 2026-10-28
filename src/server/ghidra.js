// The server's own Ghidra project of the current target version, kept up to date with the symbol
// database. Contributors download it (td ghidra download) instead of analyzing the exe
// themselves, and the coordinator exports assembly and pseudocode from it for /api/original.
//
//   build    import + auto-analysis + symbol names (once per version, ~15 min)
//   refresh  re-apply the names, re-export the originals, pack the project (a few minutes);
//            runs on its own after merges, at most every `ghidraRefreshMinutes` (default 30)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from '../shared/build.js';
import { hex } from '../shared/annotations.js';
import { GHIDRA_RELEASE, ghidraVersionAt } from '../shared/ghidra.js';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ghidra_scripts');
const PROJECT = 'td';
const PROGRAM = 'target.exe';

export class ServerGhidra {
  constructor({ config, store, originals, log = console }) {
    Object.assign(this, { config, store, originals, log });
    this.dir = path.join(config.dataDir, 'ghidra');
    this.projectDir = path.join(this.dir, 'project');
    this.busy = null;
    this.timer = null;
  }

  get enabled() {
    return !!this.config.ghidraHome && fs.existsSync(path.join(this.config.ghidraHome, 'support', 'analyzeHeadless'));
  }

  /** Metadata of the packed project, or null. */
  info() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  packagePath() {
    const i = this.info();
    return i ? path.join(this.dir, i.file) : null;
  }

  async headless(args, timeoutMs) {
    fs.mkdirSync(this.projectDir, { recursive: true });
    const exe = path.join(this.config.ghidraHome, 'support', 'analyzeHeadless');
    // Ghidra 12.2 needs JDK 25; `ghidraJavaHome` overrides a different default JDK.
    const javaHome = this.config.ghidraJavaHome ?? process.env.JAVA_HOME;
    const env = { ...process.env, MAXMEM: this.config.ghidraMaxMem ?? '6G', ...(javaHome ? { JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${process.env.PATH}` } : {}) };
    const r = await run(exe, [this.projectDir, PROJECT, ...args, '-scriptPath', SCRIPTS_DIR], { timeoutMs, env });
    if (r.code !== 0) throw new Error(`Ghidra failed (exit ${r.code}): ${r.output.slice(-2000)}`);
    return r.output;
  }

  writeSymbols(versionId) {
    const file = path.join(this.dir, 'symbols.tsv');
    const lines = [];
    for (const s of this.store.symbolMap(versionId).values()) {
      if (s.addr == null) continue;
      lines.push([hex(s.addr), s.kind, s.id, s.name ?? '', s.decorated ?? '', s.library ? 1 : 0].join('\t'));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  /** Creates the project from the current version's exe (replacing an old one). */
  async build() {
    const v = this.store.currentVersion();
    fs.rmSync(this.projectDir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    const exe = path.join(this.dir, PROGRAM);
    fs.copyFileSync(v.file, exe);
    this.log.info(`ghidra: analyzing ${v.id} (this takes a while)`);
    await this.headless(['-import', exe, '-overwrite', '-postScript', 'ApplySymbols.java', this.writeSymbols(v.id)], 4 * 3600_000);
    fs.rmSync(exe, { force: true });
    this.store.setMeta('ghidra.version', v.id);
    await this.refresh({ applySymbols: false });
  }

  /** Re-applies the symbol names, re-exports the originals and packs the project. */
  async refresh({ applySymbols = true } = {}) {
    const v = this.store.currentVersion();
    if (this.store.getMeta('ghidra.version') !== v.id) return this.build();
    const t0 = Date.now();
    if (applySymbols) await this.headless(['-process', PROGRAM, '-noanalysis', '-postScript', 'ApplySymbols.java', this.writeSymbols(v.id)], 3600_000);
    const jsonl = path.join(this.dir, 'originals.jsonl');
    await this.headless(['-process', PROGRAM, '-noanalysis', '-readOnly', '-postScript', 'ExportOriginals.java', jsonl, '30'], 6 * 3600_000);
    const n = await this.originals.import(v.id, jsonl);
    fs.rmSync(jsonl, { force: true });

    // Pack the project for download (tar.gz: Windows' tar.exe and Linux tar both unpack it).
    const head = this.store.getMeta('ghidra.commit') ?? null;
    const name = `ghidra-${v.id}-${Date.now()}.tar.gz`;
    const tmp = path.join(this.dir, name + '.part');
    const r = await run('tar', ['-czf', tmp, '-C', this.projectDir, `${PROJECT}.gpr`, `${PROJECT}.rep`], { timeoutMs: 1800_000 });
    if (r.code !== 0) throw new Error(`packing the Ghidra project failed: ${r.output}`);
    const old = this.info();
    fs.renameSync(tmp, path.join(this.dir, name));
    const sha256 = await sha256File(path.join(this.dir, name));
    const ghidra = ghidraVersionAt(this.config.ghidraHome) ?? this.config.ghidraVersion ?? GHIDRA_RELEASE.version;
    const info = { version: v.id, file: name, sha256, size: fs.statSync(path.join(this.dir, name)).size, builtAt: Date.now(), commit: head, functions: n, ghidra };
    fs.writeFileSync(path.join(this.dir, 'package.json'), JSON.stringify(info, null, 2));
    if (old?.file && old.file !== name) fs.rmSync(path.join(this.dir, old.file), { force: true });
    this.store.setMeta('ghidra.refreshedAt', Date.now());
    this.log.info(`ghidra: refreshed ${v.id} in ${((Date.now() - t0) / 1000).toFixed(0)}s (${n} functions exported, package ${(info.size / 1048576).toFixed(0)} MB)`);
    return info;
  }

  /** Called after merges: refresh soon, but at most every ghidraRefreshMinutes. */
  scheduleRefresh(commit) {
    if (!this.enabled) return;
    if (commit) this.store.setMeta('ghidra.commit', commit);
    if (this.timer || this.busy) return;
    const every = (this.config.ghidraRefreshMinutes ?? 30) * 60_000;
    const last = Number(this.store.getMeta('ghidra.refreshedAt') ?? 0);
    const wait = Math.max(0, last + every - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.busy = this.refresh()
        .catch((e) => this.log.error(`ghidra refresh failed: ${e.message}`))
        .finally(() => {
          this.busy = null;
        });
    }, wait);
    this.timer.unref?.();
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
