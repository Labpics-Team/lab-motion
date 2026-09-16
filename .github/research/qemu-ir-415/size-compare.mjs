import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [baseRoot, candidateRoot, resultPath] = process.argv.slice(2);
if (!baseRoot || !candidateRoot || !resultPath) {
  throw new Error('usage: size-compare.mjs <base-root> <candidate-root> <result-json>');
}

const baseSize = await import(pathToFileURL(join(baseRoot, 'scripts/size-gate.mjs')));
const candSize = await import(pathToFileURL(join(candidateRoot, 'scripts/size-gate.mjs')));
const baseCompression = await import(pathToFileURL(join(baseRoot, 'scripts/compression-oracle.mjs')));
const candCompression = await import(pathToFileURL(join(candidateRoot, 'scripts/compression-oracle.mjs')));

const BASE_SHA = 'fe11daa407de396fad952be7679650f63dabd4dd';
const CANDIDATE_SHA = 'df7aaced646116f34135083dbfbf62ee40265657';
const failures = [];

function triplet(raw, gzip, brotli) {
  return { raw, gzip, brotli };
}

function compareTriplet(axis, id, base, candidate, sink = failures) {
  const delta = {
    raw: candidate.raw - base.raw,
    gzip: candidate.gzip - base.gzip,
    brotli: candidate.brotli - base.brotli,
  };
  for (const metric of ['raw', 'gzip', 'brotli']) {
    if (candidate[metric] > base[metric]) {
      sink.push({ axis, id, metric, base: base[metric], candidate: candidate[metric], delta: delta[metric] });
    }
  }
  return delta;
}

// Evaluator calibration is part of the preregistered proof. A null pair must be
// admitted, while an injected +1 B regression must be rejected independently
// for raw, canonical gzip and observational Brotli.
const calibrationBase = triplet(101, 79, 71);
const nullFailures = [];
compareTriplet('control-null', 'synthetic', calibrationBase, { ...calibrationBase }, nullFailures);
if (nullFailures.length !== 0) throw new Error('null calibration rejected an identical pair');
const sensitivity = {};
for (const metric of ['raw', 'gzip', 'brotli']) {
  const mutated = { ...calibrationBase, [metric]: calibrationBase[metric] + 1 };
  const controlFailures = [];
  compareTriplet('control-plus-one', metric, calibrationBase, mutated, controlFailures);
  sensitivity[metric] = controlFailures.length === 1 && controlFailures[0].metric === metric;
  if (!sensitivity[metric]) throw new Error(`+1 B sensitivity control did not fire for ${metric}`);
}

const basePkg = JSON.parse(readFileSync(join(baseRoot, 'package.json'), 'utf8'));
const candPkg = JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf8'));
const baseEntries = baseSize.deriveEntriesFromExports(basePkg);
const candEntries = candSize.deriveEntriesFromExports(candPkg);
const baseRows = baseSize.measureEntries(baseEntries, baseRoot).rows;
const candRows = candSize.measureEntries(candEntries, candidateRoot).rows;

function indexRows(rows) {
  return new Map(rows.map((row) => [row.label, row]));
}

const baseByLabel = indexRows(baseRows);
const candByLabel = indexRows(candRows);
const shipped = [];
const baseLabels = [...baseByLabel.keys()].sort();
const candLabels = [...candByLabel.keys()].sort();
if (JSON.stringify(baseLabels) !== JSON.stringify(candLabels)) {
  failures.push({ axis: 'shipped-entries', reason: 'entry-set-mismatch', baseLabels, candLabels });
}
for (const label of baseLabels) {
  const b = baseByLabel.get(label);
  const c = candByLabel.get(label);
  if (!b || !c || b.error || c.error) {
    failures.push({ axis: 'shipped-entry', id: label, reason: 'missing-or-error', base: b ?? null, candidate: c ?? null });
    continue;
  }
  const base = triplet(b.rawBytes, b.gzBytes, b.brBytes);
  const candidate = triplet(c.rawBytes, c.gzBytes, c.brBytes);
  shipped.push({ label, base, candidate, delta: compareTriplet('shipped-entry', label, base, candidate) });
}

// CJS is a first-class installed surface as well. Compare every built .cjs
// artifact, not only the root entry, so a local win cannot hide a sibling loss.
function walkCjs(root) {
  const out = [];
  const dist = join(root, 'dist');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (name.endsWith('.cjs')) out.push(relative(root, abs).replaceAll('\\', '/'));
    }
  };
  walk(dist);
  return out.sort();
}

