// Runs the analysis of compiler output (lint, compare against the original) in worker threads:
// a check that recompiles dozens of units takes minutes of CPU, which on the main thread would
// stall every request to the coordinator.

import os from 'node:os';
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./analyze-worker.js', import.meta.url);

export async function analyzeInWorkers({ compiled, annotations, roots, symbols, nameIndex, peFile, maxWorkers = Math.max(1, Math.min(4, os.availableParallelism() - 2)) }) {
  if (!compiled.length) return [];
  const n = Math.min(maxWorkers, Math.ceil(compiled.length / 4));
  const chunks = Array.from({ length: n }, () => []);
  compiled.forEach((c, i) => chunks[i % n].push(c));
  const parts = await Promise.all(chunks.map((chunk) => run({ compiled: chunk, annotations, roots, symbols, nameIndex, peFile })));
  // Back in the order the units were compiled.
  const byFile = new Map(parts.flat().map((u) => [u.file, u]));
  return compiled.map((c) => byFile.get(c.file));
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
