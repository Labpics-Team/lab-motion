import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SERVER_PROFILE, serverProfileDigest } from '/workspace/scratch/motion-server-method-final-20261001T144242Z/source/bench/profile/server-profile-registration.mjs';
import { SERVER_PROFILE as previousProfile } from '/workspace/scratch/motion-server-method-final-20261001T105048Z/source/bench/profile/server-profile-registration.mjs';

const packet = '/workspace/scratch/motion-server-method-final-20261001T144242Z';
const out = '/workspace/scratch/server-method-second-order-final-20261001/closure-144242Z';
const current = structuredClone(SERVER_PROFILE.clockError), previous = structuredClone(previousProfile.clockError);
delete current.sources; delete previous.sources; delete current.documentFrame; delete previous.documentFrame;
assert.deepEqual(current, previous);
const declared = JSON.parse(readFileSync(packet + '/primary-clock-sources/sources-manifest.json'));
assert.deepEqual(SERVER_PROFILE.clockError.sources, declared);
const files = readdirSync(packet + '/primary-clock-sources').filter((name) => name !== 'sources-manifest.json')
  .map((name) => { const bytes = readFileSync(packet + '/primary-clock-sources/' + name); return { name,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }; });
const sources = Object.entries(declared).map(([key, value]) => {
  const matches = files.filter((file) => file.sha256 === value.sha256);
  assert.equal(matches.length, 1); return { key, ...value, file: matches[0].name, bytes: matches[0].bytes };
});
assert.equal(sources.length, 17);
const result = { schema: 1, axis: 'second-order clock-source ownership/identity only', status: 'PASS',
  command: [process.execPath, ...process.argv.slice(1)], actualRegisteredPerformanceSamples: 0,
  clockModelDigest: serverProfileDigest(SERVER_PROFILE.clockError), numericAndBinaryPolicyFieldsUnchangedFrom6fe08: true,
  registeredSourcesMatchPrimaryManifest: true, sources,
  scope: 'hash/source roster relation only; no upstream clock/numerical/measurement correctness verdict' };
writeFileSync(out + '/clock-source-binding-result.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
