import { Worker } from 'node:worker_threads';
import { join, resolve } from 'node:path';

const cluster = Number(process.argv[2]);
if (!Number.isSafeInteger(cluster) || cluster < 0) throw new Error('cluster must be a non-negative integer');

const baseRoot = resolve(process.env.BASE_ROOT);
const acornPath = resolve(process.env.ACORN_PATH);
const workerPath = resolve(process.env.WORKER_PATH);
const baseEntry = join(baseRoot, 'dist/compiler/vite/index.js');

const result = await new Promise((resolvePromise, rejectPromise) => {
  const worker = new Worker(workerPath, {
    workerData: {
      cluster,
      sideAPath: baseEntry,
      sideBPath: baseEntry,
      acornPath,
      scenario: 'batch',
      calls: 8,
      positiveControl: false,
      traceDiagnostic: true,
    },
  });
  let got = false;
  worker.once('message', async (message) => {
    got = true;
    await worker.terminate();
    resolvePromise(message);
  });
  worker.once('error', rejectPromise);
  worker.once('exit', (code) => {
    if (!got && code !== 0) rejectPromise(new Error(`worker exit ${code}`));
  });
});

console.log(`@@RESULT@@ ${JSON.stringify(result)}`);
