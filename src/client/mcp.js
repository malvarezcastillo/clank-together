// MCP server (stdio, newline-delimited JSON-RPC) exposing the workspace to
// any MCP-capable agent. Started with `td mcp` from inside a workspace.

import readline from 'node:readline';
import { Workspace } from './workspace.js';
import * as ops from './ops.js';
import { hex } from '../shared/annotations.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

const TOOLS = [
  {
    name: 'td_list_tasks',
    description: 'List claimable decompilation tasks (easiest first).',
    inputSchema: { type: 'object', properties: { state: str('comma-separated states, default open,needs_cleanup,hard'), unit: str('only tasks in this translation unit'), limit: int('max results, default 20') } },
    run: async (ws, a) => ops.api(ws).get(`/api/tasks?limit=${a.limit ?? 20}${a.state ? `&state=${encodeURIComponent(a.state)}` : ''}${a.unit ? `&unit=${encodeURIComponent(a.unit)}` : ''}`),
  },
  {
    name: 'td_claim_task',
    description: 'Claim a task (or the next best one). Returns the full task context: symbol ID and address, file to write, previous attempts and their feedback, reviewer comments.',
    inputSchema: { type: 'object', properties: { taskId: int('task to claim; omit for the next available') } },
    run: async (ws, a) => ops.api(ws).post('/api/tasks/claim', { taskId: a.taskId }),
  },
  {
    name: 'td_get_task',
    description: 'Get the context of a task.',
    inputSchema: { type: 'object', properties: { taskId: int('task id') }, required: ['taskId'] },
    run: async (ws, a) => ops.api(ws).get(`/api/tasks/${a.taskId}`),
  },
  {
    name: 'td_heartbeat',
    description: 'Extend your leases while you are still working (all of them, or one taskId). Leases expire after two hours otherwise.',
    inputSchema: { type: 'object', properties: { taskId: int('task id; omit for all') } },
    run: async (ws, a) => (a.taskId ? ops.api(ws).post(`/api/tasks/${a.taskId}/heartbeat`) : ops.api(ws).post('/api/tasks/heartbeat-all')),
  },
  {
    name: 'td_release_task',
    description: 'Give a task back without submitting.',
    inputSchema: { type: 'object', properties: { taskId: int('task id') }, required: ['taskId'] },
    run: async (ws, a) => ops.api(ws).post(`/api/tasks/${a.taskId}/release`),
  },
  {
    name: 'td_decompile',
    description: 'Ghidra decompiler output for a function in the original executable (by symbol ID, name or hex address). A starting point only; the result must be rewritten into matching C++.',
    inputSchema: { type: 'object', properties: { symbol: str('fn_00123, a name, or 0x401000') }, required: ['symbol'] },
    run: async (ws, a) => ops.original(ws, a.symbol, 'c'),
  },
  {
    name: 'td_disassemble',
    description: 'Disassembly of a function in the original executable, the ground truth to match.',
    inputSchema: { type: 'object', properties: { symbol: str('fn_00123, a name, or 0x401000') }, required: ['symbol'] },
    run: async (ws, a) => ops.original(ws, a.symbol, 'asm'),
  },
  {
    name: 'td_lookup_symbol',
    description: 'Look up a symbol in the symbol database by ID, name, decorated name or hex address.',
    inputSchema: { type: 'object', properties: { query: str('ID, name or address') }, required: ['query'] },
    run: async (ws, a) => {
      const s = ws.findSymbol(a.query);
      return s ? { ...s, addr: s.addr != null ? '0x' + hex(s.addr) : null } : { found: false };
    },
  },
  {
    name: 'td_new_symbol',
    description: 'Get a stable ID for a global, vtable, string or function that is not in the database yet. Annotate it in source with the returned annotation line. Never write addresses into source.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['global', 'vtable', 'string', 'function'] }, addr: str('hex address in the current target version'), name: str('suggested name') }, required: ['kind', 'addr'] },
    run: async (ws, a) => {
      const r = await ops.api(ws).post('/api/symbols', a);
      await ops.refreshSymbols(ws);
      return r;
    },
  },
  {
    name: 'td_check',
    description: 'Compile translation units locally and compare every annotated function against the original bytes. Same pipeline as the server. Returns status, score and byte-level diffs with the instruction at each mismatch.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'repo-relative .cpp files; default: all changed files' } } },
    run: async (ws, a) => ops.check(ws, a.files),
  },
  {
    name: 'td_submit',
    description: 'Submit your work for server verification, as one batch: every task you hold (default) or the given taskIds, with all changed files they allow. Byte-identical functions are merged automatically; others go to peer review. Ends the leases. Do not wait for the result: claim the next work right away and check results later.',
    inputSchema: {
      type: 'object',
      properties: { taskIds: { type: 'array', items: { type: 'integer' }, description: 'tasks to submit; default: all you hold' }, taskId: int('a single task (same as taskIds: [id])'), files: { type: 'array', items: { type: 'string' } }, notes: str('short notes for reviewers and later agents') },
    },
    run: async (ws, a) => ops.submit(ws, a.taskIds ?? (a.taskId ? [a.taskId] : []), { files: a.files, notes: a.notes, agentMeta: { client: 'td-mcp' } }),
  },
  {
    name: 'td_claim_batch',
    description: 'Claim many functions at once: every open function of a source file (unit), or of an address range of the current version, up to limit (default 50). Work through them in the file, td_check, then td_submit them together. Much cheaper than one function at a time.',
    inputSchema: { type: 'object', properties: { unit: str('repo-relative source file, e.g. Engine/Source/FrameXML/LoadXML.cpp'), start: str('range start, hex'), end: str('range end, hex (exclusive)'), limit: int('max functions, default 50') } },
    run: async (ws, a) => ops.claimBatch(ws, a),
  },
  {
    name: 'td_get_batch',
    description: 'State of a submitted batch, per function (approved, peer_review, in_review, needs_cleanup, merged...).',
    inputSchema: { type: 'object', properties: { batchId: int('batch id') }, required: ['batchId'] },
    run: async (ws, a) => ops.api(ws).get(`/api/batches/${a.batchId}`),
  },
  {
    name: 'td_get_result',
    description: 'Get the verification result of a submitted attempt (state queued/verifying until done).',
    inputSchema: { type: 'object', properties: { attemptId: int('attempt id') }, required: ['attemptId'] },
    run: async (ws, a) => {
      const r = await ops.api(ws).get(`/api/attempts/${a.attemptId}`);
      delete r.files;
      return r;
    },
  },
  {
    name: 'td_list_peer_reviews',
    description: 'List attempts by other contributors that wait for peer review (not byte-identical; agents judge whether the logic is the same).',
    inputSchema: { type: 'object', properties: { limit: int('max results, default 20') } },
    run: async (ws, a) => ops.api(ws).get(`/api/peer-reviews?limit=${a.limit ?? 20}`),
  },
  {
    name: 'td_claim_peer_review',
    description: 'Claim a peer review. Returns the review instructions, the original function (read it with td_disassemble and td_decompile) and the submitted code. Judge by reading only: do not compile, run td_check or diff bytes.',
    inputSchema: { type: 'object', properties: { attemptId: int('attempt to review; omit for the oldest waiting one') } },
    run: async (ws, a) => ops.api(ws).post('/api/peer-reviews/claim', { attemptId: a.attemptId }),
  },
  {
    name: 'td_submit_peer_review',
    description: 'Give your verdict on a claimed peer review: "same" if the submitted code does exactly what the original does, "different" otherwise. A reason is required; for "different" name the concrete difference.',
    inputSchema: {
      type: 'object',
      properties: { attemptId: int('attempt id'), verdict: { type: 'string', enum: ['same', 'different'] }, reason: str('what you checked, or where and how the logic differs (20+ characters)') },
      required: ['attemptId', 'verdict', 'reason'],
    },
    run: async (ws, a) => ops.api(ws).post(`/api/peer-reviews/${a.attemptId}/verdict`, { verdict: a.verdict, reason: a.reason, agentMeta: { client: 'td-mcp' } }),
  },
  {
    name: 'td_release_peer_review',
    description: 'Give a claimed peer review back without a verdict.',
    inputSchema: { type: 'object', properties: { attemptId: int('attempt id') }, required: ['attemptId'] },
    run: async (ws, a) => ops.api(ws).post(`/api/peer-reviews/${a.attemptId}/release`),
  },
  {
    name: 'td_sync',
    description: 'Fast-forward the local clone to the latest main and refresh the symbol database snapshot.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ws) => ops.sync(ws),
  },
];


