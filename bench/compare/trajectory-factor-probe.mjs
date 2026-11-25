import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {nodeCases,nodeRounds,warmupRounds} from './trajectory-factor-cases.mjs';
if(!global.gc)throw Error('Run with --expose-gc');
const apis=Object.fromEntries(await Promise.all(['baseline','candidate'].map(async (name,i)=>[name,await import(pathToFileURL(resolve(process.argv[i+2],'motion/index.js')))])));
const rows=[];
for(const [n,k] of nodeCases) {
 for(let round=-warmupRounds;round<nodeRounds;round++){
  const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
  for(const name of order){
   const values=Array.from({length:k},(_,i)=>i);
   const targets=Array.from({length:n},()=>{let value='0px';return {style:{getPropertyValue(){return value},setProperty(_k,v){value=v}}}});
   global.gc();global.gc();
   const before=process.memoryUsage().heapUsed, started=process.hrtime.bigint();
   const run=apis[name].animate(targets,{width:values},{duration:(k-1)*10,ease:'linear'});
   const startMs=Number(process.hrtime.bigint()-started)/1e6;
   run.pause();
   global.gc();global.gc();
   const retained=process.memoryUsage().heapUsed-before;
   for(const time of [15,25,5]){run.seek(time);for(const el of targets)assert.equal(el.style.getPropertyValue(),(time/10)+'px')}
   run.finish();assert.deepEqual(await run.finished,{status:'finished'});
   for(const el of targets)assert.equal(el.style.getPropertyValue(),(k-1)+'px');
   if(round>=0){const row={n,k,round,name,startMs,retained};rows.push(row);console.log(JSON.stringify(row))}
  }
 }
}
const med=x=>x.sort((a,b)=>a-b)[Math.floor(x.length/2)];
for(const [n,k] of nodeCases)for(const name of ['baseline','candidate']){
 const r=rows.filter(x=>x.n===n&&x.k===k&&x.name===name);
 console.log(JSON.stringify({summary:true,n,k,name,startMs:med(r.map(x=>x.startMs)),retained:med(r.map(x=>x.retained))}));
}
