import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright';
import {browserCases,browserRounds,warmupRounds} from './trajectory-factor-cases.mjs';
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
const tasks=browserCases;
try {
 for(const [kind,n,k] of tasks){
  for(let round=-warmupRounds;round<browserRounds;round++){
   const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
   for(const name of order){
    const page=await browser.newPage();
    const cdp=await page.context().newCDPSession(page);
    try {
     await page.goto('http://127.0.0.1:'+server.address().port);
     await page.evaluate(async({name,n,k,kind})=>{
      const {animate}=await import('/'+name+'/motion/index.js');
      const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1000px;height:700px;';
      root.innerHTML='<div style="position:absolute;width:0px;height:2px;opacity:0"></div>'.repeat(n);document.body.append(root);
      const targets=[...root.children], props=kind==='to'?{x:100,opacity:1}:{width:Array.from({length:k},(_,i)=>i)}, duration=kind==='to'?1000:(k-1)*10;
      const opts={duration,ease:'linear'};
      // Warm the same declaration shape on separate elements; do not retain the warmup.
      const warm=animate(targets,props,opts);warm.finish();await warm.finished;
      for(const el of targets){el.style.width='0px';el.style.transform='none';el.style.opacity='0';}
      root.getBoundingClientRect();
      globalThis.factor={animate,targets,props,opts,kind,k};
     },{name,n,k,kind});
     await cdp.send('HeapProfiler.collectGarbage');
     const before=await cdp.send('Runtime.getHeapUsage');
     const startup=await page.evaluate(()=>{
      const f=globalThis.factor,t=performance.now();
      const run=f.animate(f.targets,f.props,f.opts);
      const startMs=performance.now()-t;
      run.pause();f.run=run;return startMs;
     });
     await cdp.send('HeapProfiler.collectGarbage');
     const after=await cdp.send('Runtime.getHeapUsage');
     await page.evaluate(async()=>{
      const {targets,run,k,kind}=globalThis.factor;
      for(const t of [.25,.75,.1]){
       run.seek(run.duration*t);
       for(const el of targets){
        const css=getComputedStyle(el);
        const v=kind==='to'?new DOMMatrixReadOnly(css.transform).m41:el.getBoundingClientRect().width;
        const expected=(kind==='to'?100:k-1)*t;
        if(Math.abs(v-expected)>.05 || kind==='to' && Math.abs(Number(css.opacity)-t)>.002)throw Error(kind+' pose '+v+' != '+expected);
       }
      }
      run.finish();if((await run.finished).status!=='finished')throw Error('outcome');
      for(const el of targets){
       const css=getComputedStyle(el);
       const v=kind==='to'?new DOMMatrixReadOnly(css.transform).m41:el.getBoundingClientRect().width;
       if(Math.abs(v-(kind==='to'?100:k-1))>.05 || kind==='to' && Number(css.opacity)!==1 || el.getAnimations().length)throw Error('finish');
      }
     });
     if(round>=0){const r={kind,n,k,round,name,startMs:startup,retained:after.usedSize-before.usedSize};rows.push(r);console.log(JSON.stringify(r));}
    }finally{await page.close();}
   }
  }
 }
 const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
 for(const [kind,n,k] of tasks)for(const name of ['baseline','candidate']){
  const r=rows.filter(x=>x.kind===kind&&x.n===n&&x.k===k&&x.name===name);
  console.log(JSON.stringify({summary:true,kind,n,k,name,startMs:med(r.map(x=>x.startMs)),retained:med(r.map(x=>x.retained))}));
 }
 console.error('Chrome '+browser.version()+', all poses and cleanup checked');
}finally{await browser.close();server.close();}
