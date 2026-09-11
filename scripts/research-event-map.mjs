import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { parseAstAsync } from 'vite';
import { canonicalGzip, observationalBrotli } from './compression-oracle.mjs';

const candidateRoot = process.cwd();
const baseRoot = resolve(process.argv[2]);
const baseSha = 'ecfa6beb90bb116b47f1641d8edbeac0b2d9bb9f';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git(baseRoot, 'rev-parse', 'HEAD'), baseSha);
for (const path of ['package.json', 'pnpm-lock.yaml', 'tsup.config.ts', 'scripts/compression-oracle.mjs', 'scripts/compression-policy.mjs']) {
  assert.deepEqual(readFileSync(join(baseRoot, path)), readFileSync(join(candidateRoot, path)), path);
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
mkdirSync('reports/event-map', { recursive: true });
const report = {
  baseSha, candidateSha: git(candidateRoot, 'rev-parse', 'HEAD'),
  environment: { node: process.version, versions: process.versions, nodeSha256: hash(readFileSync(process.execPath)), platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, totalMemory: os.totalmem(), load: os.loadavg() },
  scope: 'same-host canonical builds, full plugin transform on pre-parsed AST; not browser/whole-project speed',
};
const save = () => writeFileSync('reports/event-map/result.json', JSON.stringify(report, null, 2));
const files = (root, prefix = '') => readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(root, join(prefix, entry.name)) : [join(prefix, entry.name)]).sort();
const baseFiles = files(join(baseRoot, 'dist'));
assert.deepEqual(baseFiles, files(join(candidateRoot, 'dist')));
const sizes = (bytes) => ({ raw: bytes.length, gzip: canonicalGzip(bytes).length, brotli: observationalBrotli(bytes).length });
report.changedFiles = [];
report.identicalFiles = 0;
report.sizeRegressions = [];
for (const file of baseFiles) {
  const a = readFileSync(join(baseRoot, 'dist', file));
  const b = readFileSync(join(candidateRoot, 'dist', file));
  if (a.equals(b)) { report.identicalFiles++; continue; }
  const entry = { file, base: sizes(a), candidate: sizes(b), baseSha256: hash(a), candidateSha256: hash(b) };
  report.changedFiles.push(entry);
  for (const metric of ['raw', 'gzip', 'brotli']) if (entry.candidate[metric] > entry.base[metric]) report.sizeRegressions.push({ file, metric, base: entry.base[metric], candidate: entry.candidate[metric] });
  assert.ok(['compiler/vite/index.js', 'compiler/vite/index.cjs'].includes(file), `unexpected dist delta ${file}`);
}
save();
console.log('SIZE', JSON.stringify(report.changedFiles));
assert.equal(report.sizeRegressions.length, 0, 'strict byte Pareto');

const { motionCompiler: before } = await import(pathToFileURL(join(baseRoot, 'dist/compiler/vite/index.js')));
const { motionCompiler: after } = await import(pathToFileURL(join(candidateRoot, 'dist/compiler/vite/index.js')));
const aPlugin = before(), bPlugin = after();
let seed = 0x721942;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const gaps = ['', ' ', '\t', '\n', '\r\n', '\n\n', '\n \n'];
const gap = () => gaps[Math.floor(random() * gaps.length)];
const header = `import { animate } from '@labpics/motion/nano';\n`;
report.differential = { cases: 0, lowered: 0, unchanged: 0, differences: 0 };
for (let index = 0; index < 2048; index++) {
  const call = (target) => `animate${gap()}(${gap()}${target}${gap()},${gap()}{ opacity: 0.5 }${gap()})`;
  const target = index % 2 ? 'el' : call('el');
  let code = `/* 😀 е́ */${gap()}${header}${gap()}const text='😀';${gap()}${call(target)};${gap()}${call('other')};${gap()}`;
  if (index % 8 === 0) code = header + `animate(el, { opacity: level });`;
  if (index % 8 === 1) code = header + `{ const animate = fake; ${call('el')}; }`;
  if (index % 8 === 2) code = `import { animate as go } from '@labpics/motion/nano'; go(el,{opacity:1});`;
  if (index % 8 === 3) code = `import { animate } from '@labpics/motion/animate';${gap()}animate(${gap()}el,${gap()}{width:[100,200]},${gap()}{layout:'project'}${gap()});`;
  const ast = await parseAstAsync(code);
  const warnings = [[], []];
  const ctx = (side) => ({ parse: () => ast, warn: (message) => warnings[side].push(message) });
  const a = aPlugin.transform.call(ctx(0), code, '/src/карта-😀.js');
  const b = bPlugin.transform.call(ctx(1), code, '/src/карта-😀.js');
  assert.deepEqual(b, a, `differential case ${index}`);
  assert.deepEqual(warnings[1], warnings[0]);
  report.differential.cases++;
  report.differential[a === undefined ? 'unchanged' : 'lowered']++;
}
save();
console.log('SEMANTICS', JSON.stringify(report.differential));

