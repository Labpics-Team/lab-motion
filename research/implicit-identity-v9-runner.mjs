import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE_SHA = '93278bf9b540f93521c7bd4c02f68db458e5db7a';
const CANDIDATE_SHA = '0b01ae2b34db2b78c11acf9c4242e73538717c95';
const SEED = 20260913;
const BOOTSTRAP_ITERS = 20_000;
const NULL_CLUSTERS = 24;
const POSITIVE_CLUSTERS = 12;
const AB_CLUSTERS = 24;
const BAND = 0.05;

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
const childPath = need('V9_CHILD');
const baseEntry = need('V9_BASE_ENTRY');
const candidateEntry = need('V9_CANDIDATE_ENTRY');
const pinCpu = need('V9_PIN_CPU');
const outPath = need('V9_OUT');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const profiles = [
  { id: 'sample-n3-linear', mode: 'sample', n: 3, easing: 'linear' },
  { id: 'sample-n3-quadratic', mode: 'sample', n: 3, easing: 'quadratic' },
  { id: 'sample-n1025-linear', mode: 'sample', n: 1025, easing: 'linear' },
  { id: 'sample-n1025-quadratic', mode: 'sample', n: 1025, easing: 'quadratic' },
  { id: 'seek-matched-n3', mode: 'seek-matched', n: 3, easing: 'linear' },
  { id: 'seek-matched-n1025', mode: 'seek-matched', n: 1025, easing: 'linear' },
];

