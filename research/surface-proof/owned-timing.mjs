import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pairedClusterBootstrap,applyHolmCorrection} from '../motion-pass/bench/compare/methodology.mjs';
const smoke=process.argv.includes('--smoke');
const profiles={default:{k:170,c:26,a:240,b:360,v:0},under:{k:170,c:9,a:240,b:360,v:0},over:{k:100,c:40,a:360,b:240,v:0},velocity:{k:170,c:26,a:40,b:360,v:1},big:{k:170,c:26,a:1,b:4096,v:0,large:true},'singular-reject':{k:170,c:9,a:960,b:80,v:0,fast:true,reject:true},'cap-reject':{k:170,c:26,a:1,b:4096,v:0,budget:.00883,large:true,reject:true}};
const definitions=[['default',true,false],['default',true,true],['under',true,false],['over',true,true],['velocity',false,true],['velocity',true,false],['big',false,false],['big',false,true],['big',true,false],['big',true,true],['singular-reject',false,true],['singular-reject',true,true],['cap-reject',false,false],['cap-reject',false,true],['cap-reject',true,false]];
const tasks=definitions.map(([name,cold,consumed])=>{const d=profiles[name];return {name:`producer/${name}/${cold?'cold-P':'warm-P'}/${consumed?'consume':'return'}`,kind:'producer',...d,cold,consumed,count:d.large?8:d.fast?256:cold?32:64};});
tasks.push({name:'public-transform/dynamic/parse-and-consume',kind:'dynamic',count:64,cold:false});
tasks.push({name:'control/A-A',kind:'control',...profiles.default,count:64,cold:false,consumed:true});
tasks.push({name:'control/two-calls',kind:'control',...profiles.default,count:64,cold:false,consumed:true});
assert.equal(tasks.length,18);
const plan={node:process.version,v8:process.versions.v8,cpu:os.cpus()[0].model,platform:process.platform,arch:process.arch,blocks:smoke?2:512,warmups:16,iterations:10000,smoke,forcedGC:false,oneHeapPerVariantAndProfile:true,tasks,scriptSha256:createHash('sha256').update(readFileSync(new URL('owned-worker.mjs',import.meta.url))).digest('hex')};
const prefix=smoke?'owned-smoke':'owned';
writeFileSync(new URL(prefix+'-plan.json',import.meta.url),JSON.stringify(plan,null,2));
function child(spec){
 const proc=spawn(process.execPath,[fileURLToPath(new URL('owned-worker.mjs',import.meta.url)),JSON.stringify(spec)],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:proc.stdout,crlfDelay:Infinity})[Symbol.asyncIterator]();
 let errors='';proc.stderr.on('data',s=>errors+=s);
 const exit=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('close',(code,signal)=>code===0?resolve():reject(Error(`worker exit ${code}/${signal}: ${errors}`)));});
 exit.catch(()=>{});
 const next=async()=>{const item=await lines.next();if(item.done){await exit;throw Error('unexpected EOF');}return JSON.parse(item.value);};
 return {next,run:async()=>{proc.stdin.write('r\n');const r=await next();assert.equal(typeof r.ns,'number');assert.ok(Number.isFinite(r.ns)&&r.ns>0);return r.ns;},close:async()=>{proc.stdin.end('q\n');const r=await next();assert.equal(r.done,true);await exit;return r;},kill:()=>proc.kill('SIGTERM')};
}
const rows=[];
for(const task of tasks){
 const a=child({...task,variant:'base'}),b=child({...task,variant:task.kind==='control'?'base':'candidate',twice:task.name==='control/two-calls'});
 try{
  const ar=await a.next(),br=await b.next();assert.ok(ar.ready&&br.ready);assert.notEqual(ar.pid,br.pid);
  assert.equal(ar.meta.semanticSha256,br.meta.semanticSha256);assert.equal(ar.meta.semantic,br.meta.semantic);
  for(let i=0;i<plan.warmups;i++){await a.run();await b.run();}
  const row={name:task.name,meta:{base:ar,candidate:br},base:[],candidate:[]};
  for(let block=0;block<plan.blocks;block++){
   const aa=[],bb=[];
   for(const side of block%2?['b','a','a','b']:['a','b','b','a'])(side==='a'?aa:bb).push(await(side==='a'?a:b).run());
   row.base.push({run:block,samples:aa,semantic:true});row.candidate.push({run:block,samples:bb,semantic:true});
  }
  row.final={base:await a.close(),candidate:await b.close()};rows.push(row);
  writeFileSync(new URL(prefix+'-raw.json',import.meta.url),JSON.stringify({plan,rows},null,2));console.log('raw-complete',task.name);
 }finally{a.kill();b.kill();}
}
if(!smoke){
 const summary=[];
 for(let i=0;i<rows.length;i++){
  const row=rows[i],result=pairedClusterBootstrap(row.candidate,row.base,{seed:20260911+i,iterations:10000});
  summary.push({name:row.name,...result});console.log(row.name,result.p50.ratio.toFixed(5),'p95hi',result.p95.high.toFixed(5));
  writeFileSync(new URL('owned-summary.json',import.meta.url),JSON.stringify(summary,null,2));
 }
 const holm=applyHolmCorrection(summary.filter(r=>!r.name.startsWith('control')).map(r=>({id:r.name,pValue:r.pValue})));
 writeFileSync(new URL('owned-holm.json',import.meta.url),JSON.stringify(holm,null,2));
 const remaining=summary.filter(r=>!r.name.startsWith('control')&&r.p95.high>1.05).map(r=>({name:r.name,p50:r.p50,p95:r.p95}));
 writeFileSync(new URL('owned-remaining.json',import.meta.url),JSON.stringify({remaining,notAuthoritativeCandidateCI:true,oldDataNotDiscarded:true},null,2));
}
