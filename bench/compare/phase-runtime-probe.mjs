import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const apis=Object.fromEntries(await Promise.all(['baseline','candidate'].map(async (name,i)=>[name,await import(pathToFileURL(resolve(process.argv[i+2],'motion/index.js')))])));
const tasks=[['linear',1],['standard',1],['linear',1000],['standard',1000],['standard-stagger',1000],['custom',1000]];
const rows=[];
for(const [kind,n] of tasks){
 for(let round=-2;round<10;round++){
  const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
  for(const name of order){
   const targets=Array.from({length:n},(_,i)=>{const values={width:i%53+'px',height:i%29+'px'};return {style:{getPropertyValue(k){return values[k]??''},setProperty(k,v){values[k]=v}}}});
   let customCalls=0;
   const opts={duration:1000,ease:kind==='custom'?(t)=>{customCalls++;return t*t}:kind==='linear'?'linear':'standard',stagger:kind==='standard-stagger'?0.2:0};
   const run=apis[name].animate(targets,{width:100,height:200},opts);
   run.pause();
   for(const t of [0,250,750,125])run.seek(t);
   customCalls=0;
   let checksum=0; const start=performance.now();
   for(let i=0;i<120;i++){
    run.seek(1+(i*83)%999);
    checksum+=Number.parseFloat(targets[(i*7)%n].style.getPropertyValue('width'));
   }
   const ms=performance.now()-start;
   const observed=targets.map(el=>[el.style.getPropertyValue('width'),el.style.getPropertyValue('height')]);
   run.finish();assert.deepEqual(await run.finished,{status:'finished'});
   for(const el of targets){assert.equal(el.style.getPropertyValue('width'),'100px');assert.equal(el.style.getPropertyValue('height'),'200px');}
   const row={kind,n,round,name,ms,checksum,customCalls};
   // Compare exact outputs and custom callback count across each pair.
   if(name===order[0])globalThis.reference={observed,checksum,customCalls};else assert.deepEqual({observed,checksum,customCalls},globalThis.reference);
   if(round>=0){rows.push(row);console.log(JSON.stringify(row));}
  }
 }
}
const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
for(const [kind,n] of tasks)for(const name of ['baseline','candidate']){
 const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.name===name);
 console.log(JSON.stringify({summary:true,kind,n,name,ms:med(r.map(x=>x.ms)),customCalls:r[0].customCalls}));
}
