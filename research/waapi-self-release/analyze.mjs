import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [repo,dir,out]=process.argv.slice(2);
const {pairedClusterBootstrap}=await import(pathToFileURL(`${repo}/bench/compare/methodology.mjs`));
const read=name=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
const result={memory:{},latency:{},pass:true};
const mem=read('memory').rows;
const median=xs=>{const a=[...xs].sort((x,y)=>x-y);const n=a.length;return n%2?a[n>>1]:(a[n/2-1]+a[n/2])/2;};
for(const id of ['base','candidate']){
 result.memory[id]={alive:median(mem.map(r=>r[id].alive)),retainedBytes:median(mem.map(r=>r[id].retained)),terminalHeap:median(mem.map(r=>r[id].terminal))};
}
result.memory.retainedRatio=result.memory.candidate.retainedBytes/result.memory.base.retainedBytes;
assert.equal(result.memory.base.alive,1000);assert.equal(result.memory.candidate.alive,0);if(!(result.memory.retainedRatio<0.8))result.pass=false;
for(const kind of ['aa','double','ab']){
 const file=read(kind);result.latency[kind]={};
 for(const count of [1,100,1000]){
  const rows=file.rows.filter(r=>r.count===count);const cell={};
  for(const metric of ['startNs','cancelNs','finishedNs']){
   const clusters=id=>rows.map((r,i)=>({run:i,samples:r[id].rows.map(x=>x[metric]),semantic:r[id].semantic.valid}));
   const e=pairedClusterBootstrap(clusters('candidate'),clusters('base'),{seed:20260912+count,iterations:10000});
   cell[metric]=e;
   if(kind==='aa'&&!(e.p50.low<=1&&e.p50.high>=1&&e.p95.high<=1.05))result.pass=false;
   if(kind==='double'&&!(e.p50.low>1.5))result.pass=false;
   if(kind==='ab'&&!(e.p95.high<=1.05))result.pass=false;
  }
  result.latency[kind][count]=cell;
 }
}
writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=2;
