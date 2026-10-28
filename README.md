# Clank Together

Coordinator, sandboxed verifier and agent client for a collaborative, LLM-assisted
**matching decompilation** of an MSVC 2010 C++ executable. Node.js ≥ 22.13; install pinned runtime dependencies with `npm ci`.

Join the community at [clank.rodecomp.online/discord](https://clank.rodecomp.online/discord), which redirects to the Discord invite.
The header's Discord link includes an inline SVG icon from [Simple Icons](https://simpleicons.org/?q=discord), with no external image request.

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
| `template/` | skeleton of the decomp repo: `data/decomp.json`, `data/toolchain.lock.json`; the project's own root `AGENTS.md` is the only agent guide |
| `deploy/` | install script, systemd unit, Caddyfile, nftables firewall |
| `deploy/forgejo/` | Forgejo git dashboard at `/git/`: installer (checksum + signature verified), config, unit |

## Maintainer bootstrap

Run `npm ci` in the coordinator checkout before starting the server or running tests.

```sh
# on the server (as the service user):  td-server <cmd> --data /var/lib/togetherdecomp
td-server version add 1.0 game.exe              # register the target
# analyze with the pinned Ghidra and export the function list
analyzeHeadless /tmp/g boot -import game.exe -scriptPath ghidra_scripts -postScript ExportFunctions.java functions.csv
td-server symbols import functions.csv          # one stable ID per function, tasks get created
td-server symbols units units.csv               # optional: start,end,src/file.cpp
td-server user add alice --role reviewer
# build the compiler image (see toolchain/msvc2010/Dockerfile), pin clSha256 in data/toolchain.lock.json
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

### Batch visibility

`#/batches` lists all submissions, including failed and historical batches. The
In review tab requires an actual `in_review` or `peer_review` attempt; an `open`
batch alone is not proof that anything is reviewable. Generated-code claims in
`skip` batches are included while their attempts await review. Awaiting merge
separately shows approved or merging attempts. `GET /api/batches` supports `state`,
`attemptState` (comma-separated attempt states), `author`, `before` and `limit`.
Filters apply before pagination.

Skip-claim reviews show the claim category and reason beside the original
instructions/pseudocode. They intentionally contain no submitted C++ or byte
comparison. Attempt details expose the original symbol identity independently of
compiled results so these reviews can load evidence without inventing a target.

The merge worker settles abandoned open code batches when they contain failed
attempts and no attempt remains live. It records the reason and an audit event,
preserving attempt feedback, task states, review votes and scores. This does not
approve historical code: missing bindings and stale payloads need current-source
verification and a new submission. Maintenance and actively merging batches are
not settled by this reconciliation.

Resubmissions with identical compiled code retain actual peer verdicts or an
explicit prior review waiver. Waiver carry-over is audited and does not create
peer votes or carry a score-regression override; changed code still needs review.

Header-includer discovery reads committed source blobs in one `git cat-file
--batch` operation and reuses that snapshot until HEAD or source roots change.
Submitted overrides apply only to the current query. Reverse include traversal
handles cycles without losing transitive dependents; uncommitted working-tree
text is never used as the baseline.

The original-string gate uses each source unit's configured MSVC execution charset
(`/execution-charset:.949`, for example) when checking readable Unicode literals.
Numeric byte escapes remain literal bytes, and wide strings remain UTF-16LE.
Unrepresentable characters are rejected rather than accepted as replacement `?`
bytes. Configure source UTF-8 and the target execution code page separately; this
does not permit new strings absent from the original executable.

### Repository synchronization before verification

When `server.json` sets `pushRemote`, the single worker fetches that remote's
branch matching its checked-out branch at startup and before admitting each
code/maintenance verification cohort. Existing verification, maintenance, merge
and remote-check jobs drain first; new jobs do not start during synchronization.
No remote is guessed when `pushRemote` is unset.

Only a fast-forward is automatic. Local-ahead commits are retained. Divergence
reports both full commit IDs and requires a maintainer to reconcile the histories;
there is no automatic reset, rebase or merge commit. Dirty tracked, staged and
untracked files block synchronization, and ignored files cannot be overwritten by
incoming tracked files. Preserve local edits before retrying.

Fetch/authentication failures and unsafe states leave batches queued with an
explicit `result.repositorySync.error`; merge and remote-check admission pauses.
The worker retries at its next pump and removes the diagnostic after a successful
sync, so operator repairs do not require resubmission or a restart. Fetch is
noninteractive and bounded to two minutes.

After synchronization the worker reloads `data/decomp.json`, its selected
compile-command file and `data/toolchain.lock.json` from one committed snapshot,
updates the shared project object and invalidates checks cached under old settings.
The separate web process adopts only the published snapshot, never partially
updated working-tree configuration. Direct uncommitted configuration changes are
not loaded this way; commit them, or restart web and worker when no remote is used.


## Building td

`node tools/build-td/build.mjs` (Node 22.21) writes `dist/td-windows-x64.exe`, `dist/td-linux-x64` and
`SHA256SUMS`; copy them to `<dataDir>/downloads` on the server.

These download names are mutable: the server sends `Cache-Control: no-store` on `/download/`
responses, including the manifest and compressed binaries. Self-updates revalidate the manifest,
request the binary with `?sha256=<expected hash>` to bypass an older unversioned CDN entry, and
still verify its SHA-256 before replacing the installed executable. When deploying this policy
behind a CDN, purge existing `/download/` cache entries once: new origin headers do not evict
already-cached responses used by older clients.

## Tests

`npm test` uses synthetic PE/COFF files, so it doesn't need a compiler.

## Global storage checks

Set `"globalRules": true` in the target repository's `decomp.json` to enable the
source-level global gate. It is opt-in; deploying this server does not enable it
for other projects. Committed configuration is refreshed by repository synchronization
when `pushRemote` is configured; otherwise restart web and worker after changing it.

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

From a contributor workspace, a maintainer can correct a decorated/linker name
without changing a symbol's ID, address, task state, match state or confirmations:

```sh
td maintenance symbol fn_00123 --decorated '?CorrectName@@YAXXZ' --reason "original-binary evidence"
td maintenance symbol fn_00123 --swap-decorated-with fn_00456 --reason "call targets show the names were reversed"
```

The maintained HTTP route is `POST /api/admin/symbols/:id`. Send either
`{"decorated":"?CorrectName@@YAXXZ","reason":"original-binary evidence"}` or
`{"swapDecoratedWith":"fn_00456","reason":"call-target evidence"}`. MCP exposes
the same fields through `td_correct_symbol`, with an additional `id` argument.
Both clients refresh their symbol snapshots after a successful correction.

`decorated` must be a string of 1-2048 visible ASCII characters, with no whitespace
or control characters; it is never coerced, trimmed or truncated. C-linkage names
are supported as well as C++ decorated names. Null and empty values are rejected.
The evidence `reason` must be a nonblank string of at most 500 characters.
Unknown request fields are rejected. Existing `size`, `name` and `retire` fields
remain available; a swap cannot be combined with other corrections.

A name already mapped to another ID returns HTTP 409 without applying any part
of the request. A swap requires two distinct, existing, unambiguous mappings
whose symbols have the same kind; it exchanges only their decorated names in
one database transaction. Do not
clear a mapping or use a temporary name as an intermediate step. Each affected
ID receives a `symbol_corrected` event containing the acting user, `old` and
`new` values, and the evidence reason (plus the other ID for a swap). Audit
records and corrections commit together. Symbol snapshot caches in every web
process and target version are invalidated by the committed correction, so an
immediate conditional refresh observes the new names rather than a stale 304.

Neither an unchanged-code fingerprint nor a successful unit compile proves that
new global storage reproduces the original initializer/destructor behavior.
Maintenance authors must preserve those semantics; an incomplete object layout
must not be published as a recovered full size.

