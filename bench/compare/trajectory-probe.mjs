import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright';
import { buildSync } from 'esbuild';
import assert from 'node:assert/strict';

const roots = { baseline: realpathSync(process.argv[2]), candidate: realpathSync(process.argv[3]) };
const motion = buildSync({ stdin: { contents: "export {animate} from 'motion'", resolveDir: import.meta.dirname }, bundle: true, minify: true, format: 'esm', write: false }).outputFiles[0].contents;
const server = createServer((req,res)=>{
  try {
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html><body></body></html>');}
    if(req.url==='/motion.js'){res.setHeader('Content-Type','text/javascript');return res.end(motion);}
    const [,name,...parts] = new URL(req.url,'http://localhost').pathname.split('/');
    const root=roots[name]; const file=realpathSync(resolve(root,...parts));
    const rel=relative(root,file); if(rel.startsWith('..')||isAbsolute(rel))throw Error('path');
    res.setHeader('Content-Type','text/javascript'); res.end(readFileSync(file));
  }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true});
const keys=['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'];
const metrics=async session=>Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
try {
 const rows=[];
 for(const n of [100,500]) {
  for(let round=-1;round<4;round++) {
   const names=['baseline','candidate','motion','raw'];
   const order=names.map((_,i)=>names[(i+round+4)%4]);
   for(const name of order){
    const page=await browser.newPage();
    const session=await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    try{
     await page.goto('http://127.0.0.1:'+server.address().port);
     await page.evaluate(async({name,n})=>{
      const nativeRAF=window.requestAnimationFrame;
      let raf=0; window.requestAnimationFrame=cb=>{raf++;return nativeRAF.call(window,cb)};
      const api=name==='raw'?null:await import(name==='motion'?'/motion.js':'/'+name+'/motion/index.js');
      const root=document.createElement('div');
      root.style.cssText='position:relative;width:800px;height:600px;contain:layout style paint;';
      for(let i=0;i<n;i++){const el=document.createElement('div');el.style.cssText='position:absolute;left:'+(i%20)*38+'px;top:'+Math.floor(i/20)*22+'px;width:8px;height:8px;background:#36c;transform:translateX(0px);';root.append(el);}
      document.body.append(root);
      const targets=[...root.children];
      const from=[0,80,-20,100], times=[0,.2,.7,1], duration=600;
      // Isolated real geometry check, outside natural-completion measurement.
      const start=()=>name==='raw'?targets.map(el=>el.animate(from.map((x,i)=>({transform:'translateX('+x+'px)',offset:times[i]})),{duration,easing:'linear',fill:'both'})):
        api.animate(targets,{x:from},{duration:name==='motion'?duration/1000:duration,ease:'linear',times});
      const pose=el=>el.getBoundingClientRect().left-root.getBoundingClientRect().left-el.offsetLeft;
      const expected=t=>t<=120?80*t/120:t<=420?80-100*(t-120)/300:-20+120*(t-420)/180;
      const trial=start();
      if(name==='raw')for(const e of trial)e.pause();else trial.pause();
      for(const t of [60,120,270,420,510,300]){
       if(name==='raw')for(const e of trial)e.currentTime=t;
       else if(name==='motion'){trial.time=t/1000;await new Promise(r=>nativeRAF(()=>nativeRAF(r)));}
       else trial.seek(t);
       for(const el of targets)if(Math.abs(pose(el)-expected(t))>.2)throw Error(name+' pose '+pose(el)+' expected '+expected(t));
      }
      if(name==='raw')for(const e of trial)e.cancel();else trial.stop();
      for(const el of targets)el.style.transform='translateX(0px)';
      await new Promise(r=>nativeRAF(()=>nativeRAF(r)));
      globalThis.probe={targets,start,pose,raf:()=>raf};
     },{name,n});
     const before=await metrics(session);
     const sample=await page.evaluate(async name=>{
      const {targets,start,pose,raf}=globalThis.probe;
      const initialRaf=raf(), begin=performance.now();
      const run=start(); const startMs=performance.now()-begin;
      const effects=targets.reduce((s,el)=>s+el.getAnimations().length,0);
      if(name==='raw'){await Promise.all(run.map(e=>e.finished));for(const e of run){e.commitStyles();e.cancel();}}
      else {await run.finished;if(name==='motion')run.stop();}
      const elapsed=performance.now()-begin;
      // Read every element, not just a representative.
      for(const el of targets)if(Math.abs(pose(el)-100)>.2)throw Error(name+' final '+pose(el));
      const remaining=targets.reduce((s,el)=>s+el.getAnimations().length,0);
      if(remaining)throw Error(name+' remaining '+remaining);
      return {startMs,elapsed,effects,raf:raf()-initialRaf,remaining};
     },name);
     const after=await metrics(session);
     const row={n,round,name,...sample,...Object.fromEntries(keys.map(k=>[k,(after[k]-before[k])*1000]))};
     if(round>=0){rows.push(row);console.log(JSON.stringify(row));}
    }finally{await page.close();}
   }
  }
 }
 const median=x=>x.sort((a,b)=>a-b)[Math.floor(x.length/2)];
 for(const n of [100,500])for(const name of ['baseline','candidate','motion','raw']){
  const r=rows.filter(x=>x.n===n&&x.name===name);
  console.log(JSON.stringify({summary:true,n,name,...Object.fromEntries(['startMs','elapsed','effects','raf',...keys].map(k=>[k,median(r.map(x=>x[k]))]))}));
 }
 console.error('Chrome '+browser.version()+'; all poses and cleanup checked');
}finally{await browser.close();server.close();}
