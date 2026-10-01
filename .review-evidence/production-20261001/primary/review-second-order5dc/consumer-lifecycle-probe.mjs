import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SERVER_PROFILE, serverProfileDigest, verifyServerProfile } from '/workspace/scratch/motion-server-method-final-20261001T144242Z/source/bench/profile/server-profile-registration.mjs';
import { SERVER_PROFILE as oldProfile } from '/workspace/scratch/motion-server-method-final-20261001T105048Z/source/bench/profile/server-profile-registration.mjs';
import { evaluateStartSemanticEvidence, START_SCENARIO_MANIFEST } from '/workspace/scratch/motion-server-method-final-20261001T144242Z/source/bench/compare/methodology.mjs';
import { evaluateStartSemanticEvidence as oldOracle } from '/workspace/scratch/motion-server-method-final-20261001T105048Z/source/bench/compare/methodology.mjs';
import { compactServerSemanticEvidence, parseServerJsonBytes, parseServerJournalBytes, serverArtifactDigest,
  serverBrowserClockBounds, validateServerArtifact, validateServerBrowserSample, validateServerJournal, writeServerArtifact } from '/workspace/scratch/motion-server-method-final-20261001T144242Z/source/bench/profile/server-profile-contract.mjs';
import { serverBrowserClockBounds as oldCostClock, validateServerBrowserSample as oldSampleReader } from '/workspace/scratch/motion-server-method-final-20261001T105048Z/source/bench/profile/server-profile-contract.mjs';
import { stage } from '/tmp/server-method-second-order-144242Z/frozen-synthetic-fixtures.mjs';

const out = '/workspace/scratch/server-method-second-order-final-20261001/closure-144242Z';
const privateScratch = '/tmp/server-method-second-order-144242Z';
const result = { schema: 1, axis: 'second-order SERVER METHOD', actualRegisteredPerformanceSamples: 0,
  syntheticOnly: true, command: [process.execPath, ...process.argv.slice(1)], cases: [] };
