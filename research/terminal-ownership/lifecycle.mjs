import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [root,supportRoot,multiplierText='1']=process.argv.slice(2),multiplier=Number(multiplierText);
const {animate}=await import(pathToFileURL(`${root}/animate/index.js`));
const {runMassLifecycleSample}=await import(pathToFileURL(`${supportRoot}/scripts/bench-support.mjs`));
const rows=[];
for(const motion of ['spring','tween'])for(const count of [1,100,1000]){
 const run=()=>runMassLifecycleSample({animate,count,motion});
 // Underwarmed local A/A was unresolved. This fixed warmup was selected from
 // A/A only, before observing candidate timings; no workload/threshold change.
 for(let i=0;i<(count===1?1000:200);i++)await run();
 const row={motion,count,samples:[],semantic:null};
 for(let i=0;i<80;i++){
  const sample={startNs:0,frames60Ns:0,teardownNs:0};
  for(let j=0;j<multiplier;j++){
   const measured=await run();for(const key of Object.keys(sample))sample[key]+=measured[key];
   assert.equal(measured.semantic.valid,true);
   if(row.semantic===null)row.semantic=measured.semantic;
   assert.equal(measured.semantic.lastValueHash,row.semantic.lastValueHash);
   assert.equal(measured.semantic.totalWrites,60*count);
  }
  row.samples.push(sample);
 }
 rows.push(row);
}
console.log(JSON.stringify({root,multiplier,warmup:{single:1000,mass:200},repetitions:80,rows}));
