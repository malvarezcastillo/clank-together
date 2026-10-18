#!/usr/bin/env node
// Administration CLI for the coordinator server.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openServer, startServer, DEFAULT_CONFIG } from './app.js';
import { Store, now } from './db.js';
import { Accounts } from './accounts.js';
import { PEImage } from '../shared/pe.js';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'template');

const HELP = `td-server - Clank Together coordinator

Usage: td-server <command> [options]   (all commands accept --data <dir>, default ./data)

  init                                   create data dir, server.json and the canonical repo
  start                                  run the coordinator
  user add <name> [--role R] [--password-stdin]
                                         create an active account (contributor|reviewer|maintainer|admin);
                                         without --password-stdin a password is generated and printed
  user list [--status pending|active|revoked]
  user approve|reject|revoke|reinstate <name>
  user role <name> --role R
  user password <name> [--password-stdin] reset a password (logs out browser sessions)
  user token <name> [label]              create an API token for an account
  version add <id> <exe> [--current]     register a target executable version
  version set-current <id>
  version label <id> <text>              readable name shown on the website
  version map <newId> <csv> --from <oldId>
                                         carry symbol IDs to a new version (csv: old_addr,new_addr[,size])
  symbols import <csv> [--version <id>]  import functions (csv: addr,size,name[,library]) e.g. from
                                         ghidra_scripts/ExportFunctions.java
  symbols load <symbols.json>            import symbols with fixed IDs and per-version addresses
  symbols units <csv>                    assign functions to translation units (csv: start,end,file)
  symbols library <id...>                mark symbols as library code (no tasks)
  originals import <jsonl> [--version V] assembly + pseudocode of the original (ExportOriginals.java)
  ghidra build | refresh                 the server's Ghidra project (download, pseudocode); refresh also runs after merges
  rebuild                                compile all of main and refresh match status
  tasks generate                         create tasks for functions that have none
`;

function parseCsv(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').map((c) => c.trim()))
    .filter((cols) => /^(0x)?[0-9a-fA-F]+$/.test(cols[0]));
}

