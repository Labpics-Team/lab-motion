import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createRequire} from 'node:module';
const [base,candidate,out]=process.argv.slice(2);
const {chromium}=createRequire(`${candidate}/package.json`)('@playwright/test');
const roots={base:resolve(base,'dist'),candidate:resolve(candidate,'dist')};
const server=createServer(async(req,res)=>{
 try{
  const parts=new URL(req.url,'http://localhost').pathname.split('/').filter(Boolean);
  if(parts.length===0){res.setHeader('content-type','text/html');res.end('<!doctype html><html><body></body></html>');return;}
  const root=roots[parts.shift()];if(!root){res.writeHead(404).end();return;}
  const file=resolve(root,...parts);if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  res.setHeader('content-type',extname(file)==='.js'?'application/javascript':'text/plain');res.end(await readFile(file));
 }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
const rows=[];await mkdir(out,{recursive:true});
try{
 for(let run=0;run<12;run++)for(const id of run%2?['candidate','base']:['base','candidate']){
  const page=await browser.newPage();const cdp=await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');await page.goto(origin);
  await page.evaluate(async(id)=>{
   const {animate}=await import(`/${id}/animate/index.js`);window.animate=animate;
   function warm(){const el=document.createElement('div');const c=animate(el,{x:[0,100],opacity:[0,1]});c.cancel();return c.finished;}
   for(let i=0;i<200;i++)await warm();
   window.held=[];window.weak=[];
  },id);
  async function collect(){for(let i=0;i<8;i++){await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));await cdp.send('HeapProfiler.collectGarbage');}}
  const heap=async()=>{const{metrics}=await cdp.send('Performance.getMetrics');return metrics.find(x=>x.name==='JSHeapUsedSize').value;};
  await collect();const empty=await heap();
  await page.evaluate(async()=>{
   function setup(){
    const nodes=Array.from({length:10},()=>document.createElement('div'));
    document.body.append(...nodes);const c=window.animate(nodes,{x:[0,100],opacity:[0,1]});
    c.cancel();for(const el of nodes){el.remove();window.weak.push(new WeakRef(el));}
    window.held.push(c);return c.finished;
   }
   for(let i=0;i<100;i++)await setup();
  });
  await collect();const held=await heap();
  const alive=await page.evaluate(()=>window.weak.filter(r=>r.deref()!==undefined).length);
  assert.equal(alive,id==='base'?1000:0,`${id} retained native targets`);
  await page.evaluate(()=>{window.held.length=0;});await collect();const dropped=await heap();
  const droppedAlive=await page.evaluate(()=>window.weak.filter(r=>r.deref()!==undefined).length);
  assert.equal(droppedAlive,0,'drop-controls negative control');
  await page.evaluate(()=>{
   function setup(){const el=document.createElement('div');const c=window.animate(el,{x:100});c.pause();return{weak:new WeakRef(el),controls:c};}
   window.active=setup();
  });
  await collect();assert.equal(await page.evaluate(()=>window.active.weak.deref()!==undefined),true,'paused-owner positive control');
  await page.evaluate(async()=>{window.active.controls.cancel();await window.active.controls.finished;});await collect();
  assert.equal(await page.evaluate(()=>window.active.weak.deref()!==undefined),false,'paused-owner release');
  rows.push({run,id,empty,held,dropped,retained:held-empty,alive,droppedAlive});
  await writeFile(`${out}/browser-memory.json`,JSON.stringify({browser:browser.version(),rows},null,2));
  console.log(JSON.stringify(rows.at(-1)));await page.close();
 }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
