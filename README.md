# Clank Together

Coordinator, sandboxed verifier and agent client for a collaborative, LLM-assisted
**matching decompilation** of an MSVC 2010 C++ executable. Node.js ≥ 22.13, no npm dependencies.

```
contributors + their agents                       coordinator (clank.rodecomp.online)
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
| `template/` | skeleton of the decomp repo: `decomp.json`, `toolchain.lock.json`; the project's own root `AGENTS.md` is the only agent guide |
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

Register on the website, wait for approval, create a token under **Account**, then one line:

```powershell
$env:TD_TOKEN='td_...'; irm https://clank.rodecomp.online/install.ps1 | iex # Windows
```
```sh
curl -fsSL https://clank.rodecomp.online/install.sh | TD_TOKEN=td_... sh  # Linux
```

It installs `td` (a single executable, no Node.js; git is the only other requirement), sets up the
workspace and connects the AI (Claude Code automatically, other MCP clients via the printed settings).
Compiling and reading the original go through the server; a local compiler (`td setup ... --toolchain`)
and a local Ghidra (`td ghidra install` + `td ghidra download`) are optional. `td` updates itself.

Work comes in batches: `td claim --unit <file>` takes every open function of a file, `td submit` sends
them together. Byte-identical functions merge automatically; the others are peer-reviewed by three
agents, then approved by a human with one click per batch.

## Building td

`node tools/build-td/build.mjs` (Node 22.21) writes `dist/td-windows-x64.exe`, `dist/td-linux-x64` and
`SHA256SUMS`; copy them to `<dataDir>/downloads` on the server.

## Tests

`npm test` uses synthetic PE/COFF files, so it doesn't need a compiler.

## Global storage checks

Set `"globalRules": true` in the target repository's `decomp.json` to enable the
source-level global gate. It is opt-in; deploying this server does not enable it
for other projects. Restart web and worker after changing project configuration.

The verifier applies the payload over current main before checking it, and the
merger checks again before committing. Both ordinary and maintenance batches use
the same rules:

- An external data declaration needs an actual external definition in main plus
  the submitted files. Another extern, a local/static namesake, a different
  namespace, a pending batch or a symbol-database record does not supply storage.
- Static-storage definitions need a stable data annotation. This includes
  function pointers, multiline tables, out-of-class static members and local
  statics. Scalar constant expressions may be folded; arrays and mutable pointers
  are not exempt merely because their element or pointee type is const.
- Data annotations belong on definitions. Source units include their owner's
  header instead of adding extern-variable declarations. DLL-import declarations
  are distinguished from missing project definitions.
- Existing violations are grandfathered for unrelated edits. New/changed
  declarations and removed annotations are checked, as is deletion of a
  definition still required by an existing extern.

The scanner handles declaration scopes and balanced initializers; it is not a
C++ type checker or a substitute for a link. Compilation still validates types
and conditional configurations. These checks establish source ownership, not the
correct binary address, object extent, initializer values or constructor order.
Those require original-binary evidence and review.

### Structural maintenance

Maintainers can use `td maintenance submit --files a.cpp,b.h --notes "reason"`
for structural changes without function tasks. The server runs the submission
gates, compiles affected units and compares effective code against a fresh main
build. Behavior-changing function work must use the normal task/review path.
`td maintenance symbol <id> --size N --reason "evidence"` corrects metadata;
`--retire` is allowed only after main no longer annotates that global ID.

Neither an unchanged-code fingerprint nor a successful unit compile proves that
new global storage reproduces the original initializer/destructor behavior.
Maintenance authors must preserve those semantics; an incomplete object layout
must not be published as a recovered full size.

