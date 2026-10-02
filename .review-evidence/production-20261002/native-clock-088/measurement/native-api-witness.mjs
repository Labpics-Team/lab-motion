import assert from 'node:assert/strict';
import { prepareServerThreadCpuClock, readServerThreadCpuEndpoint } from './source/bench/profile/server-thread-cpu-clock.mjs';
import { SERVER_PROFILE } from './source/bench/profile/server-profile-registration.mjs';
const prepared = prepareServerThreadCpuClock({ directory: process.argv[2] });
const first = readServerThreadCpuEndpoint();
const second = readServerThreadCpuEndpoint();
for (const value of [first, second]) {
  assert.equal(value.clock, 'CLOCK_THREAD_CPUTIME_ID');
  assert.equal(value.pid, process.pid);
  assert.equal(value.tid, process.pid);
  assert.equal(value.valueNs, String(BigInt(value.seconds) * 1_000_000_000n + BigInt(value.nanoseconds)));
}
assert.ok(BigInt(second.valueNs) >= BigInt(first.valueNs));
assert.deepEqual(prepared.metadata.nativeSources, SERVER_PROFILE.clockError.nativeSourceFiles);
assert.equal(prepared.metadata.nominalResolutionIsNotErrorCertificate, true);
prepared.assertUnchanged();
process.stdout.write(JSON.stringify({ sourceHead: '088fbc605c95fd6a6a7620301a450d6388386997',
  abiOnly: true, performanceClaim: false, metadata: prepared.metadata, first, second }, null, 2) + '\n');