const sources = {
  nano1: header + `animate(el,{opacity:1});`,
  nano8: header + Array.from({ length: 8 }, (_, i) => `animate(els[${i}],{opacity:0.5});`).join('\n'),
  nano128: header + Array.from({ length: 128 }, (_, i) => `animate(els[${i}],{opacity:0.5});`).join('\n'),
  lines1000: header + Array.from({ length: 1000 }, (_, i) => `const property${i}=${i};`).join('\n') + `\nanimate(el,{opacity:1});`,
  template64k: header + `const template=${JSON.stringify('a'.repeat(65536))};\nanimate(el,{opacity:1});`,
  surface1: `import { animate } from '@labpics/motion/animate';\nanimate(el,{width:[100,200]},{layout:'project'});`,
  dynamic: header + `animate(el,{opacity:level});`,
  noImport: `export const value=42;`,
};
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2; };
function summarize(blocks) {
  const ratios = blocks.map(({ a, b }) => b / a);
  let r = 0x629d41;
  const rand = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const boots = Array.from({ length: 4096 }, () => median(ratios.map(() => ratios[Math.floor(rand() * ratios.length)]))).sort((a, b) => a - b);
  return { medianRatio: median(ratios), ci95: [boots[102], boots[3993]], baseMedianNs: median(blocks.map((x) => x.a)), candidateMedianNs: median(blocks.map((x) => x.b)), blocks };
}
let sink = 0;
function paired(a, b, iterations = 128) {
  for (let i = 0; i < 512; i++) { a(); b(); }
  const run = (fn) => { const start = process.hrtime.bigint(); for (let i = 0; i < iterations; i++) { const result = fn(); sink ^= (result?.code.length ?? 0) + (result?.map.mappings.length ?? 0); } return Number(process.hrtime.bigint() - start) / iterations; };
  const blocks = [];
  for (let block = 0; block < 32; block++) {
    const reversed = block % 2 === 1;
    const raw = (reversed ? [b, a, a, b] : [a, b, b, a]).map(run);
    blocks.push({ order: reversed ? 'BAAB' : 'ABBA', rawNs: raw, a: reversed ? (raw[1] + raw[2]) / 2 : (raw[0] + raw[3]) / 2, b: reversed ? (raw[0] + raw[3]) / 2 : (raw[1] + raw[2]) / 2 });
  }
  return summarize(blocks);
}
report.timing = {};
for (const [name, code] of Object.entries(sources)) {
  const ast = await parseAstAsync(code);
  const ctx = { parse: () => ast, warn: (message) => { throw new Error(message); } };
  const a = () => aPlugin.transform.call(ctx, code, '/app.js');
  const b = () => bPlugin.transform.call(ctx, code, '/app.js');
  assert.deepEqual(b(), a());
  report.timing[name] = paired(a, b, name === 'surface1' ? 32 : 256);
  console.log('TIMING', name, JSON.stringify({ median: report.timing[name].medianRatio, ci95: report.timing[name].ci95 }));
  if (name === 'nano8') {
    report.controls = { unchanged: paired(a, a, 256), doubleWork: paired(a, () => { a(); return a(); }, 256) };
    console.log('CONTROLS', JSON.stringify({ unchanged: report.controls.unchanged.ci95, doubleWork: report.controls.doubleWork.ci95 }));
    assert.ok(report.controls.doubleWork.ci95[0] > 1.5);
  }
  save();
}

// Запуск нового oracle против реальных ошибок production, затем точное восстановление.
const sourcePath = 'src/compiler/vite/index.ts';
const original = readFileSync(sourcePath, 'utf8');
report.mutations = [];
for (const [name, from, to] of [
  ['source-column-reset', 'originalColumn = 0;\n      from = lineEnd + 1;', 'originalColumn = 1;\n      from = lineEnd + 1;'],
  ['removed-newline-leaks', "if (keep) {\n        mappings += ';';", "if (true) {\n        mappings += ';';"],
  ['generated-column-reset', 'previousGenColumn = 0;\n      }', 'previousGenColumn = 1;\n      }'],
]) {
  assert.ok(original.includes(from), `mutation target missing ${name}`);
  let run;
  try {
    writeFileSync(sourcePath, original.replace(from, to));
    run = spawnSync('pnpm', ['exec', 'vitest', 'run', 'test/compiler-source-map.test.ts'], { encoding: 'utf8', timeout: 60000 });
  } finally { writeFileSync(sourcePath, original); }
  writeFileSync(`reports/event-map/mutation-${name}.log`, (run.stdout ?? '') + (run.stderr ?? ''));
  assert.equal(run.status, 1, `mutation ${name} must be assertion RED`);
  assert.match(run.stdout + run.stderr, /AssertionError/);
  report.mutations.push({ name, status: run.status });
}
assert.equal(readFileSync(sourcePath, 'utf8'), original);
assert.equal(git(candidateRoot, 'diff', '--', sourcePath), '');
execFileSync('pnpm', ['exec', 'vitest', 'run', 'test/compiler-source-map.test.ts'], { stdio: 'inherit' });
report.sink = sink;
report.environment.finalLoad = os.loadavg();
save();
console.log('RESEARCH_RECEIPT', JSON.stringify({ candidateSha: report.candidateSha, changedFiles: report.changedFiles, differential: report.differential, mutations: report.mutations, resultSha256: hash(readFileSync('reports/event-map/result.json')) }));
