import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { sha256File, hashFileTree } from './provenance.mjs';
const roots={baseline:realpathSync(process.argv[2]),candidate:realpathSync(process.argv[3])};
const fingerprints=()=>Object.fromEntries(Object.entries(roots).map(([k,v])=>[k,{entry:sha256File(resolve(v,'motion/index.js')),runtime:hashFileTree(v,f=>/\.(?:c?js|mjs)$/.test(f)).sha256}]));
const artifacts=fingerprints();
const server=createServer((req,res)=>{
 try {
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html>');}
  const [,name,...parts]=new URL(req.url,'http://localhost').pathname.split('/');
  const root=roots[name],file=realpathSync(resolve(root,...parts)),rel=relative(root,file);
  if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw Error('path');
  res.setHeader('Content-Type','text/javascript');res.end(readFileSync(file));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true});
const cases=[['reduced',100],['reduced',1000],['system',1000],['sequence',200],['normal',100],['normal',1000]];
const rows=[];
try{
 for(const [kind,n] of cases)for(let round=-2;round<10;round++){
  const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];let reference;
  for(const name of order){
   const page=await browser.newPage({reducedMotion:kind==='system'?'reduce':'no-preference'});
   try{
    await page.goto('http://127.0.0.1:'+server.address().port);
    const data=await page.evaluate(async({name,n,kind})=>{
     const {animate,sequence}=await import('/'+name+'/motion/index.js');
     const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1000px;height:1000px;';
     const targets=[];
     for(let i=0;i<n;i++){const el=document.createElement('div');el.style.cssText='position:absolute;width:'+(i+1)+'px;height:10px';root.append(el);targets.push(el)}
     document.body.append(root);root.getBoundingClientRect();
     const props={width:1500};
     const opts={spring:{mass:1,stiffness:170,damping:26},...(kind==='reduced'?{reducedMotion:'always'}:{})};
     const t=performance.now(),run=kind==='sequence'?sequence([[targets,props,opts],[targets,{width:2000},opts]],{reducedMotion:'always'}):animate(targets,props,opts);
     const startup=performance.now()-t, state=run.state,duration=run.duration;
     const poses=[];
     if(kind==='normal'){
      run.pause();
      for(const t of [duration*.125,duration*.375,duration*.625]){run.seek(t);poses.push(targets.map(el=>el.style.width));}
      run.finish();
     }else if(state!=='finished'||duration!==0)throw Error('not synchronously reduced');
     const result=await run.finished;
     if(result.status!=='finished'||targets.some(el=>el.style.width!==(kind==='sequence'?'2000px':'1500px')||el.getAnimations().length))throw Error('end/cleanup mismatch');
     return {startup,state,duration,poses};
    },{name,n,kind});
    const {startup,...semantic}=data;
    if(!reference)reference=semantic;else assert.deepEqual(semantic,reference);
    if(round>=0){const row={kind,n,round,name,startup,entrySha256:artifacts[name].entry,runtimeSha256:artifacts[name].runtime};rows.push(row);console.log(JSON.stringify(row))}
   }finally{await page.close();}
  }
 }
 assert.deepEqual(fingerprints(),artifacts);
 console.log(JSON.stringify({artifacts,chrome:browser.version(),node:process.version}));
 const med=x=>x.sort((a,b)=>a-b)[Math.floor(x.length/2)];
 for(const [kind,n] of cases)for(const name of ['baseline','candidate']){
  const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.name===name);
  console.log(JSON.stringify({summary:true,kind,n,name,startup:med(r.map(x=>x.startup))}));
 }
}finally{await browser.close();server.close();}