function runChild(entry, profile, factor) {
  const args = [
    '-c', pinCpu,
    process.execPath, childPath,
    '--entry', entry,
    '--mode', profile.mode,
    '--n', String(profile.n),
    '--easing', profile.easing,
    '--factor', String(factor),
  ];
  const p = spawnSync('taskset', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(`child failed (${profile.id}, factor=${factor}): ${p.stderr}\n${p.stdout}`);
  const lines = p.stdout.trim().split(/\r?\n/).filter(Boolean);
  const value = JSON.parse(lines.at(-1));
  if (value.mode !== profile.mode || value.n !== profile.n || value.easingKind !== profile.easing || value.treatmentFactor !== factor) {
    throw new Error(`child metadata mismatch for ${profile.id}`);
  }
  if (!Array.isArray(value.observations) || value.observations.length !== 4) throw new Error(`bad observation count ${profile.id}`);
  for (const o of value.observations) {
    if (!(o.wallNsPerNominal > 0) || !(o.cpuNsPerNominal > 0)) throw new Error(`non-positive timing ${profile.id}`);
  }
  return value;
}

function geometricMean(values) {
  return Math.exp(values.reduce((sum, x) => sum + Math.log(x), 0) / values.length);
}

function runClusters(profile, aEntry, bEntry, count, aFactor = 1, bFactor = 1) {
  const clusters = [];
  for (let cluster = 0; cluster < count; cluster++) {
    let a, b;
    if ((cluster & 1) === 0) {
      a = runChild(aEntry, profile, aFactor);
      b = runChild(bEntry, profile, bFactor);
    } else {
      b = runChild(bEntry, profile, bFactor);
      a = runChild(aEntry, profile, aFactor);
    }
    const wallRatios = a.observations.map((x, i) => b.observations[i].wallNsPerNominal / x.wallNsPerNominal);
    const cpuRatios = a.observations.map((x, i) => b.observations[i].cpuNsPerNominal / x.cpuNsPerNominal);
    clusters.push({
      cluster,
      processOrder: (cluster & 1) === 0 ? 'A/B' : 'B/A',
      wallRatio: geometricMean(wallRatios),
      cpuRatio: geometricMean(cpuRatios),
      wallRatios,
      cpuRatios,
      a,
      b,
    });
  }
  return clusters;
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('empty quantile');
  if (p === 0.5 && sorted.length % 2 === 0) {
    const i = sorted.length / 2;
    return (sorted[i - 1] + sorted[i]) / 2;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function bootstrap(values, seed) {
  const random = lcg(seed);
  const p50 = [];
  const p95 = [];
  for (let iter = 0; iter < BOOTSTRAP_ITERS; iter++) {
    const sample = new Array(values.length);
    for (let i = 0; i < values.length; i++) sample[i] = values[Math.floor(random() * values.length)];
    p50.push(quantile(sample, 0.5));
    p95.push(quantile(sample, 0.95));
  }
  const summarize = (point, boot) => ({
    point,
    low: quantile(boot, 0.025),
    high: quantile(boot, 0.975),
  });
  return {
    p50: summarize(quantile(values, 0.5), p50),
    p95: summarize(quantile(values, 0.95), p95),
  };
}

function summarizeClusters(clusters, seedOffset) {
  return {
    wall: bootstrap(clusters.map((x) => x.wallRatio), (SEED + seedOffset) >>> 0),
    cpu: bootstrap(clusters.map((x) => x.cpuRatio), (SEED + seedOffset + 0x51ed270b) >>> 0),
  };
}

function nullPass(summary) {
  for (const metric of ['wall', 'cpu']) for (const q of ['p50', 'p95']) {
    const ci = summary[metric][q];
    if (ci.low < 1 - BAND || ci.high > 1 + BAND) return false;
  }
  return true;
}
function positivePass(summary) {
  for (const metric of ['wall', 'cpu']) for (const q of ['p50', 'p95']) {
    if (summary[metric][q].low <= 1.5) return false;
  }
  return true;
}
function abPass(summary) {
  for (const metric of ['wall', 'cpu']) for (const q of ['p50', 'p95']) {
    if (summary[metric][q].high > 1 + BAND) return false;
  }
  return true;
}

const result = {
  schema: 1,
  preregistrationComment: 5652066831,
  exact: { base: BASE_SHA, candidate: CANDIDATE_SHA },
  environment: { node: process.version, platform: process.platform, arch: process.arch, pinCpu },
  protocol: { seed: SEED, bootstrapIterations: BOOTSTRAP_ITERS, nullClusters: NULL_CLUSTERS, positiveClusters: POSITIVE_CLUSTERS, abClusters: AB_CLUSTERS, band: BAND },
  artifacts: { baseEntrySha256: sha256(baseEntry), candidateEntrySha256: sha256(candidateEntry), childSha256: sha256(childPath) },
  profiles: {},
};

let seedOffset = 0;
for (const profile of profiles) {
  const baseNullRaw = runClusters(profile, baseEntry, baseEntry, NULL_CLUSTERS);
  const baseNull = summarizeClusters(baseNullRaw, seedOffset += 101);
  const candidateNullRaw = runClusters(profile, candidateEntry, candidateEntry, NULL_CLUSTERS);
  const candidateNull = summarizeClusters(candidateNullRaw, seedOffset += 101);
  const positiveRaw = runClusters(profile, baseEntry, baseEntry, POSITIVE_CLUSTERS, 1, 2);
  const positive = summarizeClusters(positiveRaw, seedOffset += 101);
  const calibrationPass = nullPass(baseNull) && nullPass(candidateNull) && positivePass(positive);
  let abRaw = [];
  let ab = null;
  if (calibrationPass) {
    abRaw = runClusters(profile, baseEntry, candidateEntry, AB_CLUSTERS);
    ab = summarizeClusters(abRaw, seedOffset += 101);
  }
  result.profiles[profile.id] = {
    profile,
    calibrationPass,
    baseNull,
    candidateNull,
    positive,
    ab,
    abPass: ab ? abPass(ab) : false,
    raw: { baseNull: baseNullRaw, candidateNull: candidateNullRaw, positive: positiveRaw, ab: abRaw },
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2));
}

const sampleIds = {
  3: ['sample-n3-linear', 'sample-n3-quadratic'],
  1025: ['sample-n1025-linear', 'sample-n1025-quadratic'],
};
const combined = {};
let allSeekCalibrated = true;
let allExplicitPass = true;
let allDefaultPass = true;
for (const n of [3, 1025]) {
  const samplerProfiles = sampleIds[n].map((id) => result.profiles[id]);
  const matched = result.profiles[`seek-matched-n${n}`];
  const calibrated = samplerProfiles.every((x) => x.calibrationPass) && matched.calibrationPass;
  allSeekCalibrated &&= calibrated;
  if (!calibrated) {
    combined[n] = { calibrated: false };
    continue;
  }
  allExplicitPass &&= samplerProfiles.every((x) => x.abPass);
  const bounds = { calibrated: true, wall: {}, cpu: {} };
  for (const metric of ['wall', 'cpu']) for (const q of ['p50', 'p95']) {
    const samplerUpper = Math.max(...samplerProfiles.map((x) => x.ab[metric][q].high));
    const matchedUpper = matched.ab[metric][q].high;
    const conservativeUpper = matchedUpper * Math.max(1, samplerUpper);
    bounds[metric][q] = { samplerUpper, matchedUpper, conservativeUpper, pass: conservativeUpper <= 1 + BAND };
    allDefaultPass &&= conservativeUpper <= 1 + BAND;
  }
  combined[n] = bounds;
}
result.combinedDefaultSeek = combined;
result.verdict = !allSeekCalibrated
  ? 'UNPROVEN-CALIBRATION'
  : (!allExplicitPass || !allDefaultPass)
    ? 'NO-GO-SEEK'
    : 'GO-SEEK';
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({ verdict: result.verdict, combinedDefaultSeek: result.combinedDefaultSeek, summaries: Object.fromEntries(Object.entries(result.profiles).map(([id, x]) => [id, { calibrationPass: x.calibrationPass, baseNull: x.baseNull, candidateNull: x.candidateNull, positive: x.positive, ab: x.ab, abPass: x.abPass }])) }, null, 2));
if (result.verdict === 'NO-GO-SEEK') process.exitCode = 3;
if (result.verdict === 'UNPROVEN-CALIBRATION') process.exitCode = 2;