const sha = (data) => createHash('sha256').update(data).digest('hex');
const run = (name, test) => result.cases.push({ name, status: 'PASS', ...test() });
function linearCarrier(config, calls, times) {
  return { topology: { calls, targetsPerCall: config.targetsPerCall, staggerGapMs: config.staggerGapMs,
    durationMs: config.durationMs, toPx: config.toPx }, callStartedAtMs: Array(calls).fill(0),
    checkpoints: times.map((time) => ({ frameTimestampMs: time, groups: Array.from({ length: calls }, () => ({
      readStartedMs: time, readEndedMs: time,
      positions: Array.from({ length: config.targetsPerCall }, (_, target) => config.toPx * Math.max(0,
        Math.min(1, (time - target * config.staggerGapMs) / config.durationMs))) })) })),
    terminal: Array.from({ length: calls }, () => Array(config.targetsPerCall).fill(config.toPx)) };
}
run('protocol and clock identity change, protected admission/resource fields remain exact', () => {
  assert.equal(serverProfileDigest(SERVER_PROFILE), '00e8d5880eb83dd27a52f90cc670d4ecc550229458af039d9924485805c25431');
  assert.equal(serverProfileDigest(SERVER_PROFILE.clockError), '7e45adab88a2c97af4e9074543318ae115e42b5c9669c4746b6e149d42bfbc4f');
  const current = structuredClone(SERVER_PROFILE), previous = structuredClone(oldProfile);
  delete current.clockError; delete previous.clockError;
  for (const key of ['requireFreshStart', 'requireDocumentFrame', 'fromPx', 'temporalOracle']) {
    delete current.browserSemantics[key]; delete previous.browserSemantics[key];
  }
  assert.deepEqual(current, previous);
  assert.throws(() => verifyServerProfile(oldProfile), /изменён зарегистрированный протокол/);
  for (const clock of [{ beginMs: 0, endMs: 0 }, { beginMs: 1, endMs: 2 }, { beginMs: 120, endMs: 120.8 }]) {
    assert.deepEqual(serverBrowserClockBounds(clock, '1000000000000'), oldCostClock(clock, '1000000000000'));
  }
  return { protocol: serverProfileDigest(SERVER_PROFILE), clockModel: serverProfileDigest(SERVER_PROFILE.clockError),
    preserved: 'all non-clock fields except explicit fresh/document-frame semantics; N, thresholds, counts, timeouts, caps, denominators and scope exact',
    apiCostOutputCompatibilityCases: 3, scope: 'identity/output compatibility, no independent numerical certificate' };
});
run('canonical S1-S4 consumers retain their previous carrier without onset/document-frame requirements', () => {
  const cases = Object.entries(START_SCENARIO_MANIFEST).map(([id, config]) => {
    const times = config.staggerGapMs ? [0.2, 0.5, 0.8].map((fraction) => config.staggerGapMs * (config.targetsPerCall - 1) * fraction)
      : [0.25, 0.5, 0.625].map((fraction) => config.durationMs * fraction);
    const raw = linearCarrier(config, config.warmCalls, times);
    assert.equal(evaluateStartSemanticEvidence(raw, config, config.warmCalls), true);
    assert.equal(oldOracle(raw, config, config.warmCalls), true);
    assert.equal(Object.hasOwn(raw, 'onset'), false);
    const legacy = structuredClone(raw); legacy.checkpoints.forEach((row) => delete row.frameTimestampMs);
    assert.equal(evaluateStartSemanticEvidence(legacy, config, config.warmCalls), true);
    return { id, calls: config.warmCalls, durationMs: config.durationMs, current: true, prior6fe08: true, legacyTimestampCarrier: true };
  });
  return { cases, scope: 'only these synthetic consumer histories; no numerical or browser acceptance' };
});
run('new server onset fields are mandatory, old direct sample reader explicitly refuses the current clock-model carrier', () => {
  const fixture = stage('pilot', 2);
  const cases = SERVER_PROFILE.browserScenes.map((scene) => {
    const sample = fixture.rows.find((row) => row.scene === scene.id).samples.left;
    validateServerBrowserSample(sample, scene);
    assert.throws(() => oldSampleReader(sample, oldProfile.browserScenes.find((row) => row.id === scene.id)), /clock evidence\/model/);
    const missing = structuredClone(sample); delete missing.semanticEvidence.onset.firstFrame;
    assert.throws(() => validateServerBrowserSample(missing, scene), /normal-motion/);
    assert.throws(() => oldSampleReader(missing, oldProfile.browserScenes.find((row) => row.id === scene.id)), /clock evidence\/model/);
    return { id: scene.id, completeCurrentCarrierAccepted: true, missingFirstPublicationRefusedCurrent: true,
      currentClockModelCarrierRefusedPriorDirectSampleReader: true };
  });
  return { cases, fullArtifactBoundary: 'current protocol rejects old whole artifact; direct old sample reader is insufficient for current admission' };
});
run('codec preserves complete first-publication fields and incomplete acquired prefixes without filling observations', () => {
  const original = { valid: false, topology: { calls: 1 }, callStartedAtMs: [], checkpoints: [{ unknown: 'kept', groups: null }],
    terminal: [], onset: { before: [{ readStartedMs: 0.01, positions: Array(17).fill(0), acquiredMarker: 'prefix' }],
      after: [], acquiredNote: 'do not fill missing targets', firstFrame: { frameTimestampMs: null, groups: [] } },
    failures: [{ phase: 'onset-before', name: 'Error', message: 'bounded synthetic read refusal' }], extra: { immutableMarker: 7 } };
  const compact = compactServerSemanticEvidence(original);
  assert.deepEqual(compact.onset.before[0].positions, { encoding: 'rle', count: 17, runs: [[17, 0]] });
  assert.equal(Object.hasOwn(compact.onset.before[0], 'readEndedMs'), false);
  assert.deepEqual(compact.onset.after, []); assert.deepEqual(compact.onset.firstFrame, original.onset.firstFrame);
  assert.deepEqual(compact.failures, original.failures); assert.deepEqual(compact.extra, original.extra);
  assert.deepEqual(compact.checkpoints, original.checkpoints); assert.equal(compact.onset.acquiredNote, original.onset.acquiredNote);
  assert.equal(compactServerSemanticEvidence(null), null);
  const dense = { onset: { before: [{ positions: Array.from({ length: 100 }, (_, i) => i) }], after: [],
    firstFrame: { frameTimestampMs: 32, groups: [{ positions: [0, 1, 2], documentFrame: { beforeMs: 32, afterMs: 32 }, readStartedMs: 33, readEndedMs: 34 }] } } };
  const projected = compactServerSemanticEvidence(dense);
  assert.deepEqual(projected.onset.before[0].positions.runs.flatMap(([length, value]) => Array(length).fill(value)), dense.onset.before[0].positions);
  assert.deepEqual({ ...projected.onset.firstFrame.groups[0], positions: dense.onset.firstFrame.groups[0].positions }, dense.onset.firstFrame.groups[0]);
  return { acquiredPrefixCount: compact.onset.before[0].positions.count, missingEndRemainsMissing: true,
    failureAndExtraFieldsPreserved: true, denseTargetsRetained: 100, denseFixtureNativeBytes: Buffer.byteLength(JSON.stringify(dense)),
    denseFixtureRleBytes: Buffer.byteLength(JSON.stringify(projected)), compressionGuarantee: false };
});
run('accepted refusal hashes every journal body after chronology; corruption and unfinished output remain refusal', () => {
  const artifact = { schema: 1, protocol: SERVER_PROFILE, registration: null, registrationDigest: null, verdict: 'UNPROVEN',
    failures: [{ stage: 'preparation', error: { name: 'Error', message: 'bounded current refusal, samples0' } }] };
  const rawFile = privateScratch + '/current-refusal.json';
  const raw = writeServerArtifact(rawFile, artifact);
  assert.equal(raw.sha256, serverArtifactDigest(artifact));
  const events = [{ type: 'failure', value: artifact.failures[0] }, { type: 'finished', value: { verdict: artifact.verdict, digest: raw.sha256 } }];
  let previous = '0'.repeat(64);
  const records = events.map((event) => { const payload = { sequenceDigest: previous, ...event };
    const digest = serverProfileDigest(payload); previous = digest; return { ...payload, digest }; });
  const journal = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  writeFileSync(privateScratch + '/current-refusal.ndjson', journal, { flag: 'wx' });
  assert.deepEqual(parseServerJsonBytes(readFileSync(rawFile), 11), artifact);
  assert.deepEqual(parseServerJournalBytes(Buffer.from(journal)), records);
  assert.equal(validateServerArtifact(artifact).verification, 'preparation-refused');
  const chronology = validateServerJournal(artifact, records, raw.sha256);
  assert.throws(() => validateServerJournal(artifact, records.slice(0, 1), raw.sha256), /оборван/);
  const changedBody = structuredClone(records); changedBody[1].unclaimed = 'all fields must hash';
  assert.throws(() => validateServerJournal(artifact, changedBody, raw.sha256), /цепь/);
  writeFileSync(privateScratch + '/changed-body.ndjson', changedBody.map((record) => JSON.stringify(record)).join('\n') + '\n', { flag: 'wx' });
  assert.throws(() => writeServerArtifact(rawFile, artifact), (error) => error.code === 'EEXIST');
  assert.equal(sha(readFileSync(rawFile)), raw.sha256);
  const oldArtifact = JSON.parse(readFileSync('/workspace/scratch/server-method-second-order-final-20261001/closure-105048Z/current-preparation-refusal.json', 'utf8'));
  assert.throws(() => validateServerArtifact(oldArtifact), /изменён зарегистрированный протокол/);
  return { raw, chronology, bodyTamperRefused: true, unfinishedRefused: true, exclusiveOutputPreserved: true,
    rawFile, journalFile: privateScratch + '/current-refusal.ndjson', journalSha256: sha(journal) };
});
writeFileSync(out + '/consumer-lifecycle-result.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
