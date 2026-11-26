import { serveDist } from './serve-dist.mjs';
import { realpathSync } from 'node:fs';

import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const roots={baseline:realpathSync(process.argv[2]),candidate:realpathSync(process.argv[3])};
const server=await serveDist(roots);
const browser=await chromium.launch({channel:'chrome',headless:true});
const cases=[['native',1],['native',100],['native',1000],['scalar',1000],['mixed',1000],['authored',1000]];
const rows=[];
try{
 for(const [kind,n] of cases)for(let round=-2;round<10;round++){
  const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];let reference;
  for(const name of order){
   const page=await browser.newPage();
   try{
    await page.goto('http://127.0.0.1:'+server.address().port);
    const data=await page.evaluate(async({name,n,kind})=>{
     const {animate}=await import('/'+name+'/motion/index.js');
     const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1000px;height:1000px;';
     root.innerHTML='<div style="position:absolute;width:10px;height:10px;opacity:0"></div>'.repeat(n);
     document.body.append(root);const targets=[...root.children];
     const props=kind==='native'?{x:100,opacity:1}:kind==='scalar'?{width:100,height:200}:kind==='authored'?{width:[10,20,80,100],height:[10,30,90,200]}:{x:100,opacity:1,width:100,height:200};
     const opts={duration:1000,ease:'linear'};
     root.getBoundingClientRect();
     const warm=animate(targets,props,opts);warm.finish();await warm.finished;
     for(const el of targets){el.style.transform='none';el.style.opacity='0';el.style.width='10px';el.style.height='10px';}
     root.getBoundingClientRect();
     let clockReads=0,styleReads=0;
     const clock=performance.now.bind(performance),style=getComputedStyle;
     Object.defineProperty(performance,'now',{value:()=>{clockReads++;return clock()},configurable:true});
     window.getComputedStyle=(...args)=>{styleReads++;return style(...args)};
     const begin=clock();let run,startup;
     try{run=animate(targets,props,opts);startup=clock()-begin;}
     finally{delete performance.now;window.getComputedStyle=style;}
     const started=clockReads;
     run.pause();
     const poses=[];
     for(const time of [250,500,750]){
      run.seek(time);
      const pose=targets.map(el=>{
       const css=getComputedStyle(el),r=el.getBoundingClientRect();
       return [css.transform,css.opacity,r.width,r.height];
      });
      poses.push(pose);
     }
     const startFinish=clock();run.finish();if((await run.finished).status!=='finished')throw Error('completion');
     const finish=clock()-startFinish;
     for(const el of targets)if(el.getAnimations().length)throw Error('leaked native effect');
     poses.push(targets.map(el=>{const css=getComputedStyle(el),r=el.getBoundingClientRect();return [css.transform,css.opacity,r.width,r.height]}));
     return {startup,finish,clockReads:started,styleReads,poses};
    },{name,n,kind});
    const {poses,...metrics}=data;
    if(!reference)reference=poses;else assert.deepEqual(poses,reference);
    if(round>=0){const row={kind,n,round,name,...metrics};rows.push(row);console.log(JSON.stringify(row))}
   }finally{await page.close();}
  }
 }
 const med=x=>x.sort((a,b)=>a-b)[Math.floor(x.length/2)];
 for(const [kind,n] of cases)for(const name of ['baseline','candidate']){
  const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.name===name);
  console.log(JSON.stringify({summary:true,kind,n,name,...Object.fromEntries(['startup','finish','clockReads','styleReads'].map(k=>[k,med(r.map(x=>x[k]))]))}));
 }
 console.error('Chrome '+browser.version()+', exact observed poses and cleanup verified');
}finally{await browser.close();server.close();}
