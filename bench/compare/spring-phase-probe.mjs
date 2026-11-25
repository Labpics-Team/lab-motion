import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const apis=Object.fromEntries(await Promise.all(['baseline','candidate'].map(async(name,i)=>[name,await import(pathToFileURL(resolve(process.argv[i+2],'motion/index.js')))])));
const cases=[['identical',1],['identical',1000],['heterogeneous',1000],['analytic',1000],['cold',200]];
const rows=[];
for(const [kind,n] of cases)for(let round=-2;round<10;round++){
 const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];let reference;
 for(const name of order){
  const targets=Array.from({length:n},(_,i)=>{
   const initial=kind==='identical'?0:kind==='analytic'?i*4000:i%97;
   const values={width:initial+'px',height:initial+'px'};
   return {style:{getPropertyValue(k){return values[k]??''},setProperty(k,v){values[k]=v}}};
  });
  const end=kind==='analytic'?1e7:100, opts={spring:{mass:1,stiffness:170+(kind==='cold'?(round+2)*.013:0),damping:26}};
  const start=performance.now(),run=apis[name].animate(targets,{width:end,height:end},opts),startup=performance.now()-start;
  run.pause(); const duration=run.duration;
  const pose=()=>targets.map(el=>['width','height'].map(k=>el.style.getPropertyValue(k)));
  const samples=[];
  for(const fraction of [.125,.375,.625,.25]){run.seek(duration*fraction);samples.push(pose())}
  const t=performance.now();
  for(let i=0;i<120;i++)run.seek(duration*(.02+((i*83)%950)/1000));
  const seek=performance.now()-t; samples.push(pose());
  run.finish();assert.deepEqual(await run.finished,{status:'finished'});
  for(const el of targets)for(const k of ['width','height'])assert.equal(el.style.getPropertyValue(k),end+'px');
  if(!reference)reference={duration,samples};else assert.deepEqual({duration,samples},reference);
  if(round>=0){const row={kind,n,round,name,startup,seek,duration};rows.push(row);console.log(JSON.stringify(row))}
 }
}
const med=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
for(const [kind,n] of cases)for(const name of ['baseline','candidate']){
 const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.name===name);
 console.log(JSON.stringify({summary:true,kind,n,name,...Object.fromEntries(['startup','seek','duration'].map(k=>[k,med(r.map(x=>x[k]))]))}));
}
