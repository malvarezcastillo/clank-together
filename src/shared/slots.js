// Machine-wide limit on concurrent compiler processes, shared by every td process (and by
// rodecomp's scripts/exe/build_exe.py, which uses the same files). Without it several agents each
// start one compiler per core and the machine runs many times more compilers than it has cores.
//
// A slot is a file <dir>/<n>.slot created exclusively; it holds "<pid> <ms since epoch>". A slot
// whose process is gone, or that is older than STALE_MS, is taken over.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MS = 30 * 60_000;
const POLL_MS = 50;

export const SLOTS_DIR = path.join(os.homedir(), '.clank', 'slots');

/** Slot count: TD_COMPILE_SLOTS, else one per logical CPU. */
export function slotCount() {
  const n = Number.parseInt(process.env.TD_COMPILE_SLOTS ?? '', 10);
  return n > 0 ? n : Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
}

const held = new Set();
let exitHook = false;

function alive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function stale(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // released meanwhile: the next create attempt decides
  }
  const [pid, since] = text.trim().split(/\s+/).map(Number);
  // An empty or torn file is being written right now; only age makes it stale.
  if (!pid) {
    try {
      return Date.now() - fs.statSync(file).mtimeMs > STALE_MS;
    } catch {
      return false;
    }
  }
  return !alive(pid) || Date.now() - since > STALE_MS;
}

function tryTake(dir, count) {
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `${i}.slot`);
    try {
      fs.writeFileSync(file, `${process.pid} ${Date.now()}\n`, { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (stale(file)) fs.rmSync(file, { force: true });
    }
  }
  return null;
}

/**
 * Waits for a free slot and returns its release function. `dir`/`count` are for tests.
 * @returns {Promise<() => void>}
 */
export async function acquireSlot({ dir = SLOTS_DIR, count = slotCount() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const f of held) fs.rmSync(f, { force: true });
    });
  }
  for (;;) {
    const file = tryTake(dir, count);
    if (file) {
      held.add(file);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.delete(file);
        fs.rmSync(file, { force: true });
      };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
