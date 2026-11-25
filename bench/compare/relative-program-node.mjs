import { pathToFileURL } from 'node:url';
import { resolve, realpathSync } from 'node:path';
import assert from 'node:assert/strict';
import { sha256File, hashFileTree } from './provenance.mjs';
if(!global.gc)throw Error('Run with --expose-gc');
const names=['baseline','candidate'];
const roots=Object.fromEntries(names.map((name,i)=>[name,realpathSync(process.argv[i+2])]));
const fingerprints=()=>Object.fromEntries(names.map(name=>[name,{entry:sha256File(resolve(roots[name],'motion/index.js')),runtime:hashFileTree(roots[name],f=>/\.(?:c?js|mjs)$/.test(f)).sha256}]));
const artifacts=fingerprints();
const apis=Object.fromEntries(await Promise.all(names.map(async name=>[name,await import(pathToFileURL(resolve(roots[name],'motion/index.js')))])));
const cases=[{kind:'stagger',n:100,k:960},{kind:'stagger',n:1000,k:8},{kind:'sequence',n:100,k:8}];
const rows=[],med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
for(const {kind,n,k} of cases)for(let round=-2;round<8;round++){
 const order=(round+Math.floor(round/2))%2?names.slice().reverse():names;
 for(const name of order){
  const gap=kind==='stagger'?2:0, duration=(k-1)*10, steps=kind==='sequence'?12:1;
  const values=Array.from({length:k},(_,i)=>i);
  const targets=Array.from({length:n},()=>{let value='0px';return {style:{getPropertyValue(){return value},setProperty(_k,v){value=v}}}});
  const options={duration,ease:'linear',stagger:gap};
  const sequence=Array.from({length:steps},(_,i)=>[targets,{width:values.map(v=>v+i*(k-1))},options]);
  global.gc();global.gc();
  const before=process.memoryUsage().heapUsed,t=process.hrtime.bigint();
  const run=kind==='sequence'?apis[name].sequence(sequence):apis[name].animate(targets,{width:values},options);
  const startMs=Number(process.hrtime.bigint()-t)/1e6;
  run.pause();global.gc();global.gc();const retained=process.memoryUsage().heapUsed-before;
  try{
   assert.equal(run.duration,duration*steps+gap*(n-1));
   for(const time of [15,25,5]){run.seek(time);for(let i=0;i<n;i++)assert.equal(targets[i].style.getPropertyValue(),Math.max(0,(time-i*gap)/10)+'px')}
   run.finish();assert.deepEqual(await run.finished,{status:'finished'});
   for(const el of targets)assert.equal(el.style.getPropertyValue(),((k-1)*steps)+'px');
  }finally{run.stop()}
  if(round>=0){const row={kind,n,k,round,name,startMs,retained,...artifacts[name]};rows.push(row);console.log(JSON.stringify(row))}
 }
}
assert.deepEqual(fingerprints(),artifacts);
console.log(JSON.stringify({artifacts,node:process.version}));
for(const {kind,n,k} of cases)for(const name of names){const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.k===k&&x.name===name);console.log(JSON.stringify({summary:true,kind,n,k,name,startMs:med(r.map(x=>x.startMs)),retained:med(r.map(x=>x.retained))}))}
