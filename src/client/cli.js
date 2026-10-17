#!/usr/bin/env node
// `td` - contributor CLI for Clank Together.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { Workspace } from './workspace.js';
import * as ops from './ops.js';
import * as ghidra from './ghidra.js';
import { startMcp } from './mcp.js';
import { hex } from '../shared/annotations.js';

const HELP = `td - Clank Together contributor client

Setup
  td setup <server-url> <dir> --token T       clone the repo,
       [--exe <your copy of the target>]      verify your exe, check the token,
       [--runner docker|native|wine]          configure the compiler
       [--toolchain <toolchain root>]         compiler layout of the project (e.g. re/toolchain)
       [--vc <VC dir>] [--sdk <SDK dir>] [--image <docker image>]
  td sync                                     pull main and refresh the symbol database snapshot
  td ghidra install | build | sync            pinned Ghidra: install, (re)build the project, re-apply symbols
  td mcp                                      run the MCP server for your agent (stdio)

Work
  td tasks [--state S] [--limit N]            list claimable tasks
  td claim [taskId]                           claim a task, prints its context
  td task <taskId>                            show a task's context
  td check [files...]                         compile + compare locally (default: changed files)
  td submit <taskId> [files...] [--notes T]   submit for server verification
  td result <attemptId>                       show a verification result
  td heartbeat <taskId> | td release <taskId>
  td symbol <id|name|0xaddr>                  look up a symbol
  td symbol new <kind> <0xaddr> [--name N]    get a stable ID for a new global/vtable/string/function
  td decompile <symbol> | td disasm <symbol>  query the local Ghidra project

Peer review (attempts that are not byte-identical; judge by reading, not by tools)
  td peer list                                attempts waiting for review
  td peer claim [attemptId]                   claim one, prints instructions, original and submission
  td peer verdict <attemptId> same|different --reason "..."
  td peer release <attemptId>
`;

const print = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

