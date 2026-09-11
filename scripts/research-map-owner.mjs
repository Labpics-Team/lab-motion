import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';

const base = resolve(process.argv[2]), rejected = resolve(process.argv[3]);
const candidate = process.cwd();
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const source = readFileSync('src/compiler/vite/index.ts', 'utf8');
const oldSource = git('show', 'ecfa6beb90bb116b47f1641d8edbeac0b2d9bb9f:src/compiler/vite/index.ts');
assert.equal(source.slice(source.indexOf('function applyEdits(')), oldSource.slice(oldSource.indexOf('function applyEdits(')), 'text owner and transform must be byte-identical to base');

// Прежний воспроизводимый протокол, новый exact blob; данные предыдущего кандидата не переиспользуются.
let carrier = git('show', 'a8c3958be816bfa164516b9cf6f60401651ea38a:scripts/research-event-map-final.mjs');
carrier = carrier.replaceAll('6c801be8d68d013d19eb9c9ce78593d63bd80d60', '73baf1a4e76e7d4b9b72c842c38424eca40e5489').replaceAll('54cd18a40415757668dcb018e3c6d1429bff78d6', '6e6ee8907bc8671cc5f5eb6160391fb975d27a47');
const deferredCold = "execFileSync(process.execPath, ['scripts/research-event-map-cold.mjs', base], { stdio: 'inherit' });";
assert.ok(carrier.includes(deferredCold));
carrier = carrier.replace(deferredCold, '// Cold/build запускается после независимой проверки представления.');
writeFileSync('scripts/research-event-map-final.mjs', carrier);
execFileSync(process.execPath, ['scripts/research-event-map-final.mjs', base, rejected], { stdio: 'inherit' });

const diagnostics = { candidateSha: git('rev-parse', 'HEAD').trim(), candidateArtifact: hash(readFileSync('dist/compiler/vite/index.js')), environment: { node: process.version, cpu: os.cpus()[0]?.model }, heap: {}, noop: {} };
const save = () => writeFileSync('reports/event-map/owner-diagnostics.json', JSON.stringify(diagnostics, null, 2));
const median = (values) => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
function summary(ratios) {
  let seed = 0x1195cd;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const boot = Array.from({ length: 4096 }, () => median(ratios.map(() => ratios[Math.floor(random() * ratios.length)]))).sort((a, b) => a - b);
  return { medianRatio: median(ratios), ci95: [boot[102], boot[3993]] };
}

// Та же no-import операция и граница тайминга; длинный фиксированный batch калибрует наносекундный путь.
const { motionCompiler: before } = await import(pathToFileURL(join(base, 'dist/compiler/vite/index.js')));
const { motionCompiler: after } = await import(pathToFileURL(join(candidate, 'dist/compiler/vite/index.js')));
const aPlugin = before(), bPlugin = after();
const ctx = { parse: () => { throw Error('no-import must not parse'); }, warn: () => { throw Error('no-import must not warn'); } };
const code = 'export const value=42;';
const a = () => aPlugin.transform.call(ctx, code, '/app.js');
const b = () => bPlugin.transform.call(ctx, code, '/app.js');
assert.equal(a(), undefined); assert.equal(b(), undefined);
function paired(a, b) {
  for (let i = 0; i < 131072; i++) { a(); b(); }
  let sink = 0;
  const run = (fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < 65536; i++) { const result = fn(); sink ^= (result?.code.length ?? 0) + (result?.map.mappings.length ?? 0); } return Number(process.hrtime.bigint() - t) / 65536; };
  const blocks = [];
  for (let block = 0; block < 64; block++) {
    const reverse = block % 2 === 1;
    const raw = (reverse ? [b, a, a, b] : [a, b, b, a]).map(run);
    const base = reverse ? (raw[1] + raw[2]) / 2 : (raw[0] + raw[3]) / 2;
    const cand = reverse ? (raw[0] + raw[3]) / 2 : (raw[1] + raw[2]) / 2;
    blocks.push({ order: reverse ? 'BAAB' : 'ABBA', raw, base, candidate: cand, ratio: cand / base });
  }
  return { ...summary(blocks.map((x) => x.ratio)), blocks, sink };
}
diagnostics.noop.unchanged = paired(a, a);
diagnostics.noop.candidate = paired(a, b);
diagnostics.noop.doubleWork = paired(a, () => { a(); return a(); });
console.log('NO_IMPORT_CALIBRATION', JSON.stringify(Object.fromEntries(Object.entries(diagnostics.noop).map(([k,v]) => [k,{medianRatio:v.medianRatio,ci95:v.ci95}]))));
assert.ok(diagnostics.noop.doubleWork.ci95[0] > 1.5, 'calibration must detect extra work');
save();

