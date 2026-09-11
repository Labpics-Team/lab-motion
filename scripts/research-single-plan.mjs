// Временный воспроизводимый носитель одной итерации #232, не постоянный timing gate.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseAstAsync } from 'vite';
import { canonicalGzip, observationalBrotli } from './compression-oracle.mjs';
import { deriveEntriesFromExports, measureEntries, IMPORT_COST_SCENARIOS, measureScenario } from './size-gate.mjs';

const BASE = '80264dc5fa94a7213f4529d89a5159dd53d06bb3';
const root = process.cwd();
const output = join(root, 'single-plan-evidence');
mkdirSync(output, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = {
  base: BASE, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  environment: { node: process.version, versions: process.versions, executable: hash(readFileSync(process.execPath)),
    os: release(), cpu: cpus()[0]?.model, cores: cpus().length,
    runnerImage: process.env.ImageVersion, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    package: hash(readFileSync('package.json')), lock: hash(readFileSync('pnpm-lock.yaml')) },
  commands: [], entries: {}, consumers: {}, fileChanges: [], differential: {}, timings: [],
};
const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
function command(label, cwd, file, args) {
  const start = performance.now();
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(output, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  report.commands.push({ label, command: [file, ...args], status: result.status, ms: performance.now() - start });
  save();
  assert.ifError(result.error);
  assert.equal(result.status, 0, label + ': см. сохранённый лог');
}
function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    return entry.isDirectory() ? listFiles(join(dir, entry.name), path + '/') : [path];
  }).sort();
}
const bytes = (buffer) => ({ raw: buffer.length, gzip: canonicalGzip(buffer).length,
  brotli: observationalBrotli(buffer).length, sha256: hash(buffer) });
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function summarize(pairs) {
  const ratios = pairs.map((p) => p.candidateMs / p.baseMs);
  let seed = 0x5eed232;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const boot = Array.from({ length: 5000 }, () => median(ratios.map(() => ratios[Math.floor(random() * ratios.length)]))).sort((a, b) => a - b);
  return { medianRatio: median(ratios), ratio95: [boot[125], boot[4874]],
    baseMedianMs: median(pairs.map((p) => p.baseMs)), candidateMedianMs: median(pairs.map((p) => p.candidateMs)) };
}
let sink = 0;
function elapsed(fn, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) sink = (sink + fn()) | 0;
  return performance.now() - start;
}
function paired(name, a, b) {
  for (let i = 0; i < 50; i++) { a(); b(); }
  let iterations = 1;
  while (iterations < 262144) {
    const t = Math.min(elapsed(a, iterations), elapsed(b, iterations));
    if (t >= 12) break;
    iterations *= 2;
  }
  const pairs = [];
  for (let block = 0; block < 32; block++) {
    const order = block % 2 === 0 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B'];
    const observations = order.map((participant) => ({ participant, ms: elapsed(participant === 'A' ? a : b, iterations) }));
    const mean = (who) => observations.filter((o) => o.participant === who).reduce((sum, o) => sum + o.ms, 0) / 2;
    pairs.push({ block, observations, baseMs: mean('A'), candidateMs: mean('B') });
  }
  const measurement = { name, iterations, unit: 'milliseconds per equal-sized transform batch', pairs, ...summarize(pairs) };
  report.timings.push(measurement);
  save();
  console.log('TIMING', name, JSON.stringify({ iterations, medianRatio: measurement.medianRatio, ratio95: measurement.ratio95 }));
  return measurement;
}

