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
try {
 for(const n of [100,1000])for(let round=-2;round<10;round++){
  const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
  for(const name of order){
   const page=await browser.newPage();
   try {
    await page.goto('http://127.0.0.1:'+server.address().port);
    const metrics=await page.evaluate(async({name,n})=>{
     const {animate}=await import('/'+name+'/motion/index.js');
     const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;';
     root.innerHTML='<div style="width:10px;height:10px;opacity:0"></div>'.repeat(n);
     document.body.append(root);const targets=[...root.children];root.getBoundingClientRect();
     const began=performance.now();const run=animate(targets,{x:100,opacity:1},{duration:1000,ease:'linear'});
     const startup=performance.now()-began;
     // Separate finalization from preparation and final layout/style validation.
     let writes=0;const original=CSSStyleDeclaration.prototype.setProperty;
     CSSStyleDeclaration.prototype.setProperty=function(...args){writes++;return original.apply(this,args)};
     const start=performance.now();
     try{run.finish();if((await run.finished).status!=='finished')throw Error('outcome');}
     finally{CSSStyleDeclaration.prototype.setProperty=original;}
     const finish=performance.now()-start;
     for(const el of targets){const css=getComputedStyle(el);
      if(Math.abs(new DOMMatrixReadOnly(css.transform).m41-100)>.02||Number(css.opacity)!==1||el.getAnimations().length)throw Error('terminal pose/cleanup');
     }
     return {startup,finish,writes,total:performance.now()-began};
    },{name,n});
    assert(Number.isFinite(metrics.finish));
    if(round>=0){const row={n,name,round,...metrics};rows.push(row);console.log(JSON.stringify(row))}
   }finally{await page.close();}
  }
 }
 const med=x=>x.sort((a,b)=>a-b)[Math.floor(x.length/2)];
 for(const n of [100,1000])for(const name of ['baseline','candidate']){
  const r=rows.filter(x=>x.n===n&&x.name===name);
  console.log(JSON.stringify({summary:true,n,name,...Object.fromEntries(['startup','finish','writes','total'].map(k=>[k,med(r.map(x=>x[k]))]))}))
 }
 console.error('Chrome '+browser.version()+', all final poses and cleanup verified');
}finally{await browser.close();server.close();}
