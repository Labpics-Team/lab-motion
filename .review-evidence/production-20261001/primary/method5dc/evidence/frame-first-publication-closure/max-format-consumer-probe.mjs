// Только bounded synthetic format/consumer witness: никакой actual timing.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { createGzip, createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = '/workspace/lab-motion', out = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(`${root}/test/server-profile-contract.test.ts`, 'utf8')
  .split("describe('серверный PROFILE: clock/progress falsifiers'")[0]
  .replace(/import \{[^\n]+\} from 'vitest';\n/, '').replaceAll("'../bench/", `'${root}/bench/`);
writeFileSync(`${out}/max-format-fixtures.mjs`, createRequire(`${root}/package.json`)('esbuild')
  .transformSync(`${source}\nexport { stage, registeredRefusal, admissionEvents };`, { loader: 'ts', target: 'es2022', format: 'esm' }).code);
const { stage, registeredRefusal, admissionEvents } = await import(pathToFileURL(`${out}/max-format-fixtures.mjs`).href);
const { SERVER_PROFILE, planServerSampleSize, serverProfileDigest } = await import(`${root}/bench/profile/server-profile-registration.mjs`);
const { serverOrders, serverCellPairs, serverFamilyIntervals, serverCalibrationVerdict, writeServerArtifact } = await import(`${root}/bench/profile/server-profile-contract.mjs`);
const artifact = registeredRefusal(); artifact.failures = []; artifact.verdict = 'PASS';
artifact.synthetic = 'N1024 carrier/consumer probe: source receipts, clocks и samples вымышлены; actualTimingSamplesObserved=0';
artifact.warmup = stage('warmup', SERVER_PROFILE.warmupRuns); artifact.pilot = stage('pilot', SERVER_PROFILE.pilotRuns);
const pilotPairs = serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, 'pilot');
let units;
for (let candidate = 1; candidate < 4000; candidate++) {
  const projected = pilotPairs.map((cell, index) => index ? cell : { ...cell,
    right: cell.right.map((value, run) => value + (Math.floor(run / 2) % 2 ? -1 : 1) * candidate * 125) });
  const plan = planServerSampleSize(projected);
  if (plan.requiredRuns === SERVER_PROFILE.maxRuns && plan.feasible) { units = candidate; break; }
}
if (!units) throw new Error('не найден exact feasible N1024 pilot fixture');
for (const row of artifact.pilot.rows.filter((row) => row.scene === SERVER_PROFILE.engineScenes[0].id)) {
  const sample = row.samples.right, sign = Math.floor(row.run / 2) % 2 ? -1 : 1;
  sample.raw.forEach((raw, repetition) => {
    const delta = sign * (Math.floor(units / 8) + (repetition < units % 8 ? 1 : 0)) * 1000;
    raw.operationNs += delta;
    for (let sequence = 1; sequence < raw.raw.clockReads.length; sequence++) {
      const valueNs = BigInt(raw.raw.clockReads[sequence].valueNs) + BigInt(delta);
      raw.raw.clockReads[sequence].valueNs = String(valueNs);
      raw.raw.cpuReads[sequence].userUs = Number(valueNs / 1000n); raw.raw.cpuReads[sequence].valueNs = String(valueNs);
    }
  });
  sample.operationNs = sample.raw.reduce((sum, raw) => sum + raw.operationNs, 0) / sample.repetitions;
}
artifact.samplePlan = planServerSampleSize(serverCellPairs(artifact.pilot, SERVER_PROFILE.pilotRuns, 'pilot'));
if (artifact.samplePlan.runs !== SERVER_PROFILE.maxRuns || !artifact.samplePlan.feasible) throw new Error('приобретённый fixture pilot не пересчитал N1024');
function expandedStage(name) {
  const template = stage(name, 2), orders = serverOrders(SERVER_PROFILE.maxRuns), scenes = SERVER_PROFILE.engineScenes.length + SERVER_PROFILE.browserScenes.length;
  const rows = Array.from({ length: SERVER_PROFILE.maxRuns }, (_, run) => template.rows.slice((run % 2) * scenes, (run % 2 + 1) * scenes)
    .map((row) => ({ ...row, run, order: orders[run] }))).flat();
  // Shared references принадлежат только synthetic builder. Каждый sample
  // записывается полностью и decoded consumer получает независимые JSON values.
  const blocks = Array.from({ length: SERVER_PROFILE.maxRuns / 2 }, (_, block) => ({ ...template.blocks[0], block }));
  return { name, rows, blocks };
}
artifact.aa = expandedStage('aa'); artifact.positive = expandedStage('positive'); artifact.ab = expandedStage('ab');
artifact.frozenPlanDigest = serverProfileDigest({ registrationDigest: artifact.registrationDigest, samplePlan: artifact.samplePlan });
const aa = serverFamilyIntervals(serverCellPairs(artifact.aa, artifact.samplePlan.runs, 'aa'));
const positive = serverFamilyIntervals(serverCellPairs(artifact.positive, artifact.samplePlan.runs, 'positive'));
artifact.calibration = { ...serverCalibrationVerdict(aa, positive, artifact.samplePlan), aa, positive };
artifact.comparison = serverFamilyIntervals(serverCellPairs(artifact.ab, artifact.samplePlan.runs, 'ab'));
const hash = 'a'.repeat(64), control = { noMotion: { equal: true, beforeSha256: hash, afterSha256: hash },
  reduced: { prefersReducedMotion: true, x: SERVER_PROFILE.toPx, rafRequests: 0, activeWaapi: 0 } };
