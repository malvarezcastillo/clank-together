// Runs the analysis of compiler output (lint, compare against the original) in worker threads:
// a check that recompiles dozens of units takes minutes of CPU, which on the main thread would
// stall every request to the coordinator.

import os from 'node:os';
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./analyze-worker.js', import.meta.url);
const MAX_WORKERS = Math.max(1, Math.min(4, os.availableParallelism() - 2));

export async function analyzeInWorkers({ compiled, annotations, roots, symbols, nameIndex, peFile, maxWorkers = MAX_WORKERS }) {
  return inWorkers(compiled, maxWorkers, (chunk) => ({ task: 'analyze', compiled: chunk, annotations, roots, symbols, nameIndex, peFile }));
}

/**
 * check.js withGlobalBindings for each compiled unit on its own: one list of [decorated name, ID]
 * per unit, in order. It parses each unit's listing (megabytes), so it runs off the main thread too.
 */
export async function bindGlobalsInWorkers({ compiled, annotations, maxWorkers = MAX_WORKERS }) {
  const globals = annotations.filter((a) => a.kind === 'GLOBAL' && a.name);
  if (!globals.length) return compiled.map(() => []);
  return inWorkers(compiled, maxWorkers, (chunk) => ({ task: 'bindGlobals', compiled: chunk, annotations: globals }));
}

/** Splits `compiled` between threads; one result per unit, in the order the units were compiled. */
async function inWorkers(compiled, maxWorkers, dataFor) {
  if (!compiled.length) return [];
  const n = Math.min(maxWorkers, Math.ceil(compiled.length / 4));
  const chunks = Array.from({ length: n }, () => []);
  compiled.forEach((c, i) => chunks[i % n].push(c));
  const parts = await Promise.all(chunks.map((chunk) => run(dataFor(chunk))));
  return compiled.map((_, i) => parts[i % n][Math.floor(i / n)]);
}

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData });
    let done = false;
    w.once('message', (m) => {
      done = true;
      resolve(m);
    });
    w.once('error', reject);
    w.once('exit', (code) => done || reject(new Error(`analysis worker exited with code ${code}`)));
  });
}