export function startMcp(dir) {
  const ws = Workspace.find(dir);
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined) return; // notification
    const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'clank-together', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `unknown tool ${msg.params?.name}`);
        try {
          const out = await tool.run(ws, msg.params.arguments ?? {});
          return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `${e.message}${e.details ? '\n' + JSON.stringify(e.details, null, 2) : ''}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  });
}

// What every connected agent is told when it starts. Work continues until the user stops it.
const INSTRUCTIONS = [
  'Clank Together: a collaborative matching decompilation. Read AGENTS.md in the workspace first.',
  'Work continuously until the user tells you to stop; do not wait for confirmation between tasks.',
  'Port first, polish later: write faithful C++ (same logic, calls, conditions, data accesses) and submit it;',
  'functions that are not byte-identical are confirmed by three other agents in peer review, which is the normal path.',
  'Loop: td_claim_batch (a whole unit: every open function of one source file) or td_claim_task ->',
  'read the originals (td_disassemble, td_decompile) -> write the C++ with the given annotations ->',
  'td_check to fix compile errors and clear structural differences (two or three checks per function, do not chase exact bytes) -> td_submit (everything you hold) ->',
  'immediately claim the next work. Do not wait for verification; look at results later with td_get_batch / td_get_result',
  'and fix what came back (needs_cleanup).',
  'Between batches, take a peer review when one is waiting: td_list_peer_reviews -> td_claim_peer_review ->',
  'read the original and the submission only (no compiling or diffing) -> td_submit_peer_review for every function.',
  'Call td_heartbeat every hour or so while working on a big batch.',
  'Server responses carry a guidance field with the current project policy; follow it, it takes precedence over older instructions.',
].join(' ');
