import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const roots={baseline:realpathSync(process.argv[2]),candidate:realpathSync(process.argv[3])};
const server=createServer((req,res)=>{
 try {
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html>');}
  const [,name,...parts]=new URL(req.url,'http://localhost').pathname.split('/');
  const root=roots[name], file=realpathSync(resolve(root,...parts)), rel=relative(root,file);
  if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw Error('path');
  res.setHeader('Content-Type','text/javascript');res.end(readFileSync(file));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true});
const rows=[];
try{
 for(const n of [100,1000]){
  for(let round=-2;round<10;round++){
   let reference;
   const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
   for(const name of order){
    const page=await browser.newPage();
    try {
     await page.goto('http://127.0.0.1:'+server.address().port);
     const data=await page.evaluate(async({name,n})=>{
      let now=0, reads=0, serial=0;
      const realNow=performance.now.bind(performance), callbacks=new Map();
      Object.defineProperty(performance,'now',{value:()=>{reads++;return now},configurable:true});
      window.requestAnimationFrame=cb=>{const id=++serial;callbacks.set(id,cb);return id};
      window.cancelAnimationFrame=id=>callbacks.delete(id);
      const {animate}=await import('/'+name+'/motion/index.js');
      const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1000px;height:1000px;';
      for(let i=0;i<n;i++){const el=document.createElement('div');el.style.cssText='position:absolute;width:'+(i%53)+'px;height:'+(i%29)+'px';root.append(el);}
      document.body.append(root);const targets=[...root.children];root.getBoundingClientRect();
      const run=animate(targets,{width:100,height:200},{duration:2000,ease:'standard'});
      const startupReads=reads;
      const step=t=>{now=t;const current=[...callbacks.values()];callbacks.clear();for(const cb of current)cb(t)};
      const geometry=[];
      // Exact geometry at three selected frame phases; not in timed loop.
      for(const t of [250,500,750]){
        step(t);geometry.push(targets.map(el=>{const r=el.getBoundingClientRect();return [r.width,r.height]}));
      }
      reads=0;
      const start=realNow();
      for(let i=1;i<=120;i++)step(750+i*8);
      const ms=realNow()-start, frameReads=reads;
      const pose=targets.map(el=>{const r=el.getBoundingClientRect();return [r.width,r.height]});
      step(2000);
      if((await run.finished).status!=='finished')throw Error('completion');
      for(const el of targets){const r=el.getBoundingClientRect();if(r.width!==100||r.height!==200||el.getAnimations().length)throw Error('terminal geometry');}
      if(callbacks.size)throw Error('frame leak');
      return {ms,startupReads,frameReads,geometry,pose};
     },{name,n});
     const {ms,startupReads,frameReads,...observed}=data;
     if(!reference)reference=observed;else assert.deepEqual(observed,reference);
     if(round>=0){const row={n,round,name,ms,startupReads,frameReads};rows.push(row);console.log(JSON.stringify(row));}
    }finally{await page.close();}
   }
  }
 }
 const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
 for(const n of [100,1000])for(const name of ['baseline','candidate']){
  const r=rows.filter(x=>x.n===n&&x.name===name);
  console.log(JSON.stringify({summary:true,n,name,ms:med(r.map(x=>x.ms)),startupReads:med(r.map(x=>x.startupReads)),frameReads:med(r.map(x=>x.frameReads))}));
 }
 console.error('Chrome '+browser.version()+', exact geometry, natural completion and frame cleanup verified');
}finally{await browser.close();server.close();}
