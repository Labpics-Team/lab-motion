import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const [base,candidate,out]=process.argv.slice(2);mkdirSync(out,{recursive:true});
const here=new URL('.',import.meta.url);
function run(script,args,gc=false){return JSON.parse(execFileSync(process.execPath,[...(gc?['--expose-gc']:[]),fileURLToPath(new URL(script,here)),...args],{encoding:'utf8',timeout:180000,maxBuffer:64*1024*1024}));}
const memory=[];
for(let block=0;block<12;block++){
 const order=block%2?['candidate','base']:['base','candidate'];const row={block,order};
 for(const id of order)row[id]=run('memory.mjs',[id==='base'?base:candidate,'100','10'],true);
 assert.equal(row.base.alive,1000,'baseline RED disappeared');assert.equal(row.candidate.alive,0,'candidate target retention');
 memory.push(row);writeFileSync(`${out}/memory.json`,JSON.stringify({rows:memory},null,2));
}
for(const [kind,blocks] of [['aa',8],['double',4],['ab',16]]){
 const rows=[];
 for(const count of [1,100,1000])for(let block=0;block<blocks;block++){
  const order=block%2?['candidate','base']:['base','candidate'];const row={kind,count,block,order};
  for(const id of order){
   const root=kind==='aa'?base:(id==='base'?base:candidate);
   const multiplier=kind==='double'&&id==='candidate'?'2':'1';
   row[id]=run('latency-worker.mjs',[root,String(count),multiplier,'60']);
  }
  rows.push(row);writeFileSync(`${out}/${kind}.json`,JSON.stringify({kind,blocks,rows},null,2));
  console.log(`${kind} N=${count} ${block+1}/${blocks}`);
 }
}
