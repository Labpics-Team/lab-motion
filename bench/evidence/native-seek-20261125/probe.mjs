import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const roots = { baseline: realpathSync(process.argv[2]), candidate: realpathSync(process.argv[3]) };
const server = createServer((req,res)=>{
  try {
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html><body></body></html>');}
    const [,name,...parts] = new URL(req.url,'http://localhost').pathname.split('/');
    const root=roots[name]; const file=realpathSync(resolve(root,...parts));
    const rel=relative(root,file); if(rel.startsWith('..')||isAbsolute(rel))throw Error('path');
    res.setHeader('Content-Type','text/javascript'); res.end(readFileSync(file));
  }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-timer-throttling']});
try {
 const page=await browser.newPage();
 await page.goto('http://127.0.0.1:'+server.address().port);
 const rows=[];
 for(const [kind,n] of [['start',1],['start',100],['start',1000],['repeat',1],['repeat',100],['seek',1],['seek',100],['frames',100],['frames',1000],['spring',100],['keyframes',1000]]) {
  const samples={baseline:[],candidate:[]};
  for(let round=-2;round<8;round++){
   const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
   for(const name of order){
    const sample=await page.evaluate(async({kind,n,name})=>{
      const {animate}=await import('/'+name+'/motion/index.js');
      const root=document.createElement('div');
      root.style.cssText='position:absolute;left:0;top:0;contain:layout style paint;';
      root.innerHTML='<div style="width:10px;height:10px;opacity:0"></div>'.repeat(n);
      document.body.append(root);
      const targets=[...root.children];
      root.getBoundingClientRect();
      const native=Element.prototype.animate; let effects=0;
      Element.prototype.animate=function(...args){effects++;return native.apply(this,args)};
      let run; const start=performance.now(); let ready, main;
      const linear={duration:1000,ease:'linear'};
      try {
       if(kind==='start') {
        run=animate(targets,{x:100,opacity:1},linear); ready=performance.now()-start;
       } else if(kind==='repeat') {
        run=animate(targets,{x:100},linear); ready=performance.now()-start;
        for(let j=0;j<100;j++){run=animate(targets,{x:100},linear);}
       } else if(kind==='seek') {
        run=animate(targets,{x:[0,100],opacity:[0,1]},linear);ready=performance.now()-start;
        for(let j=0;j<60;j++){
         let t=(j*71)%900+25;run.seek(t);
         const computed=new DOMMatrixReadOnly(getComputedStyle(targets[n-1]).transform).m41;
         if(Math.abs(computed-t/10)>0.15)throw Error('seek '+computed+' '+t);
        }
       } else if(kind==='frames') {
        run=animate(targets,{width:[10,110],height:[10,110],opacity:[0,1]},{duration:1000,ease:t=>t});
        run.pause();ready=performance.now()-start;
        for(let j=0;j<60;j++){let t=(j*71)%900+25;run.seek(t);const width=targets[n-1].getBoundingClientRect().width;
          if(Math.abs(width-(10+t/10))>.02)throw Error('width '+width+' '+t);}
       } else if(kind==='spring') {
        run=animate(targets,{x:100,opacity:1}); ready=performance.now()-start;
       } else {
        const values=Array.from({length:257},(_,i)=>i);
        run=animate(targets.slice(0,100),{width:values},linear);ready=performance.now()-start;
       }
       main=performance.now()-start;
       run.finish(); const result=await run.finished;
       if(result.status!=='finished')throw Error('status '+result.status);
       const count=kind==='keyframes'?100:n;
       for(let k=0;k<count;k++){
        const el=targets[k],cs=getComputedStyle(el);
        if(kind==='frames'||kind==='keyframes'){
          const width=el.getBoundingClientRect().width;if(width!==(kind==='frames'?110:256))throw Error('final width '+width);
        }else{
          const x=new DOMMatrixReadOnly(cs.transform).m41;if(Math.abs(x-100)>.02)throw Error('final x '+x);
          if((kind==='start'||kind==='spring'||kind==='seek')&&Number(cs.opacity)!==1)throw Error('opacity');
        }
        if(el.getAnimations().length)throw Error('effects leaked');
       }
       return {ready,main,total:performance.now()-start,effects};
      }finally{Element.prototype.animate=native;run?.stop();root.remove();}
    },{kind,n,name});
    if(round>=0)samples[name].push(sample);
   }
  }
  const med=(a,k)=>a.map(x=>x[k]).sort((a,b)=>a-b)[Math.floor(a.length/2)];
  const row={kind,n,baseline:Object.fromEntries(['ready','main','total','effects'].map(k=>[k,med(samples.baseline,k)])),candidate:Object.fromEntries(['ready','main','total','effects'].map(k=>[k,med(samples.candidate,k)])),samples};
  rows.push(row);
  console.log(JSON.stringify(row));
 }
 console.error('Chrome',browser.version(),'all geometry, completion and cleanup checks passed');
} finally {await browser.close();server.close();}
