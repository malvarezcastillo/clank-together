// The original function, for contributors without a local Ghidra: assembly and pseudocode from a
// Ghidra export (ghidra_scripts/ExportOriginals.java, imported with `td-server originals import`),
// and live disassembly by objdump for functions the export does not cover.

import fs from 'node:fs';
import readline from 'node:readline';
import { run } from '../shared/build.js';
import { hex } from '../shared/annotations.js';
import { HttpError } from './http.js';

export class Originals {
  constructor({ store }) {
    this.store = store;
  }

  /** Imports an ExportOriginals JSON-lines file for a version; returns the number of functions. */
  async import(versionId, file) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    let n = 0;
    const insert = this.store.db.prepare(
      `INSERT INTO original_code (version_id, addr, asm, c) VALUES (?, ?, ?, ?)
       ON CONFLICT(version_id, addr) DO UPDATE SET asm = excluded.asm, c = excluded.c`,
    );
    // Rows are written in chunks, each in its own short transaction with no await inside: the
    // worker's other work shares this database connection and must never land in (or be rolled
    // back with) the import's transaction.
    let chunk = [];
    const flush = () => {
      const rows = chunk;
      chunk = [];
      this.store.tx(() => {
        for (const r of rows) insert.run(versionId, Number.parseInt(r.addr, 16), r.asm ?? null, r.c ?? null);
      });
    };
    for await (const line of rl) {
      if (!line.trim()) continue;
      chunk.push(JSON.parse(line));
      n++;
      if (chunk.length >= 2000) flush();
    }
    flush();
    return n;
  }

  /** {symbol, name, version, addr, size, asm, pseudocode, source} for a symbol ID or a hex address. */
  async get(query) {
    const v = this.store.currentVersion();
    if (!v) throw new HttpError(404, 'no current version');
    let sym;
    if (/^0x[0-9a-f]+$/i.test(query)) {
      sym = this.store.get(
        `SELECT s.id, s.name, a.addr, a.size FROM symbol_addresses a JOIN symbols s ON s.id = a.symbol_id WHERE a.version_id = ? AND a.addr = ?`,
        v.id,
        Number.parseInt(query, 16),
      ) ?? { id: null, name: null, addr: Number.parseInt(query, 16), size: null };
    } else {
      sym = this.store.get(
        `SELECT s.id, s.name, a.addr, a.size FROM symbols s LEFT JOIN symbol_addresses a ON a.symbol_id = s.id AND a.version_id = ? WHERE s.id = ? OR s.name = ? OR s.decorated = ? LIMIT 1`,
        v.id,
        query,
        query,
        query,
      );
    }
    if (!sym) throw new HttpError(404, `unknown symbol ${query}`);
    if (sym.addr == null) throw new HttpError(404, `${sym.id} has no address in ${v.id}`);
    const row = this.store.get('SELECT asm, c FROM original_code WHERE version_id = ? AND addr = ?', v.id, sym.addr);
    const asm = row?.asm ?? (await this.objdump(v.file, sym.addr, sym.size ?? 256));
    return {
      symbol: sym.id,
      name: sym.name,
      version: v.id,
      addr: '0x' + hex(sym.addr),
      size: sym.size,
      asm,
      pseudocode: row?.c ?? null,
      source: row ? 'ghidra export' : 'objdump (no pseudocode yet)',
      note: 'Pseudocode is Ghidra output, a reading aid; it is not matching code.',
    };
  }

  async objdump(file, addr, size) {
    const r = await run('objdump', ['-d', '-M', 'intel', '--no-addresses', `--start-address=0x${hex(addr)}`, `--stop-address=0x${hex(addr + Math.min(size, 65536))}`, file], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      // Older binutils lack --no-addresses.
      const r2 = await run('objdump', ['-d', '-M', 'intel', `--start-address=0x${hex(addr)}`, `--stop-address=0x${hex(addr + Math.min(size, 65536))}`, file], { timeoutMs: 30_000 });
      return cleanObjdump(r2.output);
    }
    return cleanObjdump(r.output);
  }
}

function cleanObjdump(out) {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => /^\s*[0-9a-f]+ <|^Disassembly of section/.test(l));
  return lines.slice(start >= 0 ? start : 0).filter((l) => l.trim() && !/^Disassembly of section/.test(l)).join('\n');
}
