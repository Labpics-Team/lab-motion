// Минимальный remaining proof #232: cold/import/build и baseline characterization.
// Warm/size proof сохранён в immutable 454bedd5, здесь НЕ повторяется.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseAstAsync } from 'vite';

const BASE = '80264dc5fa94a7213f4529d89a5159dd53d06bb3';
const root = process.cwd();
const output = join(root, 'single-plan-evidence');
mkdirSync(output, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { base: BASE, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
  environment: { node: process.version, executable: hash(readFileSync(process.execPath)), os: release(),
    cpu: cpus()[0]?.model, cores: cpus().length, runnerImage: process.env.ImageVersion,
    package: hash(readFileSync('package.json')), lock: hash(readFileSync('pnpm-lock.yaml')) },
  goldens: {}, cold: [], builds: [] };
const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
const median = (xs) => { const s = [...xs].sort((a,b) => a-b); const i = s.length >>> 1; return s.length % 2 ? s[i] : (s[i-1]+s[i])/2; };
function summary(pairs) {
  const ratios = pairs.map((p) => p.candidate / p.base);
  let seed = 0x5eed232;
  const random = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const boot = Array.from({length:5000}, () => median(ratios.map(() => ratios[Math.floor(random()*ratios.length)]))).sort((a,b)=>a-b);
  return { medianRatio: median(ratios), ratio95: [boot[125],boot[4874]], baseMedianMs: median(pairs.map((p)=>p.base)), candidateMedianMs: median(pairs.map((p)=>p.candidate)) };
}
function build(dir, label) {
  const start = performance.now();
  const result = spawnSync('pnpm', ['build'], { cwd: dir, encoding: 'utf8', timeout: 180_000, maxBuffer: 16*1024*1024 });
  const ms = performance.now() - start;
  writeFileSync(join(output,label+'.log'), (result.stdout??'')+(result.stderr??''));
  assert.ifError(result.error); assert.equal(result.status,0,label);
  return ms;
}
let baseDir;
try {
  baseDir = join(mkdtempSync(join(tmpdir(),'single-plan-cold-')),'base');
  execFileSync('git',['worktree','add','--detach',baseDir,BASE],{cwd:root,stdio:'pipe'});
  symlinkSync(join(root,'node_modules'),join(baseDir,'node_modules'),'dir');
  for (const file of ['package.json','pnpm-lock.yaml','tsup.config.ts']) assert.deepEqual(readFileSync(join(root,file)),readFileSync(join(baseDir,file)));
  build(baseDir,'base-initial'); build(root,'candidate-initial');
  const baseUrl = pathToFileURL(join(baseDir,'dist/compiler/vite/index.js')).href;
  const candidateUrl = pathToFileURL(join(root,'dist/compiler/vite/index.js')).href;
  const baseline = (await import(baseUrl)).motionCompiler();
  const candidate = (await import(candidateUrl)).motionCompiler();
  report.artifactHashes = { base: hash(readFileSync(join(baseDir,'dist/compiler/vite/index.js'))), candidate: hash(readFileSync(join(root,'dist/compiler/vite/index.js'))) };
  assert.equal(report.artifactHashes.base,'43508537d588d3d5f6537a085c6b6ed3f07a891fe33e3295165985b9f6894778');
  assert.equal(report.artifactHashes.candidate,'c9f82eaa1d713fa6629e53d44b780386d38864c8df3342ed6451eb1c3aa2b7a9');
  const NANO = '@labpics/motion/nano', SURFACE = '@labpics/motion/animate';
  const BODY = `animate(card, { opacity: 1 });\nanimate(panel, { width: [100, 200] }, { layout: 'project' });\n`;
  const fixtures = [];
  for (const [nano,surface] of [['animate','surface'],['nano','animate']]) {
    const imports = [`import { animate as ${nano} } from '${NANO}';`,`import { animate as ${surface} } from '${SURFACE}';`];
    for (const [index,ordered] of [imports,[...imports].reverse()].entries()) fixtures.push([`${nano}-${surface}-${index}`, ordered.join('\n')+'\n'+BODY]);
  }
  fixtures.push(['nested',`import { animate } from '${NANO}';\nanimate(animate(card, { opacity: 0.5 }), { opacity: 1 });\n`]);
  const full = {};
  function apply(plugin,ast,code) { return plugin.transform.call({parse:()=>ast,warn:(message)=>{throw new Error(message);}},code,'/app/module.js'); }
  for (const [name,code] of fixtures) {
    const ast = await parseAstAsync(code);
    const a = apply(baseline,ast,code), b = apply(candidate,ast,code);
    assert.ok(a); assert.deepEqual(b,a);
    full[name] = { input:code, result:a };
    report.goldens[name] = { code:hash(a.code), mappings:a.map.mappings, map:hash(JSON.stringify(a.map)) };
  }
  writeFileSync(join(output,'characterization.json'),JSON.stringify(full,null,2));
  console.log('GOLDENS',JSON.stringify(report.goldens));
  // Исходные parenthesized/negative входы сохранены как обязательные отказы.
  // core.ts требует Literal и тривиа ровно "(" перед target; это не положительный домен.
  let positive = 0, declined = 0;
  for (const count of [1,2,8,32,128]) for (const opacity of [-1,-0,0.25,0.5,1,2]) for (const newline of ['\n','\r\n']) {
    for (const parenthesized of [true,false]) {
      const calls = Array.from({length:count},(_,i)=>`animate(${parenthesized ? `(sideEffect(${i}), card${i})` : `resolveTarget(${i})`}, {opacity:${opacity}});`).join(newline);
      const code = `import {animate} from '${NANO}';${newline}`+calls;
      const ast = await parseAstAsync(code); const a = apply(baseline,ast,code);
      if (parenthesized || opacity < 0) { assert.equal(a,undefined); declined++; }
      else { assert.ok(a); positive++; }
      assert.deepEqual(apply(candidate,ast,code),a);
    }
  }
  report.additionalDifferential = { positive,declined,mismatches:0 };
  save();
  const parseUrl = pathToFileURL(join(root,'node_modules/vite/dist/node/index.js')).href;
  const child = `import {performance} from 'node:perf_hooks';
const {parseAstAsync}=await import(process.argv[3]);
const ast=await parseAstAsync(process.argv[2]);
const context={parse:()=>ast,warn:(m)=>{throw new Error(m);}};
const start=performance.now();
const {motionCompiler}=await import(process.argv[1]);
const loaded=performance.now();
const result=motionCompiler().transform.call(context,process.argv[2],'/app/cold.js');
const done=performance.now();
console.log(JSON.stringify({importMs:loaded-start,firstTransformMs:done-loaded,totalMs:done-start,code:result?.code.length,map:result?.map.mappings.length}));`;
  const nanoCode = `import {animate} from '${NANO}';\n` + Array.from({length:8},(_,i)=>`animate(card${i},{opacity:${i/8}});`).join('\n');
  const surfaceCode = `import {animate} from '${SURFACE}';\nanimate(card,{width:[100,200]},{layout:'project'});`;
  function cold(url,code) {
    const result=spawnSync(process.execPath,['--input-type=module','-e',child,url,code,parseUrl],{cwd:root,encoding:'utf8',timeout:10000});
    assert.ifError(result.error); assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout);
  }
  for (const [name,code,secondUrl] of [['nano-8',nanoCode,candidateUrl],['surface-1',surfaceCode,candidateUrl],['A-A',nanoCode,baseUrl]]) {
    const blocks=[];
    for(let i=0;i<32;i++) {
      const order=i%2?['B','A','A','B']:['A','B','B','A'];
      const observations=order.map((side)=>({side,...cold(side==='A'?baseUrl:secondUrl,code)}));
      for(const item of observations) { assert.equal(item.code,observations[0].code); assert.equal(item.map,observations[0].map); }
      blocks.push({block:i,observations});
    }
    const summaries={};
    for(const key of ['importMs','firstTransformMs','totalMs']) summaries[key]=summary(blocks.map((block)=>({
      base:block.observations.filter((o)=>o.side==='A').reduce((s,o)=>s+o[key],0)/2,
      candidate:block.observations.filter((o)=>o.side==='B').reduce((s,o)=>s+o[key],0)/2,
    })));
    report.cold.push({name,blocks,summaries}); save(); console.log('COLD',name,JSON.stringify(summaries));
  }
  // 20 независимых paired AB/BA полных сборок: install и прогрев вне окна.
  // tsup clean:true остаётся неизменённым; каждый build новый Node-процесс.
  for(let block=0;block<20;block++) {
    const pair={block,order:block%2?['candidate','base']:['base','candidate']};
    for(const side of pair.order) pair[side]=build(side==='base'?baseDir:root,`build-${block}-${side}`);
    report.builds.push(pair); save(); console.log('BUILD_PAIR',JSON.stringify(pair));
  }
  report.buildSummary=summary(report.builds);
  report.completed=true; save(); console.log('BUILD_SUMMARY',JSON.stringify(report.buildSummary));
  console.log('PROOF_COMPLETE',JSON.stringify({head:report.head,base:BASE,artifactHashes:report.artifactHashes}));
} catch(error) { report.failure={message:String(error),stack:error?.stack};save();console.error(error);process.exitCode=1; }
finally { if(baseDir) spawnSync('git',['worktree','remove','--force',baseDir],{cwd:root}); }