function printCheck(r) {
  for (const e of r.annotationErrors) console.log(`annotation: ${e.file}:${e.line} ${e.message}`);
  for (const u of r.units) {
    console.log(`\n${u.file}: ${u.compiled ? 'compiled' : 'FAILED'}`);
    if (!u.compiled) console.log(u.log);
    for (const e of [...u.lintErrors, ...u.errors]) console.log(`  ! ${e.message}`);
    for (const f of u.functions) {
      console.log(`  ${f.id} ${f.addr ?? '?'} ${(f.name ?? '').padEnd(30)} ${f.status.padEnd(17)} ${(f.score * 100).toFixed(1)}%  size ${f.size?.ours ?? '-'}/${f.size?.original ?? '?'}`);
      for (const d of f.diffRegions ?? []) console.log(`      +0x${d.offset.toString(16)}: ours ${d.ours} orig ${d.original}  ${d.ourInstruction ?? ''}${d.sourceLine ? ` (line ${d.sourceLine})` : ''}`);
      for (const x of f.relocations ?? []) console.log(`      reloc +0x${x.offset.toString(16)} ${x.symbol}: ${x.ok ? `not yet named, original points at 0x${hex(x.actual)}` : x.reason}`);
    }
    if (u.unannotated.length) console.log(`  unannotated: ${u.unannotated.join(', ')}`);
  }
  for (const c of r.referenceConflicts) console.log(`conflict: ${c.message ?? c}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      token: { type: 'string' },
      exe: { type: 'string' },
      toolchain: { type: 'string' },
      runner: { type: 'string' },
      vc: { type: 'string' },
      sdk: { type: 'string' },
      image: { type: 'string' },
      state: { type: 'string' },
      limit: { type: 'string', default: '20' },
      notes: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) return print(HELP);

  if (cmd === 'setup') {
    const [server, dir] = args;
    if (!server || !dir) throw new Error('usage: td setup <server-url> <dir> --token <API token from the website>');
    const ws = await ops.setup({ server, dir, token: values.token, exe: values.exe, toolchain: values.toolchain, runner: values.runner, vc: values.vc, sdk: values.sdk, image: values.image });
    console.log(`\nworkspace ready at ${ws.dir}
next:
  cd ${path.relative(process.cwd(), ws.dir) || '.'}
  td ghidra install && td ghidra build      (one-time, takes a while)
  td check src/...                          (self-test once there is code)
agent (MCP) config, e.g. for Claude Code:
  claude mcp add clank-together -- node ${path.resolve(process.argv[1])} mcp`);
    return;
  }
  if (cmd === 'mcp') return startMcp(process.cwd());

  const ws = Workspace.find();
  const client = ops.api(ws);
  switch (cmd) {
    case 'sync':
      return print(await ops.sync(ws));
    case 'tasks':
      for (const t of await client.get(`/api/tasks?limit=${values.limit}${values.state ? `&state=${values.state}` : ''}`)) {
        console.log(`#${String(t.id).padEnd(6)} ${t.symbol_id} ${t.addr} size ${String(t.size ?? '?').padEnd(6)} d${t.difficulty} ${t.state.padEnd(13)} best ${(t.best_score * 100).toFixed(0)}% ${t.name ?? ''} ${t.unit ?? ''}`);
      }
      return;
    case 'claim':
      return print(await client.post('/api/tasks/claim', { taskId: args[0] ? Number(args[0]) : undefined }));
    case 'task':
      return print(await client.get(`/api/tasks/${args[0]}`));
    case 'heartbeat':
      return print(await client.post(`/api/tasks/${args[0]}/heartbeat`));
    case 'release':
      return print(await client.post(`/api/tasks/${args[0]}/release`));
    case 'check': {
      const r = await ops.check(ws, args.map((f) => ops.relPath(ws, f)));
      return values.json ? print(r) : printCheck(r);
    }
    case 'submit': {
      const [taskId, ...files] = args;
      return print(await ops.submit(ws, Number(taskId), { files: files.map((f) => ops.relPath(ws, f)), notes: values.notes, agentMeta: { client: 'td-cli' } }));
    }
    case 'result': {
      const r = await client.get(`/api/attempts/${args[0]}`);
      delete r.files;
      return print(r);
    }
    case 'symbol': {
      if (args[0] === 'new') {
        const r = await client.post('/api/symbols', { kind: args[1], addr: args[2], name: values.name });
        await ops.refreshSymbols(ws);
        return print(r);
      }
      const s = ws.findSymbol(args[0]);
      return print(s ? { ...s, addr: s.addr != null ? '0x' + hex(s.addr) : null } : 'not found');
    }
    case 'peer': {
      const [sub, id, verdict] = args;
      if (sub === 'list') return print(await client.get('/api/peer-reviews'));
      if (sub === 'claim') return print(await client.post('/api/peer-reviews/claim', { attemptId: id ? Number(id) : undefined }));
      if (sub === 'show') return print(await client.get(`/api/peer-reviews/${id}`));
      if (sub === 'verdict') return print(await client.post(`/api/peer-reviews/${id}/verdict`, { verdict, reason: values.reason, agentMeta: { client: 'td-cli' } }));
      if (sub === 'release') return print(await client.post(`/api/peer-reviews/${id}/release`));
      throw new Error('usage: td peer list|claim [id]|show <id>|verdict <id> same|different --reason ...|release <id>');
    }
    case 'ghidra':
      if (args[0] === 'install') return print(`Ghidra installed at ${await ghidra.installGhidra(ws)}`);
      if (args[0] === 'build') return void (await ghidra.buildGhidraProject(ws), print('Ghidra project built'));
      if (args[0] === 'sync') return void (await ghidra.syncGhidraProject(ws), print('symbols applied'));
      throw new Error('usage: td ghidra install|build|sync');
    case 'decompile':
    case 'disasm': {
      const s = ws.findSymbol(args[0]);
      const a = s?.addr ?? (/^0x/i.test(args[0] ?? '') ? Number.parseInt(args[0], 16) : null);
      if (a == null) throw new Error(`unknown symbol ${args[0]}`);
      return print(cmd === 'decompile' ? await ghidra.decompile(ws, a) : await ghidra.disassemble(ws, a));
    }
    default:
      print(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