let baseDir;
try {
  baseDir = join(mkdtempSync(join(tmpdir(), 'single-plan-')), 'base');
  execFileSync('git', ['worktree', 'add', '--detach', baseDir, BASE], { cwd: root, stdio: 'pipe' });
  symlinkSync(join(root, 'node_modules'), join(baseDir, 'node_modules'), 'dir');
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsup.config.ts', 'scripts/size-gate.mjs', 'scripts/compression-oracle.mjs']) {
    assert.deepEqual(readFileSync(join(baseDir, file)), readFileSync(join(root, file)), 'неодинаковая методология: ' + file);
  }
  for (const [name, dir] of [['base', baseDir], ['candidate', root]]) {
    command(name + '-build', dir, 'pnpm', ['build']);
    command(name + '-size-gate', dir, 'pnpm', ['size']);
    const entries = measureEntries(deriveEntriesFromExports(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))), dir);
    assert.equal(entries.hasWarnings, false);
    report.entries[name] = entries;
    report.consumers[name] = [];
    for (const scenario of IMPORT_COST_SCENARIOS) {
      const measured = await measureScenario(scenario, join(dir, 'dist/index.js'));
      assert.equal(measured.error, undefined);
      report.consumers[name].push(measured);
    }
    save();
  }
  const files = listFiles(join(baseDir, 'dist'));
  assert.deepEqual(listFiles(join(root, 'dist')), files);
  report.distFileCount = files.length;
  for (const file of files) {
    const a = readFileSync(join(baseDir, 'dist', file));
    const b = readFileSync(join(root, 'dist', file));
    if (!a.equals(b)) report.fileChanges.push({ file, base: bytes(a), candidate: bytes(b) });
  }
  save();
  assert.deepEqual(report.fileChanges.map((c) => c.file), ['compiler/vite/index.cjs', 'compiler/vite/index.js']);
  for (const change of report.fileChanges) for (const key of ['raw', 'gzip', 'brotli']) {
    assert.ok(change.candidate[key] <= change.base[key], 'byte regression: ' + change.file + ':' + key);
  }
  for (let i = 0; i < report.entries.base.rows.length; i++) {
    const a = report.entries.base.rows[i], b = report.entries.candidate.rows[i];
    assert.equal(a.label, b.label);
    for (const key of ['rawBytes', 'gzBytes', 'brBytes', 'entryRawBytes', 'entryGzBytes', 'entryBrBytes', 'closureFiles']) {
      assert.ok(b[key] <= a[key], 'entry regression: ' + a.label + ':' + key);
    }
  }
  assert.deepEqual(report.consumers.candidate, report.consumers.base, 'consumer vector changed');
  console.log('BYTES', JSON.stringify(report.fileChanges));
  console.log('UNCHANGED', JSON.stringify({ distFiles: files.length - 2, consumers: report.consumers.base.length }));

  const baseline = (await import(pathToFileURL(join(baseDir, 'dist/compiler/vite/index.js')).href)).motionCompiler();
  const candidate = (await import(pathToFileURL(join(root, 'dist/compiler/vite/index.js')).href)).motionCompiler();
  const NANO = '@labpics/motion/nano', SURFACE = '@labpics/motion/animate';
  const moduleOf = (source, body) => `import { animate } from '${source}';\n` + body;
  const bodies = [
    'animate(card, { opacity: 1 });',
    'animate(card, { opacity: -0 });',
    'animate((sideEffect(), card), { opacity: 0.5 });',
    'animate(animate(card, { opacity: 0.5 }), { opacity: 1 });',
    'animate(\n card,\n { opacity: 1 }\n);\nconst after = 42;',
    'animate(card, { opacity: dynamic });',
    'animate(card, { get opacity() { return 1; } });',
    'animate(card, { ...props, opacity: 1 });',
    'animate?.(card, { opacity: 1 });',
    'animate(card, { width: [100, 200] }, { layout: "project" });',
    'return animate(card, { width: [100, 200] }, { layout: "project" });',
  ];
  const corpus = [];
  for (const source of [NANO, SURFACE]) for (const body of bodies) {
    for (const wrapper of [(b) => `function render() { ${b} }`, (b) => `function render(animate) { ${b} }`,
      (b) => `function render() { const animate = other; ${b} }`, (b) => `const __labMotionNanoCompiled = 1; function render() { ${b} }`]) {
      for (const newline of ['\n', '\r\n']) corpus.push(moduleOf(source, wrapper(body)).replaceAll('\n', newline));
    }
  }
  for (const [nano, surface] of [['animate', 'surface'], ['nano', 'animate'], ['nano', 'surface']]) {
    for (const reverse of [false, true]) for (const body of bodies) {
      const imports = [`import { animate as ${nano} } from '${NANO}';`, `import { animate as ${surface} } from '${SURFACE}';`];
      if (reverse) imports.reverse();
      corpus.push(imports.join('\n') + '\nfunction render() { ' + body + ' }');
    }
  }
  for (const source of [NANO, SURFACE]) for (const specifier of ['* as motion', '{ animate as alias }', 'animate']) {
    corpus.push(`import ${specifier} from '${source}';\nfunction render(){ animate(card, {opacity:1}); }`);
  }
  corpus.push('export const ordinary = 1;', `// ${NANO}\nconst text = "animate(card,{opacity:1})";`);
  corpus.push(moduleOf(NANO, 'const смайлик = "🙂";\nanimate(смайлик, {opacity: 0.25});'));
  let transformed = 0, declined = 0;
  function apply(plugin, ast, code, id = '/app/module.js') {
    const warnings = [];
    const result = plugin.transform.call({ parse: () => ast, warn: (message) => warnings.push(message) }, code, id);
    return { result, warnings };
  }
  for (const code of corpus) {
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8', timeout: 5000 });
    assert.ifError(syntax.error);
    assert.equal(syntax.status, 0, syntax.stderr + '\n' + code);
    const ast = await parseAstAsync(code);
    const a = apply(baseline, ast, code), b = apply(candidate, ast, code);
    assert.deepEqual(b, a, 'code/map/diagnostic differential:\n' + code);
    if (a.result) transformed++; else declined++;
    assert.deepEqual(apply(candidate, ast, code, '\0virtual'), apply(baseline, ast, code, '\0virtual'));
  }
  report.differential = { inputs: corpus.length, transformed, declined, mismatches: 0, oracle: 'immutable built baseline; complete code/map/warnings',
    corpusSha256: hash(JSON.stringify(corpus)), independentSyntax: 'Node --input-type=module --check for every input' };
  const probeCode = moduleOf(NANO, 'animate(card,{opacity:1});');
  const probeAst = await parseAstAsync(probeCode);
  const a = apply(baseline, probeAst, probeCode);
  assert.ok(a.result);
  const mutated = structuredClone(a);
  mutated.result.map.mappings += ';';
  assert.throws(() => assert.deepEqual(mutated, a));
  report.differential.mutatedMapDetected = true;
  report.differential.traversals = {};
  for (const [name, plugin] of [['base', baseline], ['candidate', candidate]]) {
    let reads = 0;
    const observed = { ...probeAst, get body() { reads++; return probeAst.body; } };
    assert.ok(apply(plugin, observed, probeCode).result);
    report.differential.traversals[name] = reads;
  }
  assert.deepEqual(report.differential.traversals, { base: 3, candidate: 2 });
  writeFileSync(join(output, 'corpus.json'), JSON.stringify(corpus));
  save();
  console.log('DIFFERENTIAL', JSON.stringify(report.differential));

  const many = (count) => Array.from({ length: count }, (_, i) => `animate(card${i}, {opacity:${(i % 7) / 7}});`).join('\n');
  const cases = [
    ['nano-1', moduleOf(NANO, many(1))], ['nano-8', moduleOf(NANO, many(8))],
    ['nano-128', moduleOf(NANO, many(128))],
    ['nano-8-plus-unrelated-128', moduleOf(NANO, many(8) + '\n' + Array.from({length:128}, (_,i) => `const value${i} = {x:${i}, y:${i+1}};`).join('\n'))],
    ['nano-dynamic-refusal', moduleOf(NANO, 'animate(card,{opacity:dynamic});')],
    ['surface-1', moduleOf(SURFACE, 'animate(card, {width:[100,200]}, {layout:"project"});')],
    ['mixed-nano', moduleOf(NANO, `import {animate as surface} from '${SURFACE}';\n` + many(8))],
    ['mixed-surface', moduleOf(SURFACE, `import {animate as nano} from '${NANO}';\nanimate(card,{width:[100,200]},{layout:"project"});`)],
    ['no-import-control', 'export const ordinary = 1;'],
  ];
  let primaryA;
  for (const [name, code] of cases) {
    const ast = await parseAstAsync(code);
    const context = { parse: () => ast, warn: (message) => { throw new Error(message); } };
    const fn = (plugin) => () => { const result = plugin.transform.call(context, code, '/app/bench.js'); return result ? result.code.length + result.map.mappings.length : 1; };
    const a = fn(baseline), b = fn(candidate);
    assert.equal(a(), b());
    paired(name, a, b);
    if (name === 'nano-8') primaryA = a;
  }
  const unchanged = paired('A-A-negative-control', primaryA, primaryA);
  const slow = paired('double-transform-positive-control', primaryA, () => primaryA() + primaryA());
  assert.ok(slow.ratio95[0] > 1.5, 'positive control failed');
  report.controls = { unchangedRatio95: unchanged.ratio95, doubleWorkRatio95: slow.ratio95 };
  report.sink = sink;
  report.completed = true;
  save();
  console.log('PROOF_COMPLETE', JSON.stringify({ head: report.head, base: report.base, entries: report.entries.base.rows.length, consumers: report.consumers.base.length }));
} catch (error) {
  report.failure = { message: String(error), stack: error?.stack };
  save();
  console.error(error);
  process.exitCode = 1;
} finally {
  if (baseDir) spawnSync('git', ['worktree', 'remove', '--force', baseDir], { cwd: root });
}
