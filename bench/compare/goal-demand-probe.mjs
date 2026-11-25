import { serveDist } from './serve-dist.mjs';
import { realpathSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { sha256File, sha256Bytes, hashFileTree, captureBenchmarkEnvironment } from './provenance.mjs';
const roots={baseline:realpathSync(process.argv[2]),candidate:realpathSync(process.argv[3])};
const fingerprints=()=>Object.fromEntries(Object.entries(roots).map(([k,v])=>[k,{entry:sha256File(resolve(v,'motion/index.js')),runtime:hashFileTree(v,f=>/\.(?:c?js|mjs)$/.test(f)).sha256}]));
const checkout=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const git=(root,...args)=>execFileSync('git',args,{cwd:root});
const revision=root=>({
 revision:git(root,'rev-parse','HEAD').toString().trim(),
 tree:git(root,'rev-parse','HEAD^{tree}').toString().trim(),
 dirty:!!git(root,'status','--porcelain').toString().trim()
});
const inputs=['bench/compare/goal-demand-probe.mjs','bench/compare/serve-dist.mjs','bench/compare/provenance.mjs','package.json','pnpm-lock.yaml'];
const capture=()=>{
 const environment=captureBenchmarkEnvironment(checkout,resolve(checkout,'bench/compare'),[],{requiredRootPackages:['@playwright/test','tsup','typescript','esbuild']});
 const terser=realpathSync(resolve(checkout,'node_modules/terser'));
 const packages=Object.fromEntries(Object.entries(environment.rootPackages).map(([k,v])=>[k,{version:v.version,sha256:v.sha256}]));
 packages.terser={version:JSON.parse(readFileSync(resolve(terser,'package.json'),'utf8')).version,sha256:hashFileTree(terser).sha256};
 return {
  harness:revision(checkout),
  measured:Object.fromEntries(Object.entries(roots).map(([name,root])=>[name,revision(dirname(root))])),
  canonicalInputs:Object.fromEntries(inputs.map(f=>[f,sha256Bytes(git(checkout,'show','HEAD:'+f))])),
  workingInputs:Object.fromEntries(inputs.map(f=>[f,sha256File(resolve(checkout,f))])),
  environment:{node:environment.node,nodeExecutableSha256:environment.nodeExecutableSha256,pnpm:environment.pnpm,packages}
 };
};
const provenance=capture();
assert(!provenance.harness.dirty&&Object.values(provenance.measured).every(x=>!x.dirty),'clean measured checkouts required');
const artifacts=fingerprints(),server=await serveDist(roots);
const browser=await chromium.launch({channel:'chrome',headless:true});
const cases=[['spring-repeat',100],['spring-repeat',1000],['spring-change',100],['spring-change',1000],['linear-repeat',1000],['moving-repeat',100],['moving-repeat',1000],['moving-change',1000]];
const rows=[];
try {
 for(const [kind,n] of cases)for(let round=-2;round<10;round++){
  const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];let reference;
  for(const name of order){
   const page=await browser.newPage();
   try{
    await page.goto('http://127.0.0.1:'+server.address().port);
    const data=await page.evaluate(async({name,n,kind})=>{
     const clock=performance.now.bind(performance); Object.defineProperty(performance,'now',{value:()=>0,configurable:true}); const {animate}=await import('/'+name+'/motion/index.js');
     const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1000px;height:1000px;';
     const targets=[];
     for(let i=0;i<n;i++){const el=document.createElement('div');el.style.cssText='position:absolute;width:'+(i+1)+'px;height:10px';root.append(el);targets.push(el)}
     document.body.append(root);root.getBoundingClientRect();
     const opts=kind==='linear-repeat'?{duration:1000,ease:'linear'}:{spring:{mass:1,stiffness:170,damping:26}};
     const first=animate(targets,{width:1500},opts);const moving=kind.startsWith('moving'); if(!moving)first.pause();first.seek(first.duration*(moving?.125:.375));
     const initial=targets.map(el=>el.style.width);
     const change=kind.endsWith('change'),to=change?1600:1500;
     const begin=clock(),run=animate(targets,{width:to},opts),startup=clock()-begin;
     const duration=run.duration,state=run.state;
     if((await first.finished).status!=='stopped')throw Error('ownership');
     const poses=[targets.map(el=>el.style.width)];
     if(!change&&(state!==(moving?'running':'paused')||duration!==first.duration||JSON.stringify(poses[0])!==JSON.stringify(initial)))throw Error('repeat changed phase');
     run.pause();
     for(const t of [.25,.5,.75]){run.seek(duration*t);poses.push(targets.map(el=>el.style.width))}
     run.finish();if((await run.finished).status!=='finished'||targets.some(el=>el.style.width!==to+'px'||el.getAnimations().length))throw Error('cleanup');
     return {startup,duration,state,poses};
    },{name,n,kind});
    const {startup,...semantic}=data;
    if(!reference)reference=semantic;else assert.deepEqual(semantic,reference);
    if(round>=0){const row={kind,n,round,name,startup,entrySha256:artifacts[name].entry,runtimeSha256:artifacts[name].runtime};rows.push(row);console.log(JSON.stringify(row))}
   }finally{await page.close()}
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
}finally{await browser.close();server.close()}
