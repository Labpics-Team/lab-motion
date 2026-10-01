// Полные синтетические carriers проверяют parser/fault boundary, не perf.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { createGunzip, createGzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = '/workspace/lab-motion', out = path.dirname(fileURLToPath(import.meta.url));
const prefix = readFileSync(`${root}/test/server-profile-contract.test.ts`, 'utf8')
  .split("describe('серверный PROFILE: clock/progress falsifiers'")[0]
  .replace(/import \{[^\n]+\} from 'vitest';\n/, '').replaceAll("'../bench/", `'${root}/bench/`);
writeFileSync(`${out}/onset-synthetic-fixtures.mjs`, createRequire(`${root}/package.json`)('esbuild')
  .transformSync(`${prefix}\nexport { healthyAdmission, admissionEvents };`, { loader: 'ts', target: 'es2022', format: 'esm' }).code);
const { healthyAdmission, admissionEvents } = await import(pathToFileURL(`${out}/onset-synthetic-fixtures.mjs`).href);
const { writeServerArtifact, serverArtifactDigest } = await import(`${root}/bench/profile/server-profile-contract.mjs`);
const { SERVER_PROFILE, serverProfileDigest } = await import(`${root}/bench/profile/server-profile-registration.mjs`);
const results = [];
function writeJournal(file, events) {
  const descriptor = openSync(file, 'wx'), hash = createHash('sha256'); let bytes = 0, previous = '0'.repeat(64);
  try {
    for (const event of events) {
      const payload = { sequenceDigest: previous, ...event }; previous = serverProfileDigest(payload);
      const buffer = Buffer.from(`${JSON.stringify({ ...payload, digest: previous })}\n`);
      hash.update(buffer); bytes += buffer.length;
      let offset = 0; while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
  } finally { closeSync(descriptor); }
  return { sha256: hash.digest('hex'), bytes };
}
async function fileHash(file, zipped = false) {
  const hash = createHash('sha256'); let bytes = 0;
  const stream = zipped ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
async function replay(name, artifact, expected, events = admissionEvents(artifact), extra = {}) {
  const rawPath = `${out}/${name}.json`, journalPath = `${out}/${name}.ndjson`;
  const raw = writeServerArtifact(rawPath, artifact), journal = writeJournal(journalPath, events);
  const argv = [`${root}/bench/profile/server-profile-contract.mjs`, '--raw', rawPath, '--digest', raw.sha256, '--journal', journalPath];
  const startUtc = new Date().toISOString();
  const executed = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  const receipt = { name, synthetic: true, actualTimingSamplesObserved: 0, protocolDigest: serverProfileDigest(SERVER_PROFILE),
    command: [process.execPath, ...argv], startUtc, endUtc: new Date().toISOString(), raw, journal,
    registeredRuns: artifact.samplePlan.runs, independentBlocks: artifact.samplePlan.runs / 2,
    status: executed.status, signal: executed.signal, error: executed.error?.message ?? null, stdout: executed.stdout, stderr: executed.stderr, expected, ...extra };
  receipt.matched = expected === 'REJECT' ? executed.status !== null && executed.status !== 0 && !executed.error
    : executed.status === 0 && JSON.parse(executed.stdout).verdict === expected;
  results.push(receipt); writeFileSync(`${out}/public-cli-first-publication-results.json`, `${JSON.stringify(results, null, 2)}\n`);
  for (const [file, identity] of [[rawPath, raw], [journalPath, journal]]) {
    await pipeline(createReadStream(file), createGzip({ level: 1 }), createWriteStream(`${file}.gz`, { flags: 'wx' }));
    const readback = await fileHash(`${file}.gz`, true);
    if (readback.sha256 !== identity.sha256 || readback.bytes !== identity.bytes) throw new Error('gzip потерял acquired bytes');
    receipt[file.endsWith('.json') ? 'rawCompressed' : 'journalCompressed'] = await fileHash(`${file}.gz`);
    unlinkSync(file);
  }
  writeFileSync(`${out}/public-cli-first-publication-results.json`, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (!receipt.matched) process.exitCode = 1;
}
const healthy = healthyAdmission(); healthy.synthetic = 'вымышленные provenance/counters, actualTimingSamplesObserved=0';
await replay('onset-healthy-fullN', healthy, 'PASS');
function changedSample(scene, change) {
  const rows = [...healthy.ab.rows], index = rows.findIndex((row) => row.kind === 'browser' && row.scene === scene);
  const row = rows[index], sample = structuredClone(row.samples.right); change(sample);
  rows[index] = { ...row, samples: { ...row.samples, right: sample } };
  return { ...healthy, ab: { ...healthy.ab, rows } };
}
const primary = JSON.parse(readFileSync(`${out}/current-primary-first-publication-result.json`, 'utf8'));
const whole = JSON.parse(readFileSync(`${out}/current-whole-first-publication-result.json`, 'utf8'));
for (const [scene, name] of [['s2', 'initial-jump75px-shortened-motion'], ['s3', 'S3-initial-progress-quarter']]) {
  const trace = primary.rows.find((row) => row.name === name);
  await replay(`onset-primary-quarter-${scene}`, changedSample(scene, (sample) => {
    sample.semanticEvidence = structuredClone(trace.consumerInput.semanticEvidence); sample.semanticEvidence.valid = true;
  }), 'REJECT', undefined, { acquiredSemanticSourceSha256: createHash('sha256').update(readFileSync(`${out}/current-primary-first-publication-result.json`)).digest('hex'),
    sourceControl: name, forcedUpstreamValidTrue: true, actualClockModelDigest: sampleClockDigest(trace.consumerInput) });
}
function sampleClockDigest(sample) { return sample.clockModelDigest; }
for (const [duration, name] of [[256, 'duration256-narrow'], [64, 'duration64-narrow']]) {
  const trace = primary.rows.find((row) => row.name === name);
  await replay(`frame-actual-duration${duration}-all-new-fields`, changedSample('s2', (sample) => {
    sample.semanticEvidence = structuredClone(trace.consumerInput.semanticEvidence); sample.semanticEvidence.valid = true;
  }), 'REJECT', undefined, { forcedUpstreamValidTrue: true, actualSyntheticDurationMs: duration,
    hasActualDocumentFields: trace.evidence.checkpoints.every((checkpoint) => checkpoint.groups.every((group) => group.documentFrame)) });
}
for (const scene of ['s2','s3']) for (const part of ['first','late']) {
  const name = `stale50-${part}-quarter-${scene}`, trace = primary.rows.find((row) => row.name === name);
  await replay(`first-publication-${name}`, changedSample(scene, (sample) => {
    sample.semanticEvidence = structuredClone(trace.consumerInput.semanticEvidence); sample.semanticEvidence.valid = true;
  }), 'REJECT', undefined, { forcedUpstreamValidTrue: true,
    acquiredSemanticSourceSha256: createHash('sha256').update(readFileSync(`${out}/current-primary-first-publication-result.json`)).digest('hex'),
    freshBeforeAfterZero: [...trace.evidence.onset.before, ...trace.evidence.onset.after].every(group => group.positions.every(value => Math.abs(value) <= .5)),
    acquiredFirstFrame: trace.evidence.onset.firstFrame, sourceControl: name });
}
const healthyWhole = whole.receipts.find((row) => row.name === 'healthy');
const faultyWhole = whole.receipts.find((row) => row.name === 'timed-initial-progress-quarter');
await replay('onset-actual-whole-healthy', changedSample('s2', (sample) => {
  Object.assign(sample, structuredClone(healthyWhole.sample));
}), 'PASS', undefined, { wholeAcquisitionSourceSha256: createHash('sha256').update(readFileSync(`${out}/current-whole-first-publication-result.json`)).digest('hex') });
await replay('onset-actual-whole-timed-only-quarter', changedSample('s2', (sample) => {
  Object.assign(sample, structuredClone(faultyWhole.error.raw));
}), 'REJECT', undefined, { wholeAcquisitionSourceSha256: createHash('sha256').update(readFileSync(`${out}/current-whole-first-publication-result.json`)).digest('hex'),
  normalControlValid: faultyWhole.error.raw.semanticEvidence.valid, completeAcquiredRaw: faultyWhole.error.raw.raw.length });
await replay('onset-acquired-before-zero-corruption', changedSample('s2', (sample) => {
  sample.semanticEvidence.onset.before[0].positions = { encoding: 'rle', count: 100, runs: [[99, 0], [1, 75]] };
}), 'REJECT');
await replay('onset-wide-read-window-unresolved', changedSample('s2', (sample) => {
  for (const checkpoint of sample.semanticEvidence.checkpoints) { checkpoint.groups[0].readEndedMs = checkpoint.frameTimestampMs + 20; checkpoint.groups[0].documentFrame.afterMs += 0.01; }
}), 'REJECT');
await replay('onset-healthy-later-saturated', changedSample('s2', (sample) => {
  sample.semanticEvidence.checkpoints = [32, 64, 140].map((time) => ({ frameTimestampMs: time,
    groups: [{ readStartedMs: time, readEndedMs: time + 0.1,
      documentFrame: { beforeMs: time, afterMs: time }, positions: { encoding: 'rle', count: 100, runs: [[100, 300 * Math.min(1, time / 128)]] } }] }));
}), 'PASS');
const events = admissionEvents(healthy), firstAb = events.findIndex((event) => event.type === 'sample' && event.value.stage === 'ab');
const error = { name: 'AggregateError', message: 'синтетический timed onset отказал после приобретённого первого A/B owner',
  raw: structuredClone(faultyWhole.error.raw) };
const partial = { ...healthy, verdict: 'UNPROVEN', failures: [{ stage: 'ab', error }],
  ab: { ...healthy.ab, rows: [{ ...healthy.ab.rows[0], samples: { [events[firstAb].value.participant]: events[firstAb].value.value } }], blocks: [] } };
delete partial.comparison; delete partial.comparators; delete partial.retention;
const partialEvents = [...events.slice(0, firstAb + 1), { type: 'failed-sample', value: { ...events[firstAb + 1].value, value: undefined, error } },
  { type: 'failure', value: partial.failures[0] }, { type: 'finished', value: { verdict: partial.verdict, digest: serverArtifactDigest(partial) } }];
await replay('onset-partial-AB-complete-acquired-failure', partial, 'UNPROVEN', partialEvents);
