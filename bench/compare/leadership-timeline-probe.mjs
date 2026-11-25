import { realpathSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveDist } from './serve-dist.mjs';
import { sha256Bytes, sha256File, hashFileTree } from './provenance.mjs';
const roots={base:realpathSync(process.argv[2]),lab:realpathSync(process.argv[3])};
const require=createRequire(import.meta.url),esbuild=require('esbuild');
const ids=['base','lab','motion','raw'];
const frames=[0,80,-20,100],times=[0,.2,.7,1],duration=600;
const source=id=>id==='motion'?`import {animate} from 'motion';export function start(els,frames,times,duration){const c=animate(els,{x:frames},{times,duration:duration/1000,ease:'linear'});return {finished:c.finished,pause:()=>c.pause(),seek:t=>{c.time=t/1000},cancel:()=>c.stop()}}`:
id==='raw'?`export function start(els,frames,times,duration){const effects=els.map(el=>el.animate(frames.map((x,i)=>({transform:'translateX('+x+'px)',offset:times[i]})),{duration,easing:'linear',fill:'both'}));return {finished:Promise.all(effects.map(e=>e.finished)),pause:()=>effects.forEach(e=>e.pause()),seek:t=>effects.forEach(e=>e.currentTime=t),cancel:()=>effects.forEach(e=>e.cancel())}}`:
`import {animate} from ${JSON.stringify(resolve(roots[id],'motion/index.js'))};export function start(els,frames,times,duration){const c=animate(els,{x:frames},{times,duration,ease:'linear'});return {finished:c.finished,pause:()=>c.pause(),seek:t=>c.seek(t),cancel:()=>c.stop()}}`;
const adapters=Object.fromEntries(ids.map(id=>[id,esbuild.buildSync({stdin:{contents:source(id),resolveDir:import.meta.dirname,sourcefile:id+'.mjs'},bundle:true,minify:true,platform:'browser',target:'es2022',format:'iife',globalName:'adapter',write:false}).outputFiles[0].text]));
const fp=()=>Object.fromEntries(Object.entries(roots).map(([k,v])=>[k,{entry:sha256File(resolve(v,'motion/index.js')),runtime:hashFileTree(v,f=>/\.(?:c?js|mjs)$/.test(f)).sha256}]));
const artifacts=fp(),vendor=realpathSync(resolve(import.meta.dirname,'node_modules/motion'));
const server=await serveDist(roots),browser=await chromium.launch({channel:'chrome',headless:true});
const rows=[],med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const pageFor=async(id,n)=>{
 const page=await browser.newPage({viewport:{width:1200,height:700},reducedMotion:'no-preference'});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.addScriptTag({content:adapters[id]});
 await page.evaluate(n=>{const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1100px;height:600px;';
 root.innerHTML=Array.from({length:n},(_,i)=>'<div style="position:absolute;left:'+(i%50*14)+'px;top:'+Math.floor(i/50)*14+'px;width:8px;height:8px;background:#d33"></div>').join('');
 document.body.append(root);window.targets=[...root.children];root.getBoundingClientRect()},n);
 return page;
};
try{
 for(const id of ids){
  const page=await pageFor(id,100);
  try{await page.evaluate(async({frames,times,duration,id})=>{
   const run=adapter.start(targets,frames,times,duration);
   // Some vendors schedule effect creation; wait for first display before seek.
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));run.pause();
   const expected=t=>t<=120?80*t/120:t<=420?80-100*(t-120)/300:-20+120*(t-420)/180;
   for(const t of [60,120,270,420,510,300]){
    run.seek(t);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    for(const el of targets){const x=new DOMMatrixReadOnly(getComputedStyle(el).transform).e;if(Math.abs(x-expected(t))>.2)throw Error(id+' expected '+expected(t)+' actual '+x)}
   }
   run.cancel();targets.forEach(el=>el.remove());if(document.getAnimations().length)throw Error('cleanup');
  },{frames,times,duration,id});console.log(JSON.stringify({semantic:id,pass:true}));}finally{await page.close()}
 }
 for(const n of [100,500])for(let round=-1;round<8;round++){
  const order=ids.map((_,i)=>ids[(i+round+4)%4]);
  for(const id of order){
   const page=await pageFor(id,n),cdp=await page.context().newCDPSession(page);
   try{
    await page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const raf=requestAnimationFrame;window.rafCount=0;window.requestAnimationFrame=cb=>{window.rafCount++;return raf.call(window,cb)}});
    await cdp.send('Performance.enable',{timeDomain:'threadTicks'});const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));const before=await metrics();
    const data=await page.evaluate(async({frames,times,duration})=>{
     const t=performance.now(),run=adapter.start(targets,frames,times,duration),apiMs=performance.now()-t;
     let watchdog;try{await Promise.race([run.finished,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error('completion watchdog')),10000)})]);}finally{clearTimeout(watchdog)}
     const completionMs=performance.now()-t;window.run=run;return {apiMs,completionMs,raf:window.rafCount};
    },{frames,times,duration});
    const after=await metrics();
    const final=await page.evaluate(()=>{const maxError=Math.max(...targets.map(el=>Math.abs(new DOMMatrixReadOnly(getComputedStyle(el).transform).e-100)));run.cancel();targets.forEach(el=>el.remove());return {maxError,effects:document.getAnimations().length}});
    assert(data.completionMs>=550&&final.maxError<=.2&&final.effects===0,JSON.stringify({id,n,data,final}));
    if(round>=0){const row={n,round,id,...data,taskMs:1000*(after.TaskDuration-before.TaskDuration),styleMs:1000*(after.RecalcStyleDuration-before.RecalcStyleDuration),final};rows.push(row);console.log(JSON.stringify(row))}
   }finally{await page.close()}
  }
 }
 assert.deepEqual(fp(),artifacts);
 console.log(JSON.stringify({artifacts,adapters:Object.fromEntries(Object.entries(adapters).map(([k,v])=>[k,sha256Bytes(v)])),motion:{version:JSON.parse(readFileSync(resolve(vendor,'package.json'),'utf8')).version,tree:hashFileTree(vendor).sha256},chrome:browser.version(),node:process.version}));
 for(const n of [100,500])for(const id of ids){const r=rows.filter(x=>x.n===n&&x.id===id);console.log(JSON.stringify({summary:true,n,id,...Object.fromEntries(['apiMs','completionMs','raf','taskMs','styleMs'].map(k=>[k,med(r.map(x=>x[k]))]))}))}
}finally{await browser.close();server.close()}
