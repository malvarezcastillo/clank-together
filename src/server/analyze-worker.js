import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { PEImage } from '../shared/pe.js';
import { analyzeCompiled, withGlobalBindings } from '../shared/check.js';

const { task, peFile, ...rest } = workerData;
parentPort.postMessage(
  task === 'bindGlobals'
    ? rest.compiled.map((c) => [...withGlobalBindings([c], rest.annotations, new Map())])
    : analyzeCompiled({ ...rest, pe: new PEImage(fs.readFileSync(peFile)) }),
);
