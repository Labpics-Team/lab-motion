import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
if(!global.gc)throw Error('Run with --expose-gc');
const apis=Object.fromEntries(await Promise.all(['baseline','candidate'].map(async(name,i)=>[name,await import(pathToFileURL(resolve(process.argv[i+2],'motion/index.js')))])));
const cases=[['scalar',100],['scalar',1000],['transform',1000],['color',1000],['authored',1000]];
const rows=[];
for(const [kind,n] of cases)for(let round=-2;round<10;round++){
 const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];let reference;
 for(const name of order){
  const targets=Array.from({length:n},(_,i)=>{
   const values={width:(i%19)+'px',height:(i%13)+'px',color:'rgb(0,0,0)',transform:'none'};
   return {style:{getPropertyValue(k){return values[k]??''},setProperty(k,v){values[k]=v}}};
  });
  const props=kind==='scalar'?{width:100,height:200}:kind==='transform'?{x:100,y:200,rotate:45,scale:1.25}:kind==='color'?{color:'#fff'}:{width:[0,20,80,100]};
  const keys=kind==='transform'?['transform']:Object.keys(props);
  global.gc();global.gc();
  const before=process.memoryUsage().heapUsed,start=performance.now();
  const run=apis[name].animate(targets,props,{duration:1000,ease:'standard'});
  const startup=performance.now()-start;
  run.pause();global.gc();global.gc();const retained=process.memoryUsage().heapUsed-before;
  const poses=[];
  for(const t of [125,750,250]){
   run.seek(t);poses.push(targets.map(el=>keys.map(key=>el.style.getPropertyValue(key))));
  }
  const begun=performance.now();
  for(let i=0;i<120;i++)run.seek(1+(i*83)%999);
  const seek=performance.now()-begun;
  poses.push(targets.map(el=>keys.map(key=>el.style.getPropertyValue(key))));
  run.finish();assert.deepEqual(await run.finished,{status:'finished'});
  poses.push(targets.map(el=>keys.map(key=>el.style.getPropertyValue(key))));
  if(!reference)reference=poses;else assert.deepEqual(poses,reference);
  if(round>=0){const row={kind,n,round,name,startup,retained,seek};rows.push(row);console.log(JSON.stringify(row))}
 }
}
const med=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
for(const [kind,n] of cases)for(const name of ['baseline','candidate']){
 const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.name===name);
 console.log(JSON.stringify({summary:true,kind,n,name,...Object.fromEntries(['startup','retained','seek'].map(k=>[k,med(r.map(x=>x[k]))]))}));
}
