import {scenario} from './scenario.mjs';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
const run=process.argv[2]||'1';const count=Number(process.argv[3]||16);
const A=await import('./package/dist/animate/research-baseline.mjs');
const B=await import('./package/dist/animate/research-forward-release.mjs');
const cells=[...[1,100,1000].flatMap(n=>[0,1].map(stagger=>({name:`N${n}-stagger${stagger}`,n,stagger}))),{name:'N1000-stagger0.05',n:1000,stagger:.05}].map(c=>({...c,spring:{mass:1,stiffness:170,damping:26},times:Array.from({length:60},(_,i)=>i*1000/120)}));
const rows=[];
for(const c of cells)for(let i=0;i<6;i++){await scenario(A,c,{trace:false});await scenario(B,c,{trace:false});}
for(let block=0;block<count;block++){
 for(let cell=0;cell<cells.length;cell++){
  const c=cells[(cell+block)%cells.length];const order=block%2?'BAAB':'ABBA';const samples=[];
  for(const id of order){const r=await scenario(id==='A'?A:B,c,{trace:false});samples.push({id,...r.timing,observed:r.observed,drains:r.drains});}
  rows.push({block,cell:c.name,order,samples});
 }
 console.log(`run ${run} block ${block+1}/${count}`);
}
const digest=async p=>createHash('sha256').update(await readFile(new URL(p,import.meta.url))).digest('hex');
await writeFile(new URL(`paired-${run}.json`,import.meta.url),JSON.stringify({protocol:`${count} ABBA/BAAB blocks per cell; six warmups per variant/cell; full public animate start + 60 mock-host frames + cancel/settlement; diagnostic counters removed; no claim of DOM/paint cost`,node:process.version,v8:process.versions.v8,cpu:os.cpus()[0].model,platform:os.platform(),arch:os.arch(),cpus:os.availableParallelism(),baselineSha256:await digest('./package/dist/animate/research-baseline.mjs'),candidateSha256:await digest('./package/dist/animate/research-forward-release.mjs'),run,cells,rows},null,2));
