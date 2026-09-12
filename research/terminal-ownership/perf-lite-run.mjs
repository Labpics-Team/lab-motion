import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [baseRoot, candidateRoot, supportRoot, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const worker = fileURLToPath(new URL('./perf-lite-worker.mjs', import.meta.url));

function runWorker(root, multiplier = 1) {
  return JSON.parse(execFileSync(process.execPath, [worker, root, supportRoot, String(multiplier)], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  }));
}

function runFamily(kind, blocks) {
  const rows = [];
  for (let block = 0; block < blocks; block++) {
    const executionOrder = block % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
    const row = { block, kind, executionOrder };
    for (const side of executionOrder) {
      if (kind === 'ab') {
        row[side] = runWorker(side === 'a' ? baseRoot : candidateRoot, 1);
      } else if (kind === 'aa') {
        row[side] = runWorker(baseRoot, 1);
      } else {
        row[side] = runWorker(baseRoot, side === 'a' ? 1 : 2);
      }
    }
    rows.push(row);
    writeFileSync(`${outDir}/${kind}.json`, JSON.stringify({ kind, blocks, rows }));
    console.log(`${kind}: ${block + 1}/${blocks}`);
  }
}

runFamily('aa', 8);
runFamily('positive', 6);
runFamily('ab', 20);
