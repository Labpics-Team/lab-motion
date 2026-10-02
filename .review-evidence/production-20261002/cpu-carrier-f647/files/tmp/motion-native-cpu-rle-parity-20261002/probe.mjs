import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compactServerCpuEvidence as encode, expandServerCpuEvidence as decode,
  validateServerEngineSample } from '/workspace/lab-motion/bench/profile/server-profile-contract.mjs';
const root = '/workspace/lab-motion', out = '/tmp/motion-native-cpu-rle-parity-20261002';
const start = new Date().toISOString(), rows = [], sha = (x) => createHash('sha256').update(x).digest('hex');
const source = readFileSync(`${root}/test/server-profile-contract.test.ts`, 'utf8');
const prefix = source.slice(0, source.indexOf('// Исполняем настоящий browser owner'))
  .replace(/import \{[^\n]+\} from 'vitest';\n/, '').replaceAll("'../bench/", `'${root}/bench/`);
const esbuild = createRequire(`${root}/package.json`)('esbuild');
writeFileSync(`${out}/fixtures.mjs`, esbuild.transformSync(`${prefix}\nexport { stage, syntheticNativeEndpoint, nativeCpuEndpoint };`,
  { loader: 'ts', target: 'es2022', format: 'esm' }).code, { flag: 'wx' });
const fixture = await import(pathToFileURL(`${out}/fixtures.mjs`).href);
const { SERVER_PROFILE } = await import(`${root}/bench/profile/server-profile-registration.mjs`);
const roundtrip = (name, original) => {
  const initial = JSON.stringify(original), encoded = encode(original), acquired = structuredClone(encoded);
  const expanded = decode(JSON.parse(JSON.stringify(encoded)), original.length);
  assert.deepEqual(expanded, original); assert.equal(JSON.stringify(expanded), initial); assert.equal(JSON.stringify(original), initial);
  rows.push({ name, original, encoded: acquired, restored: expanded, bytes: { before: Buffer.byteLength(initial),
    encoded: Buffer.byteLength(JSON.stringify(encoded)), restored: Buffer.byteLength(JSON.stringify(expanded)) }, passed: true });
};
const endpoint = (ns, sequence, pid = 12345) => ({ sequence, clock: 'CLOCK_THREAD_CPUTIME_ID', pid, tid: pid,
  seconds: String(ns / 1_000_000_000n), nanoseconds: Number(ns % 1_000_000_000n), valueNs: String(ns) });
roundtrip('empty-warmup', []);
for (const [name, ns] of [['zero', 0n], ['one-ns', 1n], ['second-boundary', 999_999_999n],
  ['above-number-integer', 9_007_199_254_740_993n * 1_000_000_000n + 17n], ['signed64-second-bound', 9_223_372_036_854_775_807n * 1_000_000_000n + 999_999_999n]]) {
  roundtrip(name, [endpoint(ns, 0), endpoint(ns, 1)]);
}
roundtrip('same-and-changing-metadata-runs', [endpoint(1n, 0), endpoint(2n, 1), endpoint(3n, 2, 45678), endpoint(4n, 3, 12345)]);
const staged = fixture.stage('positive', 2);
for (const row of staged.rows.filter((r) => r.kind === 'engine')) for (const [id, sample] of Object.entries(row.samples)) {
  const scene = SERVER_PROFILE.engineScenes.find((s) => s.id === row.scene), old = structuredClone(sample);
  validateServerEngineSample(sample, scene, sample.workMultiplier);
  for (const [i, measured] of sample.raw.entries()) {
    roundtrip(`${row.scene}/${row.run}/${id}/raw-${i}`, measured.raw.cpuReads);
    measured.raw.cpuReads = encode(measured.raw.cpuReads);
  }
  validateServerEngineSample(sample, scene, sample.workMultiplier);
  const restored = structuredClone(sample);
  for (const measured of restored.raw) measured.raw.cpuReads = decode(measured.raw.cpuReads, measured.raw.clockReads.length);
  assert.deepEqual(restored, old); assert.equal(JSON.stringify(restored), JSON.stringify(old));
  rows.push({ name: `${row.scene}/${row.run}/${id}/consumer-parity`, passed: true });
}
const mutations = [
  ['ordinal', (v) => { v[1].sequence = 0; }], ['signed-zero-ordinal', (v) => { v[0].sequence = -0; }],
  ['derived-value', (v) => { v[1].valueNs = '99'; }], ['leading-zero-seconds', (v) => { v[0].seconds = '00'; }],
  ['negative-seconds', (v) => { v[0].seconds = '-1'; }], ['wide-seconds', (v) => { v[0].seconds = '9223372036854775808'; }],
  ['signed-zero-nanoseconds', (v) => { v[0].nanoseconds = -0; }], ['fractional-nanoseconds', (v) => { v[0].nanoseconds = 0.5; }],
  ['missing-field', (v) => { delete v[0].seconds; }], ['unknown-field', (v) => { v[0].unknown = 'must remain raw'; }],
  ['unknown-array-field', (v) => { v.extra = 'must remain raw'; }], ['reordered-fields', (v) => { const first = v[0].sequence; delete v[0].sequence; v[0].sequence = first; }],
  ['wrong-clock', (v) => { v[0].clock = 'process.threadCpuUsage'; }], ['worker-identity', (v) => { v[0].tid++; }],
  ['hole', (v) => { delete v[0]; }], ['accessor', (v) => { Object.defineProperty(v[0], 'seconds', { enumerable: true, get() { throw Error('getter must remain unused'); } }); }],
];
for (const [name, mutate] of mutations) {
  const original = [endpoint(1n, 0), endpoint(2n, 1)]; mutate(original); const descriptors = Object.getOwnPropertyDescriptors(original[0] ?? {});
  let error; try { encode(original); } catch (value) { error = { name: value.name, message: value.message }; }
  assert(error, name); assert.deepEqual(Object.getOwnPropertyDescriptors(original[0] ?? {}), descriptors);
  rows.push({ name: `encoder-refusal/${name}`, error, retainedOriginal: true });
}
for (const [name, mutate] of [['count', (v) => { v.count++; }], ['gap', (v) => { v.runs[0].from++; }],
  ['signed-zero-from', (v) => { v.runs[0].from = -0; }], ['lost-values', (v) => { v.runs[0].values.pop(); }],
  ['bad-timespec', (v) => { v.runs[0].values[0][0] = '00'; }], ['extra-field', (v) => { v.extra = 'unclaimed'; }]]) {
  const value = encode([endpoint(1n, 0), endpoint(2n, 1)]); mutate(value);
  assert.throws(() => decode(value, 2), /native CPU/); rows.push({ name: `decoder-refusal/${name}`, passed: true });
}
const record = { startUtc: start, endUtc: new Date().toISOString(), node: process.version, cases: rows.length, failures: 0, rows,
  currentOwnerSha256: sha(readFileSync(`${root}/bench/profile/server-profile-contract.mjs`)), sourceTestSha256: sha(source),
  actualRegisteredPerformanceSamples: 0, scope: 'Independent full original vectors and native fields -> encoded JSON -> exact decoded seven fields; unchanged consumer accepts/rejects equivalent logical data.' };
writeFileSync(`${out}/result.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ startUtc: start, endUtc: record.endUtc, cases: record.cases, failures: 0 }) + '\n');
