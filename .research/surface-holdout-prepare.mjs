import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const out=resolve(process.env.EVIDENCE_DIR);
const source=await readFile(new URL('./surface-fresh-isolate.mjs',import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
assert.equal(hash(source),'fc4dde187aa14dde061b70ea241bfe14690f1a783c423d7f7194525b22388ffe');
assert.equal(source.split('const CLUSTERS = 64;').length,2);
const runner=source.replace('const CLUSTERS = 64;','const CLUSTERS = 256;');
assert.equal(runner.replace('const CLUSTERS = 256;','const CLUSTERS = 64;'),source);
const worker=await readFile(join(out,'surface-turn-worker.mjs'));
assert.equal(hash(worker),'b41017ec489644bbeed2e4cb8df998b5f3193a8c05eab16b6b5ee8ab917d93d1');
await writeFile(join(out,'surface-holdout-runner.mjs'),runner);
await writeFile(join(out,'fixed-holdout-policy.json'),JSON.stringify({
 independentWorkersPerProfile:256,observationsPerSidePerWorker:2,
 warmBurstsPerSide:128,ordinaryCalls:32,rejectionAndBatchCalls:8,
 bootstrapIterations:10000,bootstrapSeed:20260912,
 candidate:'b3196727d4df97f90d7a587e1e6f7e6e7b1d7024',
 base:'6008d916ac053bc104050d9c75aad69b04d4a878',
 sourceSha256:hash(source),runnerSha256:hash(runner),workerSha256:hash(worker),
 onlyRunnerDelta:'64 -> 256 independent workers; all thresholds, operations, controls and bootstrap unchanged',
 stopping:'One fixed-size holdout. No pilot pooling, early stopping, filtering or count increase after results. Candidate only after all new controls admit.',
 sizing:'Baseline-only empirical precision projection: worst p95 CI half-width at64=.08847748;128=.05858807;256=.04476421. This is a heuristic, not a guarantee or measurement.'
},null,2));
console.log('FIXED_HOLDOUT_256: only independent-cluster count changed; immutable worker and statistical law verified');
