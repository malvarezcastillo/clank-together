import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { PEImage } from '../shared/pe.js';
import { analyzeCompiled } from '../shared/check.js';

const { peFile, ...rest } = workerData;
parentPort.postMessage(analyzeCompiled({ ...rest, pe: new PEImage(fs.readFileSync(peFile)) }));
