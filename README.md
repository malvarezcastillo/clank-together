# Clank Together

Coordinator, sandboxed verifier and agent client for a collaborative, LLM-assisted
**matching decompilation** of an MSVC 2010 C++ executable. Node.js ≥ 22.13, no npm dependencies.

```
contributors + their agents                       coordinator (saty.dev)
┌──────────────────────────┐   HTTPS   ┌──────────────────────────────────────────┐
│ td CLI / td mcp (agent)  │◄─────────►│ Caddy (TLS) → node coordinator :8080      │
│ git clone of the repo    │  git+api  │  SQLite: users, symbols, versions, tasks, │
│ .td/target.exe (verified)│           │          attempts, reviews, func_status   │
│ pinned Ghidra (headless) │           │  canonical git repo (read-only clones)    │
│ cl.exe via docker/native │           │  verifier → docker sandbox (cl.exe/Wine)  │
└──────────────────────────┘           │  merge queue → commits to main            │
                                       └──────────────────────────────────────────┘
```

## Git dashboard

The source is browsable at `https://<host>/git/` (Forgejo, self-hosted). The coordinator is the only
writer: every merge is pushed by the `clank-bot` account, `main` is protected, pull requests are off and
Forgejo sign-up is disabled. Contributors clone from there; `/repo.git` on the coordinator is a read-only fallback.

## Core ideas

- **Stable symbol IDs.** Source annotations hold IDs (`// FUNCTION: fn_00123`), never
  addresses. The coordinator's database maps each ID to its address *per target version*,
  so a new exe version means mapping addresses (`td-server version map`), not retagging source.
- **Same pipeline everywhere.** `td check` (local) and the server verifier run the same
  code: compile with the pinned MSVC, read the COFF object and `/FAcs` listing, compare
  bytes against the original with relocations masked, then check that every relocation
  points where the original points (calls via REL32, data via DIR32 + the PE's base relocations).
- **Learning references.** A call to a not-yet-decompiled function is checked against
  the database's address for that function; on merge the decorated name is learned.
  References to data without a symbol create new symbols automatically.
- **Untrusted input everywhere.** Static gate (paths, banned constructs such as inline asm,
  `#pragma code_seg`, `#line`, byte blobs), a second lint on the *preprocessed* output,
  compilation in a container with no network, read-only root, dropped capabilities,
  memory/CPU/pid limits and userns-remap. Notes from other contributors reach agents
  wrapped as untrusted data.
- **Humans decide.** Matching work goes to review (1 approval, 2 for header changes, no
  self-review), then a serial merge queue three-way merges onto current main and
  re-verifies before committing.

## Task flow

```
open ─claim→ leased ─submit→ verifying ─┬→ rejected (static gate / cheating) → open
  ▲                                      ├→ needs_cleanup (compile error, mismatch, regression) ─claim→ …
  │                                      └→ in_review ─approve→ approved → merging → done
  └──────── lease expired / released / changes requested / merge conflict ─────────┘
```
After `maxCleanupCycles` failed attempts a task becomes `hard`. The author of the last
attempt gets first pick on the follow-up for 6 hours.

## Layout

| Path | |
|---|---|
| `src/shared/` | annotation parser, PE/COFF/listing readers, compare, reconcile, lint, build runners |
| `src/server/` | coordinator: API, tasks, verifier, merge queue, git http-backend, review UI |
| `src/client/` | `td` CLI, MCP server for agents, Ghidra integration |
| `ghidra_scripts/` | ExportFunctions (bootstrap), ApplySymbols, DecompileAt, DisassembleAt |
| `toolchain/msvc2010/` | Dockerfile for cl.exe under Wine (you supply the compiler files) |
| `template/` | skeleton of the decomp repo: `decomp.json`, `toolchain.lock.json`, `AGENTS.md` |
| `deploy/` | install script, systemd unit, Caddyfile, nftables firewall |
| `deploy/forgejo/` | Forgejo git dashboard at `/git/`: installer (checksum + signature verified), config, unit |

## Maintainer bootstrap

```sh
# on the server (as the service user):  td-server <cmd> --data /var/lib/togetherdecomp
td-server version add 1.0 game.exe              # register the target
# analyze with the pinned Ghidra and export the function list
analyzeHeadless /tmp/g boot -import game.exe -scriptPath ghidra_scripts -postScript ExportFunctions.java functions.csv
td-server symbols import functions.csv          # one stable ID per function, tasks get created
td-server symbols units units.csv               # optional: start,end,src/file.cpp
td-server user add alice --role reviewer
# build the compiler image (see toolchain/msvc2010/Dockerfile), pin clSha256 in toolchain.lock.json
```

New target version later: `td-server version add 1.1 game11.exe`, then
`td-server version map 1.1 mapping.csv --from 1.0` (old_addr,new_addr from Ghidra Version
Tracking or BinDiff), `td-server version set-current 1.1`, `td-server rebuild`.

## Contributor quick start

```sh
td setup https://saty.dev mygame --name you             # docker runner (Linux)
td setup https://saty.dev mygame --name you --runner native --vc "C:\...\Microsoft Visual Studio 10.0\VC"
cd mygame && td ghidra install && td ghidra build
claude mcp add clank-together -- td mcp                  # or any MCP-capable agent
```

## Tests

`npm test` uses synthetic PE/COFF files, so it doesn't need a compiler.
