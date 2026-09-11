import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseAstAsync } from 'vite';
import os from 'node:os';

// Одноразовый carrier: прежние методы сохранены, изменён только проверяемый output buffer.
const base = resolve(process.argv[2]);
const rejected = resolve(process.argv[3]);
const candidate = process.cwd();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('hash-object', 'src/compiler/vite/index.ts'), '6c801be8d68d013d19eb9c9ce78593d63bd80d60');
assert.equal(git('-C', base, 'rev-parse', 'HEAD'), 'ecfa6beb90bb116b47f1641d8edbeac0b2d9bb9f');
assert.equal(git('-C', rejected, 'rev-parse', 'HEAD'), '5d3c1b8857606354cc1662e1c2ed0165a458439d');
assert.equal(hash(readFileSync(join(rejected, 'dist/compiler/vite/index.js'))), '30fbb6d6eb076cdcbeb0c47995071f18abd4a350694dff61e5d14651cd3830a6');
const candidateHash = hash(readFileSync('dist/compiler/vite/index.js'));
mkdirSync('reports/event-map', { recursive: true });
function edit(source, from, to) { assert.ok(source.includes(from), `missing exact carrier edit ${from}`); return source.replace(from, to); }

// Повторить тот же byte/corpus/paired/mutation proof для изменившегося production blob.
let warm = execFileSync('git', ['show', '32af7494fdad3347895ad732e4e62f30196f1168:scripts/research-event-map.mjs'], { encoding: 'utf8' });
assert.equal(warm.split("mappings += ';';").length - 1, 2);
warm = warm.replaceAll("mappings += ';';", "mappings.push(';');");
warm = edit(warm, 'const median = (values)', "Object.assign(sources, { consumedNano8: sources.nano8, consumedLines1000: sources.lines1000 });\nconst median = (values)");
warm = edit(warm, "const a = () => aPlugin.transform.call(ctx, code, '/app.js');\n  const b = () => bPlugin.transform.call(ctx, code, '/app.js');", "const plainA = () => aPlugin.transform.call(ctx, code, '/app.js');\n  const plainB = () => bPlugin.transform.call(ctx, code, '/app.js');\n  const consume = (value) => { if (value) createHash('sha256').update(value.code).update(value.map.mappings).digest('hex'); return value; };\n  const a = name.startsWith('consumed') ? () => consume(plainA()) : plainA;\n  const b = name.startsWith('consumed') ? () => consume(plainB()) : plainB;");
writeFileSync('scripts/research-event-map.mjs', warm);
execFileSync(process.execPath, ['scripts/research-event-map.mjs', base], { stdio: 'inherit' });

// Fresh-process retained-result probe. GC измеряется отдельно от performance timing.
const memory = { candidateSha: git('rev-parse', 'HEAD'), candidateHash, node: process.version, cpu: os.cpus()[0]?.model, retainedResultCount: 512, blockCount: 6, cases: {} };
const header = `import { animate } from '@labpics/motion/nano';\n`;
const cases = {
  nano8: header + Array.from({ length: 8 }, (_, i) => `animate(els[${i}],{opacity:0.5});`).join('\n'),
  lines1000: header + Array.from({ length: 1000 }, (_, i) => `const property${i}=${i};`).join('\n') + `\nanimate(el,{opacity:1});`,
};
const memoryChild = `import {readFileSync} from 'node:fs';
const {code,ast}=JSON.parse(readFileSync(process.argv[2],'utf8'));const {motionCompiler}=await import(process.argv[1]);
const plugin=motionCompiler(),ctx={parse:()=>ast,warn:(m)=>{throw new Error(m)}};
for(let i=0;i<200;i++)plugin.transform.call(ctx,code,'/app.js');
const values=[];global.gc();const before=process.memoryUsage().heapUsed;
for(let i=0;i<512;i++)values.push(plugin.transform.call(ctx,code,'/app.js'));
global.gc();const after=process.memoryUsage().heapUsed;
console.log(JSON.stringify({before,after,retained:after-before,perResult:(after-before)/512,mapLength:values[0].map.mappings.length,codeLength:values[0].code.length}));`;
for (const [name, code] of Object.entries(cases)) {
  const fixture = resolve(`reports/event-map/retention-${name}.json`);
  writeFileSync(fixture, JSON.stringify({ code, ast: await parseAstAsync(code) }));
  const run = (root) => {
    const p = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', memoryChild, pathToFileURL(join(root, 'dist/compiler/vite/index.js')).href, fixture], { encoding: 'utf8', timeout: 60000 });
    assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout);
  };
  const blocks = [];
  for (let block = 0; block < 6; block++) {
    const order = block % 2 ? ['candidate', 'base', 'base', 'candidate'] : ['base', 'candidate', 'candidate', 'base'];
    const raw = order.map((side) => ({ side, ...run(side === 'base' ? base : candidate) }));
    blocks.push({ order, raw });
  }
  const controls = [];
  for (let pair = 0; pair < 6; pair++) controls.push({ a: run(base), b: run(base), rejected: run(rejected) });
  memory.cases[name] = { blocks, controls };
  writeFileSync('reports/event-map/retention.json', JSON.stringify(memory, null, 2));
  console.log('RETENTION', name, JSON.stringify(memory.cases[name]));
}

// Тот же cold/build protocol. 192 Nano8 blocks, остальные32; A/A64; все20 пар builds.
let cold = execFileSync('git', ['show', '34deda0cbee30c0712344856568e5c6e2b429df5:scripts/research-event-map-cold.mjs'], { encoding: 'utf8' });
cold = edit(cold, '30fbb6d6eb076cdcbeb0c47995071f18abd4a350694dff61e5d14651cd3830a6', candidateHash);
cold = edit(cold, 'for (let block = 0; block < 32; block++) {', "for (let block = 0; block < (name === 'nano8' ? 192 : 32); block++) {");
cold = edit(cold, 'for (let block = 0; block < 32; block++) {', 'for (let block = 0; block < 64; block++) {');
writeFileSync('scripts/research-event-map-cold.mjs', cold);
writeFileSync('reports/event-map/carrier-provenance.json', JSON.stringify({ finalCandidate: '54cd18a40415757668dcb018e3c6d1429bff78d6', productionBlob: '6c801be8d68d013d19eb9c9ce78593d63bd80d60', candidateHash, warmScriptSha256: hash(warm), coldScriptSha256: hash(cold), warmSource: '32af7494fdad3347895ad732e4e62f30196f1168:scripts/research-event-map.mjs', coldSource: '34deda0cbee30c0712344856568e5c6e2b429df5:scripts/research-event-map-cold.mjs' }, null, 2));
execFileSync(process.execPath, ['scripts/research-event-map-cold.mjs', base], { stdio: 'inherit' });
assert.equal(git('hash-object', 'src/compiler/vite/index.ts'), '6c801be8d68d013d19eb9c9ce78593d63bd80d60');
console.log('FINAL_PROOF_DONE', candidateHash);
