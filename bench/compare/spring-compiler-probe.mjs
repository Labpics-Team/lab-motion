import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { hashFileTree, sha256File } from './provenance.mjs';
const mode=process.argv[4]??'exact';
assert(['exact','adaptive'].includes(mode),'Unknown comparison mode');
const paths=Object.fromEntries(['baseline','candidate'].map((name,i)=>[name,resolve(process.argv[i+2])]));
const fingerprints=()=>Object.fromEntries(Object.entries(paths).map(([name,root])=>[name,{
 entry:sha256File(resolve(root,'compositor/index.js')), runtime:hashFileTree(root,file=>/\.(?:c?js|mjs)$/.test(file)).sha256
}]));
const hashes=fingerprints();
const apis=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([name,root])=>[name,await import(pathToFileURL(resolve(root,'compositor/index.js')))])));
console.log(JSON.stringify({artifacts:hashes,mode,node:process.version}));
const rows=[];
for(let round=-3;round<12;round++){
 const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
 const specs=Array.from({length:160},(_,i)=>{
  const mass=.8+(i%7)*.13, stiffness=90+(i%13)*17+(round+3)*.001, w=Math.sqrt(stiffness*mass);
  return {spring:{mass,stiffness,damping:2*w*[.3,1,2][i%3]},v0:(i%5)-2,tolerance:[.001,.0025,.004,.008][i%4]};
 });
 let reference;
 for(const name of order){
  const api=apis[name],cache=api.createSpringLinearCache(256);
  const start=performance.now();
  const outputs=specs.map(s=>cache.compile(s.spring,{v0:s.v0,tolerance:s.tolerance}));
  const ms=performance.now()-start;
  const bytes=outputs.reduce((a,s)=>a+s.length,0),stops=outputs.reduce((a,s)=>a+s.split(',').length,0);
  if(mode==='exact'){if(!reference)reference=outputs;else assert.deepEqual(outputs,reference);}
  else {
   const plans=specs.map(s=>api.compileSpringPlan({...s,property:'x',from:0,to:1}));
   for(const [i,plan] of plans.entries()){
    assert.equal(plan.nodes[0].progress,0);assert.equal(plan.nodes.at(-1).progress,1);
    assert(plan.nodes.every((x,k)=>Number.isFinite(x.progress)&&Number.isFinite(x.percent)&&(!k||x.percent>plan.nodes[k-1].percent)));
   }
  }
  if(round>=0){const row={round,name,ms,bytes,stops,entrySha256:hashes[name].entry,runtimeSha256:hashes[name].runtime};rows.push(row);console.log(JSON.stringify(row))}
 }
}
const med=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
for(const name of ['baseline','candidate']){
 const r=rows.filter(x=>x.name===name);
 console.log(JSON.stringify({summary:true,name,...Object.fromEntries(['ms','bytes','stops'].map(k=>[k,med(r.map(x=>x[k]))]))}));
}

assert.deepEqual(fingerprints(),hashes,'Build artifacts changed during measurement');
