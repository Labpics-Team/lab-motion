import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { serveDist } from './serve-dist.mjs';
import { sha256File, hashFileTree, sha256Bytes } from './provenance.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url);
const esbuild=require('esbuild');
const roots={base:realpathSync(process.argv[2]),lab:realpathSync(process.argv[3])};
const mode=process.argv[4]??'compare';
const fingerprint=()=>Object.fromEntries(Object.entries(roots).map(([k,p])=>[k,{entry:sha256File(resolve(p,'motion/index.js')),runtime:hashFileTree(p,f=>/\.(?:c?js|mjs)$/.test(f)).sha256}]));
const artifacts=fingerprint();
const entry=(id,contents,resolveDir)=>esbuild.buildSync({stdin:{contents,resolveDir,sourcefile:id+'.mjs'},bundle:true,minify:true,platform:'browser',target:'es2022',format:'iife',globalName:'adapter',write:false}).outputFiles[0].text;
const source=id=>id==='motion'?`import {animate,stagger} from 'motion';export function start(els,px,ms,gap){const c=animate(els,{x:px},{duration:ms/1000,ease:'linear',...(gap?{delay:stagger(gap/1000)}:{})});return {finished:c.finished,cancel:()=>c.cancel?c.cancel():c.stop()}}`:
id==='raw'?`export function start(els,px,ms,gap){const a=els.map((el,i)=>el.animate([{transform:'translate(0px,0px)'},{transform:'translate('+px+'px,0px)'}],{duration:ms,delay:i*gap,easing:'linear',fill:'both'}));return {finished:Promise.all(a.map(x=>x.finished)),cancel:()=>{for(const x of a)x.cancel()}}}`:
`import {animate} from ${JSON.stringify(resolve(roots[id],'motion/index.js'))};export function start(els,px,ms,gap){const c=animate(els,{x:px},{duration:ms,ease:'linear',stagger:gap});return {finished:c.finished,cancel:()=>c.stop()}}`;
const ids=mode==='compare'?['base','motion','raw']:['base','lab','motion','raw'];
const adapters=Object.fromEntries(ids.map(id=>[id,entry(id,source(id),resolve(root,'bench/compare'))]));
const vendor=realpathSync(resolve(root,'bench/compare/node_modules/motion'));
const provenance={artifacts,adapters:Object.fromEntries(Object.entries(adapters).map(([k,v])=>[k,sha256Bytes(v)])),motion:{version:JSON.parse(readFileSync(resolve(vendor,'package.json'),'utf8')).version,tree:hashFileTree(vendor).sha256},node:process.version};
const server=await serveDist(roots),browser=await chromium.launch({channel:'chrome',headless:true});
const cases=[['cold',100],['cold',1000],['warm',1000],['stagger',200]];
const rows=[],med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
try{
 for(const [kind,n] of cases)for(let r=-2;r<8;r++){
  const order=ids.map((_,i)=>ids[(i+(r+2))%ids.length]);
  if(Math.floor((r+2)/ids.length)%2)order.reverse();
  for(const id of order){
   const page=await browser.newPage({viewport:{width:1200,height:700},reducedMotion:'no-preference'}),cdp=await page.context().newCDPSession(page);
   try{
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.addScriptTag({content:adapters[id]});
    await page.evaluate(async({n,kind})=>{
     const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1100px;height:600px;';
     root.innerHTML=Array.from({length:n},(_,i)=>'<div style="position:absolute;left:'+(i%50*14)+'px;top:'+Math.floor(i/50)*14+'px;width:8px;height:8px;background:#d33;"></div>').join('');
     document.body.append(root);const targets=[...root.children];
     if(kind==='warm'){const warm=targets.map(el=>{const copy=el.cloneNode();root.append(copy);return copy});const c=adapter.start(warm,300,40,0);await c.finished;c.cancel();for(const el of warm)el.remove();}
     root.getBoundingClientRect();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
     const counts={styles:0,transformReads:0,writes:0,effects:0};
     const styles=window.getComputedStyle, read=CSSStyleDeclaration.prototype.getPropertyValue, write=CSSStyleDeclaration.prototype.setProperty, animate=Element.prototype.animate;
     window.getComputedStyle=function(...args){counts.styles++;return Reflect.apply(styles,this,args)};
     CSSStyleDeclaration.prototype.getPropertyValue=function(k){if(k==='transform')counts.transformReads++;return Reflect.apply(read,this,[k])};
     CSSStyleDeclaration.prototype.setProperty=function(...args){counts.writes++;return Reflect.apply(write,this,args)};
     Element.prototype.animate=function(...args){counts.effects++;return Reflect.apply(animate,this,args)};
     window.measure={root,targets,counts,styles,read,write,animate};
    },{n,kind});
    await cdp.send('Performance.enable',{timeDomain:'threadTicks'});
    const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const before=await metrics();
    const result=await page.evaluate(async({kind,n})=>{
     const m=window.measure,t=performance.now(),ms=400,gap=kind==='stagger'?2:0,c=adapter.start(m.targets,300,ms,gap);
     const apiMs=performance.now()-t,atReturn={...m.counts};
     let timer;try{await Promise.race([c.finished,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('completion watchdog')),10000)})]);}finally{clearTimeout(timer)}
     const completionMs=performance.now()-t;
     const counts={...m.counts};
     window.getComputedStyle=m.styles;CSSStyleDeclaration.prototype.getPropertyValue=m.read;CSSStyleDeclaration.prototype.setProperty=m.write;Element.prototype.animate=m.animate;
     window.measure.control=c;
     return {apiMs,completionMs,atReturn,counts};
    },{kind,n});
    const after=await metrics();
    const final=await page.evaluate(()=>{const m=window.measure;const positions=m.targets.map(el=>new DOMMatrixReadOnly(getComputedStyle(el).transform).e);m.control.cancel();m.root.remove();return {maxError:Math.max(...positions.map(x=>Math.abs(x-300))),effects:document.getAnimations().length}});
    assert(result.completionMs>=350&&result.counts.effects>=n&&final.maxError<=.05&&final.effects===0,JSON.stringify({id,kind,n,final}));
    if(r>=0){const row={kind,n,r,id,...result,taskMs:1000*(after.TaskDuration-before.TaskDuration),scriptMs:1000*(after.ScriptDuration-before.ScriptDuration),styleMs:1000*(after.RecalcStyleDuration-before.RecalcStyleDuration),final};rows.push(row);console.log(JSON.stringify(row))}
   }finally{await page.close()}
  }
 }
 assert.deepEqual(fingerprint(),artifacts);
 console.log(JSON.stringify({provenance,chrome:browser.version(),mode}));
 for(const [kind,n] of cases)for(const id of ids){const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.id===id);console.log(JSON.stringify({summary:true,kind,n,id,...Object.fromEntries(['apiMs','completionMs','taskMs','scriptMs','styleMs'].map(k=>[k,med(r.map(x=>x[k]))])),atReturn:r[0].atReturn,counts:r[0].counts}))}
}finally{await browser.close();server.close()}
