import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { writeServerArtifact, parseServerJsonBytes } from '/workspace/scratch/motion-server-method-final-20261001T144242Z/source/bench/profile/server-profile-contract.mjs';

const directory = '/tmp/server-method-second-order-144242Z';
const out = '/workspace/scratch/server-method-second-order-final-20261001/closure-144242Z';
const originalWrite = fs.writeSync, originalClose = fs.closeSync;
let calls = 0, closed = 0;
fs.writeSync = function(...args) {
  calls++;
  if (calls === 8) throw Object.assign(new Error('bounded injected storage full'), { code: 'ENOSPC' });
  return originalWrite(...args);
};
fs.closeSync = function(...args) { closed++; return originalClose(...args); };
syncBuiltinESMExports();
const file = directory + '/injected-storage-partial.json';
let failure;
try { writeServerArtifact(file, { acquiredPrefix: ['one', 'two'], plannedTail: ['three'], verdict: 'UNPROVEN' }); }
catch (error) { failure = error; }
finally { fs.writeSync = originalWrite; fs.closeSync = originalClose; syncBuiltinESMExports(); }
assert.equal(failure?.code, 'ENOSPC'); assert.equal(closed, 1);
const bytes = fs.readFileSync(file);
assert.ok(bytes.length > 0); assert.throws(() => parseServerJsonBytes(bytes));
assert.throws(() => writeServerArtifact(file, { replacement: true }), (error) => error.code === 'EEXIST');
const result = { schema: 1, axis: 'second-order SERVER METHOD storage/lifecycle boundary',
  command: [process.execPath, ...process.argv.slice(1)], actualRegisteredPerformanceSamples: 0,
  syntheticOnly: true, status: 'PASS', fault: 'in-process injected ENOSPC on eighth write only',
  propagatedCode: failure.code, descriptorCloseCalls: closed, file, partialBytes: bytes.length,
  partialSha256: createHash('sha256').update(bytes).digest('hex'), partialContent: bytes.toString(),
  partialParserRefused: true, existingPartialOverwriteRefused: true,
  limits: 'not an actual ENOSPC/SIGKILL/OOM/durable storage or whole-series recovery experiment' };
fs.writeFileSync(out + '/storage-probe-result.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
