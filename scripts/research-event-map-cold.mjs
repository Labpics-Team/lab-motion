import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import ts from 'typescript';
import { parseAstAsync } from 'vite';

const base = resolve(process.argv[2]);
const candidate = process.cwd();
const sha = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(base), 'ecfa6beb90bb116b47f1641d8edbeac0b2d9bb9f');
const expectedHashes = {
  base: 'c9f82eaa1d713fa6629e53d44b780386d38864c8df3342ed6451eb1c3aa2b7a9',
  candidate: '30fbb6d6eb076cdcbeb0c47995071f18abd4a350694dff61e5d14651cd3830a6',
};
for (const [side, root] of Object.entries({ base, candidate })) assert.equal(hash(readFileSync(join(root, 'dist/compiler/vite/index.js'))), expectedHashes[side]);
for (const file of ['package.json', 'pnpm-lock.yaml', 'tsup.config.ts']) assert.deepEqual(readFileSync(join(base, file)), readFileSync(join(candidate, file)));
mkdirSync('reports/event-map', { recursive: true });
const report = { baseSha: sha(base), candidateSha: sha(candidate), expectedHashes, environment: { node: process.version, nodeSha256: hash(readFileSync(process.execPath)), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, load: os.loadavg() }, cold: {}, builds: [] };
const save = () => writeFileSync('reports/event-map/cold-build.json', JSON.stringify(report, null, 2));
const program = ts.createProgram(['test/compiler-source-map.test.ts'], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, strict: true, skipLibCheck: true });
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) console.error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (p) => p, getCurrentDirectory: () => candidate, getNewLine: () => '\n' }));
assert.equal(errors.length, 0, 'new oracle must also typecheck');
report.oracleTypes = 'PASS';

const median = (values) => { const x = [...values].sort((a, b) => a - b); return (x[Math.floor((x.length - 1) / 2)] + x[Math.ceil((x.length - 1) / 2)]) / 2; };
const summary = (ratios) => {
  let seed = 0x1195cd;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const boot = Array.from({ length: 4096 }, () => median(ratios.map(() => ratios[Math.floor(random() * ratios.length)]))).sort((a, b) => a - b);
  return { medianRatio: median(ratios), ci95: [boot[102], boot[3993]] };
};
const child = `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const {code,ast}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const t0=process.hrtime.bigint();const {motionCompiler}=await import(process.argv[1]);const t1=process.hrtime.bigint();
const result=motionCompiler().transform.call({parse:()=>ast,warn:(message)=>{throw new Error(message)}},code,'/app.js');const t2=process.hrtime.bigint();
console.log(JSON.stringify({importNs:Number(t1-t0),firstNs:Number(t2-t1),totalNs:Number(t2-t0),hash:createHash('sha256').update(JSON.stringify(result??null)).digest('hex')}));`;
const header = `import { animate } from '@labpics/motion/nano';\n`;
const sources = {
  nano8: header + Array.from({ length: 8 }, (_, i) => `animate(els[${i}],{opacity:0.5});`).join('\n'),
  lines1000: header + Array.from({ length: 1000 }, (_, i) => `const property${i}=${i};`).join('\n') + `\nanimate(el,{opacity:1});`,
  surface1: `import { animate } from '@labpics/motion/animate';\nanimate(el,{width:[100,200]},{layout:'project'});`,
};
for (const [name, code] of Object.entries(sources)) {
  const file = resolve(`reports/event-map/fixture-${name}.json`);
  writeFileSync(file, JSON.stringify({ code, ast: await parseAstAsync(code) }));
  const run = (root) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child, pathToFileURL(join(root, 'dist/compiler/vite/index.js')).href, file], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const blocks = [];
  for (let block = 0; block < 32; block++) {
    const reversed = block % 2 === 1;
    const raw = (reversed ? [candidate, base, base, candidate] : [base, candidate, candidate, base]).map(run);
    assert.ok(raw.every((x) => x.hash === raw[0].hash));
    const entry = { order: reversed ? 'BAAB' : 'ABBA', raw };
    for (const metric of ['importNs', 'firstNs', 'totalNs']) entry[metric] = reversed ? (raw[0][metric] + raw[3][metric]) / (raw[1][metric] + raw[2][metric]) : (raw[1][metric] + raw[2][metric]) / (raw[0][metric] + raw[3][metric]);
    blocks.push(entry);
  }
  report.cold[name] = { blocks, ...Object.fromEntries(['importNs', 'firstNs', 'totalNs'].map((metric) => [metric, summary(blocks.map((b) => b[metric]))])) };
  console.log('COLD', name, JSON.stringify(Object.fromEntries(['importNs', 'firstNs', 'totalNs'].map((key) => [key, report.cold[name][key]]))));
  if (name === 'nano8') {
    const controls = [];
    for (let block = 0; block < 32; block++) { const a = run(base), b = run(base); controls.push({ a, b, ratio: b.totalNs / a.totalNs }); }
    report.coldUnchanged = { ...summary(controls.map((x) => x.ratio)), controls };
    console.log('COLD_A_A', JSON.stringify(summary(controls.map((x) => x.ratio))));
  }
  save();
}

// Обычный build, без смены флагов/методологии; последовательность AB/BA заранее фиксирована.
for (let pair = 0; pair < 20; pair++) {
  const reversed = pair % 2 === 1;
  const measured = {};
  for (const side of reversed ? ['candidate', 'base'] : ['base', 'candidate']) {
    const root = side === 'base' ? base : candidate;
    const start = process.hrtime.bigint();
    const result = spawnSync('pnpm', ['build'], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    measured[side] = Number(process.hrtime.bigint() - start);
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    assert.equal(result.status, 0, `build ${pair} ${side}`);
    assert.equal(hash(readFileSync(join(root, 'dist/compiler/vite/index.js'))), expectedHashes[side], 'rebuild must preserve measured artifact');
  }
  report.builds.push({ pair, order: reversed ? 'BA' : 'AB', ...measured, ratio: measured.candidate / measured.base });
  console.log('BUILD_PAIR', JSON.stringify(report.builds.at(-1)));
  save();
}
report.buildSummary = summary(report.builds.map((x) => x.ratio));
report.environment.finalLoad = os.loadavg();
save();
console.log('BUILD_SUMMARY', JSON.stringify(report.buildSummary));
console.log('COLD_BUILD_RECEIPT_SHA256', hash(readFileSync('reports/event-map/cold-build.json')));
