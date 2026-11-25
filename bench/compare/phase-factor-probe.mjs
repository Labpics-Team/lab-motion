import { buildSync } from 'esbuild';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// Actual root numerical functions, bundled from an immutable source checkout.
const src=resolve(process.argv[2]??'.','src/motion').replaceAll('\\','/');
const code=buildSync({stdin:{contents:`export { program, sample } from "${src}/program.ts";export { timing } from "${src}/model.ts";`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false}).outputFiles[0].text;
const {program,sample,timing}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const n=1000, frames=360, duration=1000, delay=80, rate=.75;
const times=Array.from({length:frames},(_,i)=>(i*97)%1080);
times[0]=0;times[1]=delay;times[2]=duration+delay;
const rows=[];
const near=(a,b)=>Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*1e-12;
for(const ease of ['linear','standard']){
 const clock=timing({duration,ease,delay});
 const make=(a,b)=>program('width',{_coordinates:[a],_unit:'px'},[b],false,clock,[0]);
 const unit=program('x',{_coordinates:[0],_unit:''},[1],false,clock,[0]);
 const bindings=Array.from({length:n},(_,i)=>{const a=(i%97)-50,b=(i*19%297)-100;return {a,b,d:b-a,program:make(a,b),v:[0],dv:[0]};});
 const v=[0],dv=[0];
 // Derive the common normalized position and velocity once, then apply the
 // original sampler's arithmetic order for each binding. No cache lookup.
 const factored=t=>{
  sample(unit,t,v,dv);
  for(const b of bindings){
   b.v[0]=t<=delay?b.a:t>=duration+delay?b.b:b.a+b.d*v[0];
   b.dv[0]=t<=delay||t>=duration+delay?0:(b.d*dv[0])*rate;
  }
 };
 const baseline=t=>{for(const b of bindings)sample(b.program,t,b.v,b.dv,rate);};
 // Every binding at every sampled phase, including delay and terminal times.
 for(const t of times){
  baseline(t);const expected=bindings.map(b=>[b.v[0],b.dv[0]]);
  factored(t);
  for(let i=0;i<n;i++){const b=bindings[i];assert(near(b.v[0],expected[i][0])&&near(b.dv[0],expected[i][1]),JSON.stringify({ease,t,i,b,expected:expected[i]}));}
 }
 for(let round=-3;round<15;round++){
  const order=(round+Math.floor(round/2))%2?['factored','baseline']:['baseline','factored'];
  for(const name of order){
   let checksum=0;const fn=name==='baseline'?baseline:factored, start=performance.now();
   for(const t of times){fn(t);checksum+=bindings[(t|0)%n].v[0]+bindings[(t|0)%n].dv[0];}
   const ms=performance.now()-start;
   if(round>=0){const row={ease,round,name,ms,checksum,bindings:n,frames};rows.push(row);console.log(JSON.stringify(row));}
  }
 }
}
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
for(const ease of ['linear','standard'])for(const name of ['baseline','factored']){
 const r=rows.filter(x=>x.ease===ease&&x.name===name);
 console.log(JSON.stringify({summary:true,ease,name,ms:median(r.map(x=>x.ms))}));
}
