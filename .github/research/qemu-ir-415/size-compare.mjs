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
const failures = [];
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
    failures.push({ axis: 'shipped-entry', label, reason: 'missing-or-error', base: b ?? null, candidate: c ?? null });
    continue;
  }
  const metric = {
    label,
    base: { raw: b.rawBytes, gzip: b.gzBytes, brotli: b.brBytes },
    candidate: { raw: c.rawBytes, gzip: c.gzBytes, brotli: c.brBytes },
    delta: { raw: c.rawBytes - b.rawBytes, gzip: c.gzBytes - b.gzBytes, brotli: c.brBytes - b.brBytes },
  };
  shipped.push(metric);
  for (const key of ['raw', 'gzip', 'brotli']) {
    if (metric.candidate[key] > metric.base[key]) failures.push({ axis: 'shipped-entry', label, metric: key, ...metric });
  }
}

function walkCjs(root) {
  const out = [];
  const dist = join(root, 'dist');
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (name.endsWith('.cjs')) out.push(relative(root, abs).replaceAll('\\\\', '/'));
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
  const b = {
    raw: bBytes.length,
    gzip: baseCompression.canonicalGzip(bBytes).length,
    brotli: baseCompression.observationalBrotli(bBytes).length,
  };
  const c = {
    raw: cBytes.length,
    gzip: candCompression.canonicalGzip(cBytes).length,
    brotli: candCompression.observationalBrotli(cBytes).length,
  };
  const row = { path, base: b, candidate: c, delta: { raw: c.raw - b.raw, gzip: c.gzip - b.gzip, brotli: c.brotli - b.brotli } };
  cjs.push(row);
  for (const key of ['raw', 'gzip', 'brotli']) {
    if (c[key] > b[key]) failures.push({ axis: 'cjs-file', path, metric: key, ...row });
  }
}

function parseScenarios(text) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const primary = line.match(/^(.+?)\s+(\d+) B gz\s+(\d+) B br(?:\s|$)/);
    if (!primary) continue;
    const name = primary[1].trim();
    if (!name || name.startsWith('SUM ')) continue;
    const lazy = line.match(/lazy (\d+) B gz\/(\d+) B br .*? total (\d+) B gz\/(\d+) B br/);
    rows.set(name, {
      gzip: Number(primary[2]),
      brotli: Number(primary[3]),
      totalGzip: lazy ? Number(lazy[5]) : Number(primary[2]),
      totalBrotli: lazy ? Number(lazy[6]) : Number(primary[3]),
    });
  }
  return rows;
}

const baseScenarioText = readFileSync(join(baseRoot, 'size-gate-output.txt'), 'utf8');
const candScenarioText = readFileSync(join(candidateRoot, 'size-gate-output.txt'), 'utf8');
const baseScenarios = parseScenarios(baseScenarioText);
const candScenarios = parseScenarios(candScenarioText);
const baseScenarioNames = [...baseScenarios.keys()].sort();
const candScenarioNames = [...candScenarios.keys()].sort();
if (baseScenarioNames.length === 0 || JSON.stringify(baseScenarioNames) !== JSON.stringify(candScenarioNames)) {
  failures.push({ axis: 'import-scenarios', reason: 'scenario-set-mismatch-or-empty', base: baseScenarioNames, candidate: candScenarioNames });
}

const scenarios = [];
for (const name of baseScenarioNames) {
  const b = baseScenarios.get(name);
  const c = candScenarios.get(name);
  if (!b || !c) continue;
  const row = {
    name,
    base: b,
    candidate: c,
    delta: {
      gzip: c.gzip - b.gzip,
      brotli: c.brotli - b.brotli,
      totalGzip: c.totalGzip - b.totalGzip,
      totalBrotli: c.totalBrotli - b.totalBrotli,
    },
  };
  scenarios.push(row);
  for (const key of ['gzip', 'brotli', 'totalGzip', 'totalBrotli']) {
    if (c[key] > b[key]) failures.push({ axis: 'import-scenario', name, metric: key, ...row });
  }
}

const verdict = failures.length === 0 ? 'ADMITTED_SIZE_PARETO' : 'NO_GO_SIZE_PARETO';
const result = {
  verdict,
  base: 'fe11daa407de396fad952be7679650f63dabd4dd',
  candidate: 'df7aaced646116f34135083dbfbf62ee40265657',
  shipped,
  cjs,
  scenarios,
  failures,
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
