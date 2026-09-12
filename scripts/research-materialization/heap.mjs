import {spawnSync} from 'node:child_process';import fs from 'node:fs';
const raw=[];
function run(side,profile,count){const p=spawnSync(process.execPath,['--expose-gc','heap-worker.mjs',side,profile,String(count)],{encoding:'utf8',timeout:60000});if(p.status!==0)throw new Error(p.stderr||String(p.error));return JSON.parse(p.stdout);}
for(const profile of ['default','under','over','big','accept','degenerate'])for(let pair=0;pair<8;pair++)for(const side of(pair%2?['candidate','base']:['base','candidate'])){
 raw.push({pair,...run(side,profile,256)});fs.writeFileSync('evidence/heap-raw.json',JSON.stringify(raw));
}
const summaries=[];
for(const profile of ['default','under','over','big','accept','degenerate']){
 const p=raw.filter(r=>r.profile===profile),r={profile};
 for(const field of ['returnedDelta','consumedDelta']){
  const ratios=Array.from({length:8},(_,pair)=>p.find(x=>x.pair===pair&&x.side==='candidate')[field]/p.find(x=>x.pair===pair&&x.side==='base')[field]).sort((a,b)=>a-b);
  r[field]={ratios,median:(ratios[3]+ratios[4])/2,min:ratios[0],max:ratios[7]};
 }summaries.push(r);
}
const controls=[];
for(let pair=0;pair<8;pair++)controls.push({pair,a:run('base','default',256),aa:run('base','default',256),double:run('base','default',512)});
fs.writeFileSync('evidence/heap.json',JSON.stringify({raw,summaries,controls}));console.log(JSON.stringify(summaries,null,2));