const baseCjs = walkCjs(baseRoot);
const candCjs = walkCjs(candidateRoot);
if (JSON.stringify(baseCjs) !== JSON.stringify(candCjs)) {
  failures.push({ axis: 'cjs-files', reason: 'file-set-mismatch', base: baseCjs, candidate: candCjs });
}
const cjs = [];
for (const path of baseCjs) {
  if (!candCjs.includes(path)) continue;
  const bBytes = readFileSync(join(baseRoot, path));
  const cBytes = readFileSync(join(candidateRoot, path));
  const base = triplet(
    bBytes.length,
    baseCompression.canonicalGzip(bBytes).length,
    baseCompression.observationalBrotli(bBytes).length,
  );
  const candidate = triplet(
    cBytes.length,
    candCompression.canonicalGzip(cBytes).length,
    candCompression.observationalBrotli(cBytes).length,
  );
  cjs.push({ path, base, candidate, delta: compareTriplet('cjs-file', path, base, candidate) });
}

// The official consumer matrix is the SSOT exported by size-gate itself. Run
// it directly instead of parsing CLI text so raw/gzip/Brotli and split totals
// are all compared under exactly the production measurement implementation.
function scenarioDescriptor(scenario) {
  return {
    name: scenario.name,
    code: scenario.code,
    gate: scenario.gate,
    totalGate: scenario.totalGate ?? scenario.gate,
  };
}
const baseScenarioDescriptors = baseSize.IMPORT_COST_SCENARIOS.map(scenarioDescriptor);
const candScenarioDescriptors = candSize.IMPORT_COST_SCENARIOS.map(scenarioDescriptor);
if (JSON.stringify(baseScenarioDescriptors) !== JSON.stringify(candScenarioDescriptors)) {
  failures.push({
    axis: 'import-scenarios',
    reason: 'scenario-contract-mismatch',
    base: baseScenarioDescriptors,
    candidate: candScenarioDescriptors,
  });
}

const baseScenarioRows = await Promise.all(
  baseSize.IMPORT_COST_SCENARIOS.map((scenario) =>
    baseSize.measureScenario(scenario, join(baseRoot, 'dist/index.js'))),
);
const candScenarioRows = await Promise.all(
  candSize.IMPORT_COST_SCENARIOS.map((scenario) =>
    candSize.measureScenario(scenario, join(candidateRoot, 'dist/index.js'))),
);
const candScenarioByName = new Map(candScenarioRows.map((row) => [row.name, row]));
const scenarios = [];
for (const b of baseScenarioRows) {
  const c = candScenarioByName.get(b.name);
  if (!c || b.error || c.error) {
    failures.push({ axis: 'import-scenario', id: b.name, reason: 'missing-or-error', base: b ?? null, candidate: c ?? null });
    continue;
  }
  const initialBase = triplet(b.rawBytes, b.gzBytes, b.brBytes);
  const initialCandidate = triplet(c.rawBytes, c.gzBytes, c.brBytes);
  const lazyBase = triplet(b.lazyRawBytes, b.lazyGzBytes, b.lazyBrBytes);
  const lazyCandidate = triplet(c.lazyRawBytes, c.lazyGzBytes, c.lazyBrBytes);
  const totalBase = triplet(b.totalRawBytes, b.totalGzBytes, b.totalBrBytes);
  const totalCandidate = triplet(c.totalRawBytes, c.totalGzBytes, c.totalBrBytes);
  scenarios.push({
    name: b.name,
    initial: {
      base: initialBase,
      candidate: initialCandidate,
      delta: compareTriplet('import-scenario-initial', b.name, initialBase, initialCandidate),
    },
    lazy: {
      base: lazyBase,
      candidate: lazyCandidate,
      delta: compareTriplet('import-scenario-lazy', b.name, lazyBase, lazyCandidate),
    },
    total: {
      base: totalBase,
      candidate: totalCandidate,
      delta: compareTriplet('import-scenario-total', b.name, totalBase, totalCandidate),
    },
  });
}
if (baseScenarioRows.length === 0 || baseScenarioRows.length !== candScenarioRows.length) {
  failures.push({
    axis: 'import-scenarios',
    reason: 'scenario-set-empty-or-length-mismatch',
    baseCount: baseScenarioRows.length,
    candidateCount: candScenarioRows.length,
  });
}

const verdict = failures.length === 0 ? 'ADMITTED_SIZE_PARETO' : 'NO_GO_SIZE_PARETO';
const result = {
  verdict,
  base: BASE_SHA,
  candidate: CANDIDATE_SHA,
  controls: {
    nullPairAdmitted: true,
    plusOneRejected: sensitivity,
  },
  shipped,
  cjs,
  scenarios,
  failures,
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 2;