const num = (s) => (s == null || s === '' ? null : Number.parseInt(s, s.startsWith('0x') || /[a-f]/i.test(s) ? 16 : 10));
const addr = (s) => Number.parseInt(s, 16);

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: 'string', default: './data' },
      role: { type: 'string', default: 'contributor' },
      status: { type: 'string' },
      'password-stdin': { type: 'boolean', default: false },
      current: { type: 'boolean', default: false },
      version: { type: 'string' },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, sub, ...rest] = positionals;
  const dataDir = path.resolve(values.data);

  if (!cmd || values.help) return console.log(HELP);

  if (cmd === 'init') return init(dataDir);
  if (cmd === 'start') return startServer(dataDir);

  if (cmd === 'user') {
    const accounts = new Accounts(new Store(path.join(dataDir, 'td.sqlite')));
    const name = rest[0];
    // Passwords come from stdin (--password-stdin) or are generated and printed once.
    const password = async () => (values['password-stdin'] ? (await readStdin()).replace(/^﻿/, '').replace(/\r?\n$/, '') : crypto.randomBytes(18).toString('base64url'));
    const show = (pw) => !values['password-stdin'] && console.log(`password: ${pw}\n(shown once; change it after logging in)`);
    switch (sub) {
      case 'add': {
        const pw = await password();
        const u = await accounts.createUser(name, values.role, pw);
        console.log(`created active ${u.role} "${u.name}"`);
        return show(pw);
      }
      case 'password': {
        const pw = await password();
        await accounts.setPassword(name, pw);
        console.log(`password of "${name}" reset; their browser sessions were logged out`);
        return show(pw);
      }
      case 'list':
        for (const u of accounts.listUsers(values.status)) console.log(`${u.name.padEnd(24)} ${u.role.padEnd(12)} ${u.status.padEnd(8)} tokens ${u.active_tokens}`);
        return;
      case 'approve':
        return console.log(accounts.approve(name, null));
      case 'reject':
        return console.log(accounts.reject(name, null));
      case 'revoke':
        return console.log(accounts.revoke(name, null));
      case 'reinstate':
        return console.log(accounts.reinstate(name, null));
      case 'role':
        return console.log(accounts.setRole(name, values.role, null));
      case 'token': {
        const u = accounts.requireUser(name);
        const t = accounts.createApiToken(u.id, rest[1] ?? 'cli');
        return console.log(`token for ${name} (${t.label}): ${t.token}\n(shown once)`);
      }
    }
  }

  if (cmd === 'version') {
    const store = new Store(path.join(dataDir, 'td.sqlite'));
    if (sub === 'add') {
      const [id, exe] = rest;
      const buf = fs.readFileSync(exe);
      new PEImage(buf); // validates
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const dir = path.join(dataDir, 'targets');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${sha256}.exe`);
      fs.copyFileSync(exe, dest);
      store.tx(() => {
        const first = !store.get('SELECT 1 FROM versions');
        store.run('INSERT INTO versions (id, sha256, file, size, is_current, created_at) VALUES (?, ?, ?, ?, 0, ?)', id, sha256, dest, buf.length, now());
        if (values.current || first) setCurrent(store, id);
      });
      console.log(`added version ${id} (sha256 ${sha256})`);
      return;
    }
    if (sub === 'label') {
      // A readable name for the website, e.g. "World of Warcraft 5.0.3 (build 15890, x64)".
      const [id, ...words] = rest;
      if (!store.get('SELECT 1 FROM versions WHERE id = ?', id)) throw new Error(`unknown version ${id}`);
      store.run('UPDATE versions SET label = ? WHERE id = ?', words.join(' ') || null, id);
      console.log(`${id} is labelled "${words.join(' ')}"`);
      return;
    }
    if (sub === 'set-current') {
      store.tx(() => setCurrent(store, rest[0]));
      console.log(`current version is now ${rest[0]}; run \`td-server rebuild\``);
      return;
    }
    if (sub === 'map') {
      const [newId, csv] = rest;
      if (!values.from) throw new Error('--from <oldVersion> is required');
      let mapped = 0;
      let missing = 0;
      store.tx(() => {
        for (const [oldA, newA, size] of parseCsv(csv)) {
          const row = store.get('SELECT symbol_id, size FROM symbol_addresses WHERE version_id = ? AND addr = ?', values.from, addr(oldA));
          if (!row) {
            missing++;
            continue;
          }
          store.run(
            'INSERT INTO symbol_addresses (symbol_id, version_id, addr, size) VALUES (?, ?, ?, ?) ON CONFLICT(symbol_id, version_id) DO UPDATE SET addr = excluded.addr, size = excluded.size',
            row.symbol_id, newId, addr(newA), num(size) ?? row.size,
          );
          mapped++;
        }
      });
      console.log(`mapped ${mapped} symbols from ${values.from} to ${newId}; ${missing} old addresses had no symbol`);
      const unmapped = store.get('SELECT COUNT(*) AS n FROM symbols s WHERE NOT EXISTS (SELECT 1 FROM symbol_addresses a WHERE a.symbol_id = s.id AND a.version_id = ?)', newId).n;
      console.log(`${unmapped} symbols have no address in ${newId} yet (they will report no_address until mapped)`);
      return;
    }
  }

  if (cmd === 'symbols') {
    const store = new Store(path.join(dataDir, 'td.sqlite'));
    if (sub === 'import') {
      const v = values.version ? store.get('SELECT * FROM versions WHERE id = ?', values.version) : store.currentVersion();
      if (!v) throw new Error('unknown version');
      let created = 0;
      store.tx(() => {
        for (const [a, size, name, library] of parseCsv(rest[0])) {
          const r = store.ensureSymbol({ kind: 'function', versionId: v.id, addr: addr(a), size: num(size), name: name || null, library: library === '1' || library === 'true' });
          if (r.created) created++;
        }
      });
      console.log(`imported ${created} new function symbols into version ${v.id}`);
      return;
    }
    if (sub === 'load') {
      // Bulk import with fixed IDs (e.g. tools/migrate-wowdecomp/migrate.js output). Every version
      // named in the file must be registered first (`version add`).
      const snap = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
      for (const v of snap.versions) if (!store.get('SELECT 1 FROM versions WHERE id = ?', v)) throw new Error(`version ${v} is not registered; run \`td-server version add ${v} <exe>\` first`);
      const max = {};
      let symbols = 0;
      let addrs = 0;
      store.tx(() => {
        for (const s of snap.symbols) {
          store.run(
            `INSERT INTO symbols (id, kind, name, decorated, library, unit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = COALESCE(excluded.name, symbols.name), decorated = COALESCE(excluded.decorated, symbols.decorated), library = excluded.library, unit = COALESCE(excluded.unit, symbols.unit)`,
            s.id, s.kind, s.name, s.decorated, s.library ? 1 : 0, s.unit, now(),
          );
          symbols++;
          for (const [v, [addr, size]] of Object.entries(s.addrs)) {
            store.run(
              `INSERT INTO symbol_addresses (symbol_id, version_id, addr, size) VALUES (?, ?, ?, ?)
               ON CONFLICT(symbol_id, version_id) DO UPDATE SET addr = excluded.addr, size = excluded.size`,
              s.id, v, addr, size,
            );
            addrs++;
          }
          const [prefix, n] = s.id.split('_');
          max[prefix] = Math.max(max[prefix] ?? 0, Number(n));
        }
        for (const [prefix, n] of Object.entries(max)) {
          store.run('INSERT INTO id_counters (prefix, next) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET next = MAX(next, excluded.next)', prefix, n + 1);
        }
        if (snap.current) setCurrent(store, snap.current);
      });
      console.log(`loaded ${symbols} symbols with ${addrs} addresses; current version ${snap.current ?? '(unchanged)'}`);
      return;
    }
    if (sub === 'units') {
      const v = store.currentVersion();
      let n = 0;
      store.tx(() => {
        for (const [start, end, file] of parseCsv(rest[0])) {
          n += Number(store.run(`UPDATE symbols SET unit = ? WHERE id IN (SELECT symbol_id FROM symbol_addresses WHERE version_id = ? AND addr >= ? AND addr < ?)`, file, v.id, addr(start), addr(end)).changes);
        }
      });
      console.log(`assigned ${n} symbols to units`);
      return;
    }
    if (sub === 'library') {
      store.tx(() => {
        for (const id of rest) {
          store.run('UPDATE symbols SET library = 1 WHERE id = ?', id);
          store.run(`DELETE FROM tasks WHERE symbol_id = ? AND state IN ('open', 'needs_cleanup', 'hard')`, id);
        }
      });
      console.log(`marked ${rest.length} symbols as library code`);
      return;
    }
  }

  if (cmd === 'ghidra' && (sub === 'build' || sub === 'refresh')) {
    // The server's Ghidra project (needs ghidraHome in server.json and a JDK 21).
    const ctx = openServer(dataDir);
    if (!ctx.ghidra.enabled) throw new Error('set ghidraHome in server.json to a Ghidra 11.2.1 installation');
    ctx.store.setMeta('ghidra.commit', ctx.repo.head());
    const info = sub === 'build' ? await ctx.ghidra.build() : await ctx.ghidra.refresh();
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (cmd === 'originals' && sub === 'import') {
    // ghidra_scripts/ExportOriginals.java output, for the current version unless --version is given.
    const ctx = openServer(dataDir);
    const v = values.version ?? ctx.store.currentVersion()?.id;
    const n = await ctx.originals.import(v, rest[0]);
    console.log(`imported ${n} functions for ${v}`);
    return;
  }

  if (cmd === 'tasks' && sub === 'generate') {
    const ctx = openServer(dataDir);
    console.log(`created ${ctx.tasks.generate()} tasks`);
    return;
  }

  if (cmd === 'rebuild') {
    const ctx = openServer(dataDir);
    const t0 = Date.now();
    // A full build of a large project takes a while; allow up to 6 hours.
    const { check, rec } = await ctx.verifier.check({}, 'rebuild', { allUnits: true, timeoutMs: 6 * 3600_000 });
    console.log(`compiled ${check.units.length} units in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const u of check.units) if (!u.compiled) console.error(`FAILED ${u.file}\n${u.log}`);
    ctx.store.tx(() => ctx.merger.applyCheckToDatabase(check, rec, ctx.repo.head(), null));
    ctx.tasks.generate();
    const counts = {};
    for (const u of check.units) for (const f of u.functions) counts[f.status] = (counts[f.status] ?? 0) + 1;
    console.log(`rebuilt ${check.units.length} units:`, counts);
    if (rec.conflicts.length) console.warn('reference conflicts on main:\n  ' + rec.conflicts.map((c) => c.message).join('\n  '));
    return;
  }

  console.log(HELP);
  process.exitCode = 1;
}

function setCurrent(store, id) {
  if (!store.get('SELECT 1 FROM versions WHERE id = ?', id)) throw new Error(`unknown version ${id}`);
  store.run('UPDATE versions SET is_current = 0');
  store.run('UPDATE versions SET is_current = 1 WHERE id = ?', id);
}

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgFile = path.join(dataDir, 'server.json');
  if (!fs.existsSync(cfgFile)) {
    fs.writeFileSync(cfgFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    console.log(`wrote ${cfgFile}`);
  }
  const repoDir = path.join(dataDir, 'repo');
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.cpSync(TEMPLATE_DIR, repoDir, { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: repoDir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'http.receivepack', 'false');
    git('config', 'receive.denyCurrentBranch', 'refuse');
    git('add', '-A');
    git('-c', 'user.name=Clank Together', '-c', 'user.email=bot@clank-together.invalid', 'commit', '-q', '-m', 'Initial project skeleton');
    console.log(`created canonical repo at ${repoDir}`);
  }
  new Store(path.join(dataDir, 'td.sqlite'));
  console.log(`
next steps:
  td-server version add 1.0 path/to/game.exe --data ${values_hint(dataDir)}
  analyze the exe with the pinned Ghidra + ghidra_scripts/ExportFunctions.java, then
  td-server symbols import functions.csv
  td-server user add <you> --role admin
  td-server start`);
}

const values_hint = (d) => path.relative(process.cwd(), d) || '.';

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}
