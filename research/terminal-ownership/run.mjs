import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const [base,candidate,support,out]=process.argv.slice(2);
mkdirSync(out,{recursive:true});
const worker=(name,args,gc=false)=>JSON.parse(execFileSync(process.execPath,[...(gc?['--expose-gc']:[]),fileURLToPath(new URL(name,import.meta.url)),...args],{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024}));
const memory=[];
for(let block=0;block<12;block++)for(const[calls,count]of[[100,10],[1000,1]])for(const stage of['active','terminal']){
 const row={block,calls,count,stage,order:block%2?['candidate','base']:['base','candidate']};
 for(const id of row.order)row[id]=worker('memory.mjs',[id==='base'?base:candidate,stage,String(calls),String(count)],true);
 assert.equal(row.base.alive,1000);assert.equal(row.candidate.alive,stage==='active'?1000:0);
 memory.push(row);writeFileSync(`${out}/memory.json`,JSON.stringify({blocks:12,rows:memory}));
}
for(const[kind,blocks]of[['aa',8],['double',4],['ab',16]]){
 const rows=[];
 for(let run=0;run<blocks;run++){
  const row={run,kind,order:run%2?['candidate','base']:['base','candidate']};
  for(const id of row.order){
   const root=id==='base'||kind!=='ab'?base:candidate;
   const multiplier=kind==='double'&&id==='candidate'?'2':'1';
   const main=worker('lifecycle.mjs',[root,support,multiplier]);
   const waapi=worker('waapi.mjs',[root,support,multiplier]);
   row[id]={main,waapi};
  }
  rows.push(row);writeFileSync(`${out}/${kind}.json`,JSON.stringify({blocks,kind,rows}));
  console.log(`${kind}: ${run+1}/${blocks}`);
 }
}
