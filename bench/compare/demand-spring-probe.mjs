import { serveDist } from './serve-dist.mjs';
import { realpathSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { sha256File, hashFileTree } from './provenance.mjs';
const roots={baseline:realpathSync(process.argv[2]),candidate:realpathSync(process.argv[3])};
const fingerprints=()=>Object.fromEntries(Object.entries(roots).map(([k,v])=>[k,{entry:sha256File(resolve(v,'motion/index.js')),runtime:hashFileTree(v,f=>/\.(?:c?js|mjs)$/.test(f)).sha256}]));
const artifacts=fingerprints();
const harnessDirectory=dirname(fileURLToPath(import.meta.url)), checkout=resolve(harnessDirectory,'../..');
const git=(...args)=>execFileSync('git',args,{cwd:checkout,encoding:'utf8'}).trim();
const inputs=['bench/compare/demand-spring-probe.mjs','bench/compare/serve-dist.mjs','bench/compare/provenance.mjs','package.json','pnpm-lock.yaml'];
const require=createRequire(import.meta.url);
const resolvePackage=(name,from=require)=>dirname(from.resolve(name+'/package.json'));
const playwrightRequire=createRequire(resolve(resolvePackage('@playwright/test'),'package.json'));
const coreRequire=createRequire(resolve(resolvePackage('playwright',playwrightRequire),'package.json'));
const capture=()=>({
 harnessRevision:git('rev-parse','HEAD'),dirty:!!git('status','--porcelain'),
 inputs:Object.fromEntries(inputs.map(f=>[f,sha256File(resolve(checkout,f))])),
 canonicalInputs:Object.fromEntries(inputs.map(f=>[f,createHash('sha256').update(execFileSync('git',['show','HEAD:'+f],{cwd:checkout})).digest('hex')])),
 node:process.version,nodeExecutable:sha256File(process.execPath),
 pnpm:execFileSync('pnpm',['--version'],{encoding:'utf8',shell:process.platform==='win32'}).trim(),
 packages:Object.fromEntries(['@playwright/test','playwright','playwright-core','tsup','typescript','esbuild','terser'].map(name=>{
  const dir=realpathSync(resolvePackage(name,name==='playwright'?playwrightRequire:name==='playwright-core'?coreRequire:require));
  return [name,{version:JSON.parse(readFileSync(resolve(dir,'package.json'),'utf8')).version,tree:hashFileTree(dir).sha256}];
 }))
});
const provenance=capture();
assert(!provenance.dirty,'benchmark harness checkout must be clean');

const server=await serveDist(roots);
const browser=await chromium.launch({channel:'chrome',headless:true});
const cases=[['reduced',100],['reduced',1000],['system',1000],['sequence',200],['sequence-system',200],['normal',100],['normal',1000]];
const rows=[];
try{
 for(const [kind,n] of cases)for(let round=-2;round<10;round++){
  const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];let reference;
  for(const name of order){
   const page=await browser.newPage({reducedMotion:(kind==='system'||kind==='sequence-system')?'reduce':'no-preference'});
   try{
    await page.goto('http://127.0.0.1:'+server.address().port);
    const data=await page.evaluate(async({name,n,kind})=>{
     const {animate,sequence}=await import('/'+name+'/motion/index.js');
     const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1000px;height:1000px;';
     const targets=[];
     for(let i=0;i<n;i++){const el=document.createElement('div');el.style.cssText='position:absolute;width:'+(i+1)+'px;height:10px';root.append(el);targets.push(el)}
     document.body.append(root);root.getBoundingClientRect();
     const props={width:1500};
     const opts={spring:{mass:1,stiffness:170,damping:26},...(kind==='reduced'?{reducedMotion:'always'}:{})};
     const sequenced=kind.startsWith('sequence'); const t=performance.now(),run=sequenced?sequence([[targets,props,opts],[targets,{width:2000},opts]],kind==='sequence'?{reducedMotion:'always'}:undefined):animate(targets,props,opts);
     const startup=performance.now()-t, state=run.state,duration=run.duration;
     const poses=[];
     if(kind==='normal'){
      run.pause();
      for(const t of [duration*.125,duration*.375,duration*.625]){run.seek(t);poses.push(targets.map(el=>el.style.width));}
      run.finish();
     }else if(state!=='finished'||duration!==0)throw Error('not synchronously reduced');
     const result=await run.finished;
     if(result.status!=='finished'||targets.some(el=>el.style.width!==(sequenced?'2000px':'1500px')||el.getAnimations().length))throw Error('end/cleanup mismatch');
     return {startup,state,duration,poses};
    },{name,n,kind});
    const {startup,...semantic}=data;
    if(!reference)reference=semantic;else assert.deepEqual(semantic,reference);
    if(round>=0){const row={kind,n,round,name,startup,entrySha256:artifacts[name].entry,runtimeSha256:artifacts[name].runtime};rows.push(row);console.log(JSON.stringify(row))}
   }finally{await page.close();}
  }
 }
 assert.deepEqual(fingerprints(),artifacts);
 assert.deepEqual(capture(),provenance);
 console.log(JSON.stringify({artifacts,chrome:browser.version(),node:process.version,provenance}));
 const med=x=>x.sort((a,b)=>a-b)[Math.floor(x.length/2)];
 for(const [kind,n] of cases)for(const name of ['baseline','candidate']){
  const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.name===name);
  console.log(JSON.stringify({summary:true,kind,n,name,startup:med(r.map(x=>x.startup))}));
 }
}finally{await browser.close();server.close();}
