import * as A from './base-probe.mjs';
import * as B from './candidate-probe.mjs';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import assert from 'node:assert/strict';
import {pairedClusterBootstrap,applyHolmCorrection} from '../motion-pass/bench/compare/methodology.mjs';
const req=createRequire(import.meta.url);
const {parse}=req('../motion-pass/node_modules/.pnpm/acorn@8.18.0/node_modules/acorn/dist/acorn.js');
const pa=req('../motion-macro-base/dist/compiler/vite/index.cjs').motionCompiler();
const pb=req('../motion-pass/dist/compiler/vite/index.cjs').motionCompiler();
const defs=[
 {name:'default',k:170,c:26,a:240,b:360,v:0},
 {name:'under',k:170,c:9,a:240,b:360,v:0},
 {name:'critical',k:100,c:20,a:240,b:360,v:0},
 {name:'over',k:100,c:40,a:360,b:240,v:0},
 {name:'velocity',k:170,c:26,a:40,b:360,v:1},
 {name:'big',k:170,c:26,a:1,b:4096,v:0,large:true},
 {name:'degenerate',k:170,c:26,a:240,b:240,v:0,fast:true},
 {name:'singular-reject',k:170,c:9,a:960,b:80,v:0,fast:true,reject:true},
 {name:'cap-reject',k:170,c:26,a:1,b:4096,v:0,budget:.00883,large:true,reject:true},
];
let checksum=0,last;
const readString=s=>{let h=0;for(let i=0;i<s.length;i++)h=(Math.imul(h,31)+s.charCodeAt(i))|0;return h;};
const consumeSurface=r=>r?readString(r.reciprocalEasing)+readString(r.blendEasing):1;
const consumeTransform=r=>r?readString(r.code)+readString(r.map.mappings):1;
const tasks=[];
for(const d of defs){
 const spring={mass:1,stiffness:d.k,damping:d.c};
 const args=[spring,d.a,d.b,undefined,d.budget,d.v];
 const a=A.compile(...args),b=B.compile(...args);
 assert.equal(!a,!!d.reject,d.name);assert.equal(!b,!!d.reject,d.name);
 if(a){assert.equal(a.durationMs,b.durationMs);assert.equal(a.easing,b.easing);}
 for(const cold of [false,true])for(const consumed of [false,true]){
  const count=d.large?8:d.fast?256:cold?32:64;
  const wrap=mod=>()=>{if(cold)mod.clear();return mod.compile(...args);};
  tasks.push({name:`producer/${d.name}/${cold?'cold-P':'warm-P'}/${consumed?'consume':'return'}`,count,a:wrap(A),b:wrap(B),consume:consumed?consumeSurface:()=>0,meta:{kind:'producer',...d,cold,consumed}});
 }
}
for(const [name,k,c,n,dynamic] of [['Surface1',170,26,1,false],['Surface8',170,26,8,false],['SurfaceUnder1',170,9,1,false],['dynamic',170,26,1,true]]){
 const code="import {animate} from '@labpics/motion/animate';export function play(el,w){"+Array.from({length:n},()=>`animate(el,{width:[240,${dynamic?'w':'360'}]},{layout:'project',spring:{mass:1,stiffness:${k},damping:${c}}});`).join('')+'}';
 const context={parse:text=>parse(text,{ecmaVersion:'latest',sourceType:'module'}),warn:text=>{throw Error(text);}};
 const a=()=>pa.transform.call(context,code,'fixture.js'),b=()=>pb.transform.call(context,code,'fixture.js');
 assert.equal(!!a(),!dynamic);assert.equal(!!b(),!dynamic);
 tasks.push({name:'public-transform/'+name+'/parse-and-consume',count:n===8?16:64,a,b,consume:consumeTransform,meta:{kind:'actual-dist-transform',name,k,c,n,dynamic}});
}
const controlArgs=[{mass:1,stiffness:170,damping:26},240,360];
const controlFn=()=>A.compile(...controlArgs);
tasks.push({name:'control/A-A',count:64,a:controlFn,b:controlFn,consume:consumeSurface,meta:{kind:'control'}});
tasks.push({name:'control/two-calls',count:64,a:controlFn,b:()=>{const first=controlFn();checksum+=consumeSurface(first);return controlFn();},consume:consumeSurface,meta:{kind:'control'}});
// Единственный заранее объявленный confirmatory набор: уже доказанные tails не повторяются.
const names=new Set([
'producer/default/cold-P/return','producer/default/cold-P/consume','producer/under/cold-P/return','producer/under/cold-P/consume','producer/critical/warm-P/consume','producer/over/cold-P/return','producer/over/cold-P/consume','producer/velocity/warm-P/return','producer/velocity/warm-P/consume','producer/velocity/cold-P/return','producer/big/warm-P/return','producer/big/warm-P/consume','producer/big/cold-P/return','producer/big/cold-P/consume','producer/degenerate/warm-P/return','producer/degenerate/warm-P/consume','producer/degenerate/cold-P/return','producer/degenerate/cold-P/consume','producer/singular-reject/warm-P/return','producer/singular-reject/warm-P/consume','producer/singular-reject/cold-P/consume','producer/cap-reject/warm-P/return','producer/cap-reject/warm-P/consume','producer/cap-reject/cold-P/return','producer/cap-reject/cold-P/consume','public-transform/Surface1/parse-and-consume','public-transform/dynamic/parse-and-consume','control/A-A','control/two-calls']);
const selected=tasks.filter(t=>names.has(t.name));assert.equal(selected.length,29);
const plan={node:process.version,v8:process.versions.v8,cpu:os.cpus()[0].model,platform:process.platform,arch:process.arch,blocks:512,warmups:16,iterations:10000,tasks:selected.map(({name,count,meta})=>({name,count,meta})),hashes:['base-probe.mjs','candidate-probe.mjs','../motion-macro-base/dist/compiler/vite/index.cjs','../motion-pass/dist/compiler/vite/index.cjs'].map(f=>({path:f,sha256:createHash('sha256').update(readFileSync(new URL(f,import.meta.url))).digest('hex')}))};
writeFileSync(new URL('timing-plan.json',import.meta.url),JSON.stringify(plan,null,2));
const run=(task,fn)=>{if(!task.meta.cold)fn();const start=process.hrtime.bigint();for(let i=0;i<task.count;i++){last=fn();checksum+=task.consume(last);checksum+=last?.durationMs??last?.code?.length??1;}return Number(process.hrtime.bigint()-start)/task.count;};
for(let round=0;round<plan.warmups;round++)for(const task of selected){run(task,task.a);run(task,task.b);}
const rows=selected.map(t=>({name:t.name,meta:t.meta,base:[],candidate:[]}));
for(let block=0;block<plan.blocks;block++){
 for(let position=0;position<selected.length;position++){
  const index=(block+position)%selected.length,task=selected[index],row=rows[index];const a=[],b=[];
  for(const side of block%2?['b','a','a','b']:['a','b','b','a'])(side==='a'?a:b).push(run(task,task[side]));
  row.base.push({run:block,samples:a,semantic:true});row.candidate.push({run:block,samples:b,semantic:true});
 }
}
writeFileSync(new URL('timing-raw.json',import.meta.url),JSON.stringify({plan,checksum,rows},null,2));console.log('raw-complete');
const summary=[];
for(let i=0;i<rows.length;i++){
 const row=rows[i],result=pairedClusterBootstrap(row.candidate,row.base,{seed:20260911+i,iterations:10000});
 summary.push({name:row.name,...result});console.log(row.name,result.p50.ratio.toFixed(4),'p95hi',result.p95.high.toFixed(4));
 writeFileSync(new URL('timing-summary.json',import.meta.url),JSON.stringify(summary,null,2));
}
const holm=applyHolmCorrection(summary.filter(r=>!r.name.startsWith('control')).map(r=>({id:r.name,pValue:r.pValue})));
writeFileSync(new URL('timing-holm.json',import.meta.url),JSON.stringify(holm,null,2));
const remaining=summary.filter(r=>!r.name.startsWith('control')&&r.p95.high>1.05).map(r=>({name:r.name,p95:r.p95}));
writeFileSync(new URL('remaining-proof.json',import.meta.url),JSON.stringify({remaining,authoritativeCandidateCI:false,notWorldRanking:true},null,2));