artifact.rawControls = { baseline: structuredClone(control), candidate: structuredClone(control) };
artifact.comparators = SERVER_PROFILE.browserScenes.flatMap((scene) => SERVER_PROFILE.comparators.map((id) => {
  if (scene.staggerGapMs && ['motion-mini', 'anime-waapi'].includes(id)) return { scene: scene.id, id, status: 'UNPROVEN', reason: 'общего stagger API нет' };
  const sample = artifact.ab.rows.find((row) => row.scene === scene.id).samples.left;
  return { scene: scene.id, id, rows: Array(artifact.samplePlan.runs).fill(sample) };
}));
const retained = { verdict: 'COMPLETE', failure: null, rows: SERVER_PROFILE.engineScenes.map((scene) => ({ scene: scene.id,
  before: { heapUsed: 1000 }, after: { heapUsed: 900 }, retainedHeapDeltaBytes: -100 })) };
artifact.retention = { baseline: structuredClone(retained), candidate: structuredClone(retained) };
const rawPath = `${out}/maxN1024.json`, journalPath = `${out}/maxN1024.ndjson`;
const raw = writeServerArtifact(rawPath, artifact), descriptor = openSync(journalPath, 'wx'), hashJournal = createHash('sha256');
let journalBytes = 0, previous = '0'.repeat(64);
try {
  for (const event of admissionEvents(artifact)) {
    const payload = { sequenceDigest: previous, ...event }; previous = serverProfileDigest(payload);
    const buffer = Buffer.from(`${JSON.stringify({ ...payload, digest: previous })}\n`); hashJournal.update(buffer); journalBytes += buffer.length;
    let offset = 0; while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
  }
} finally { closeSync(descriptor); }
const journal = { sha256: hashJournal.digest('hex'), bytes: journalBytes };
const argv = [`${root}/bench/profile/server-profile-contract.mjs`, '--raw', rawPath, '--digest', raw.sha256, '--journal', journalPath];
const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
const receipt = { synthetic: true, actualTimingSamplesObserved: 0, command: [process.execPath, ...argv], protocolDigest: serverProfileDigest(SERVER_PROFILE),
  runs: artifact.samplePlan.runs, requiredRuns: artifact.samplePlan.requiredRuns, feasible: artifact.samplePlan.feasible,
  stageRows: Object.fromEntries(['aa', 'positive', 'ab'].map((name) => [name, artifact[name].rows.length])),
  raw, journal, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null };
receipt.matched = result.status === 0 && JSON.parse(result.stdout).verdict === 'PASS' && raw.bytes > 512 * 1024 * 1024 && journal.bytes > 512 * 1024 * 1024;
writeFileSync(`${out}/maxN1024-consumer-receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
async function hashFile(file, zipped = false) {
  const hash = createHash('sha256'); let bytes = 0;
  const stream = zipped ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  for await (const buffer of stream) { hash.update(buffer); bytes += buffer.length; }
  return { sha256: hash.digest('hex'), bytes };
}
for (const [file, expected] of [[rawPath, raw], [journalPath, journal]]) {
  await pipeline(createReadStream(file), createGzip({ level: 1 }), createWriteStream(`${file}.gz`, { flags: 'wx' }));
  const readback = await hashFile(`${file}.gz`, true);
  if (readback.sha256 !== expected.sha256 || readback.bytes !== expected.bytes) throw new Error('потерян exact maxN1024 carrier');
  receipt[file.endsWith('.json') ? 'rawCompressed' : 'journalCompressed'] = await hashFile(`${file}.gz`);
  unlinkSync(file);
}
writeFileSync(`${out}/maxN1024-consumer-receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (!receipt.matched) process.exitCode = 1;
