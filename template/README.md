# Game decompilation

Matching decompilation, coordinated with Clank Together.

- `src/`, `include/`: decompiled C++. Every function and global carries a
  stable symbol annotation (`// FUNCTION: fn_00123`); addresses live in the
  coordinator's symbol database, per target version.
- `data/decomp.json`: compiler flags and project policy.
- `data/toolchain.lock.json`: pinned compiler and Ghidra versions.
- `AGENTS.md`: how to contribute (for people and their LLM agents).

Get started: `td setup <server-url> <dir> --name <you>`.