// Heap-оракул считает только узлы, доминируемые массивом результатов, а не JIT/allocator fixed cost.
function heapStats(path) {
  const bytes = readFileSync(path); const snapshot = JSON.parse(bytes);
  const meta = snapshot.snapshot.meta, nodes = snapshot.nodes, edges = snapshot.edges, strings = snapshot.strings;
  const nf = meta.node_fields, ef = meta.edge_fields, ns = nf.length, es = ef.length;
  const typeAt = nf.indexOf('type'), sizeAt = nf.indexOf('self_size'), countAt = nf.indexOf('edge_count');
  const edgeType = ef.indexOf('type'), edgeName = ef.indexOf('name_or_index'), edgeTo = ef.indexOf('to_node');
  const edgeTypes = meta.edge_types[0], nodeTypes = meta.node_types[0];
  const weak = edgeTypes.indexOf('weak'), prop = edgeTypes.indexOf('property'), element = edgeTypes.indexOf('element');
  const count = nodes.length / ns, starts = new Uint32Array(count + 1);
  let root = -1, p = 0;
  for (let i = 0; i < count; i++) {
    starts[i] = p;
    for (let j = 0; j < nodes[i * ns + countAt]; j++, p += es) {
      if (edges[p + edgeType] === prop && strings[edges[p + edgeName]] === '__labMotionRetainedResults') {
        const target = edges[p + edgeTo] / ns;
        assert.ok(root === -1 || root === target); root = target;
      }
    }
  }
  starts[count] = p; assert.ok(root >= 0);
  const reach = (blocked) => {
    const seen = new Uint8Array(count), stack = [0];
    while (stack.length) {
      const i = stack.pop(); if (i === blocked || seen[i]) continue; seen[i] = 1;
      for (let p = starts[i]; p < starts[i+1]; p += es) if (edges[p+edgeType] !== weak) stack.push(edges[p+edgeTo]/ns);
    }
    return seen;
  };
  const all = reach(-1), cut = reach(root), totals = {};
  let retained = 0, objects = 0, results = 0;
  for (let p = starts[root]; p < starts[root+1]; p += es) if (edges[p+edgeType] === element) results++;
  for (let i = 0; i < count; i++) if (all[i] && !cut[i]) {
    const type = nodeTypes[nodes[i*ns+typeAt]], size = nodes[i*ns+sizeAt];
    totals[type] ??= { nodes:0, bytes:0 }; totals[type].nodes++; totals[type].bytes += size;
    retained += size; objects++;
  }
  return { results, retained, objects, totals, snapshotSha256: hash(bytes) };
}
const memoryChild = `import {readFileSync} from 'node:fs';import {writeHeapSnapshot} from 'node:v8';import {setImmediate} from 'node:timers/promises';
const {code,ast}=JSON.parse(readFileSync(process.argv[2],'utf8'));const {motionCompiler}=await import(process.argv[1]);
const p=motionCompiler(),ctx={parse:()=>ast,warn:m=>{throw Error(m)}};for(let i=0;i<5000;i++)p.transform.call(ctx,code,'/app.js');await setImmediate();
const values=[];globalThis.__labMotionRetainedResults=values;global.gc();const before=process.memoryUsage().heapUsed;
for(let i=0;i<Number(process.argv[3]);i++)values.push(p.transform.call(ctx,code,'/app.js'));await setImmediate();global.gc();const after=process.memoryUsage().heapUsed;
console.log(JSON.stringify({count:values.length,delta:after-before,perResult:(after-before)/values.length}));if(process.argv[4])writeHeapSnapshot(process.argv[4]);`;
for (const name of ['nano8', 'lines1000']) {
  const fixture = resolve(`reports/event-map/fixture-${name}.json`);
  // Файлы с AST уже сохранены исходным warm/memory carrier.
  const input = name === 'nano8' ? resolve('reports/event-map/retention-nano8.json') : resolve('reports/event-map/retention-lines1000.json');
  const records = [];
  for (const n of [128, 512, 2048]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const sides = repeat % 2 ? ['candidate','base'] : ['base','candidate'];
      for (const side of sides) {
        const root = side === 'base' ? base : candidate;
        const file = n === 128 ? resolve(`reports/event-map/heap-${name}-${side}-${repeat}.heapsnapshot`) : undefined;
        const args = ['--expose-gc','--input-type=module','-e',memoryChild,pathToFileURL(join(root,'dist/compiler/vite/index.js')).href,input,String(n)];
        if (file) args.push(file);
        const run = spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000});
        assert.equal(run.status,0,run.stderr);
        const result = {side,repeat,n,...JSON.parse(run.stdout)};
        if(file){result.heap=heapStats(file);assert.equal(result.heap.results,n);}
        records.push(result);
      }
    }
  }
  diagnostics.heap[name]=records; save();
  console.log('OWNED_HEAP',name,JSON.stringify(records));
}
// Прежний уже опровергнутый direct-string вариант — положительный контроль доминируемых узлов.
const positivePath=resolve('reports/event-map/heap-rejected.heapsnapshot');
const control=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',memoryChild,pathToFileURL(join(rejected,'dist/compiler/vite/index.js')).href,resolve('reports/event-map/retention-lines1000.json'),'128',positivePath],{encoding:'utf8',timeout:120000});
assert.equal(control.status,0,control.stderr);diagnostics.heapPositive=heapStats(positivePath);
const baseline=diagnostics.heap.lines1000.find(x=>x.side==='base'&&x.heap).heap;
assert.ok(diagnostics.heapPositive.retained > baseline.retained*5,'heap oracle must detect known rope retention');
save();
execFileSync(process.execPath,['scripts/research-event-map-cold.mjs',base],{stdio:'inherit'});
console.log('MAP_OWNER_PROOF',hash(readFileSync('reports/event-map/owner-diagnostics.json')));
