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
   let ref;
   const order=(round+Math.floor(round/2))%2?['candidate','baseline']:['baseline','candidate'];
   for(const name of order){
    const page=await browser.newPage();
    try{
     await page.goto('http://127.0.0.1:'+server.address().port);
     const data=await page.evaluate(async({name,n})=>{
      const {animate}=await import('/'+name+'/motion/index.js');
      const root=document.createElement('div');root.style.cssText='position:relative;contain:layout style paint;width:1000px;height:1000px;';
      for(let i=0;i<n;i++){const el=document.createElement('div');el.style.cssText='position:absolute;width:'+(i%53)+'px;height:'+(i%29)+'px';root.append(el);}
      document.body.append(root);const targets=[...root.children];root.getBoundingClientRect();
      const run=animate(targets,{width:100,height:200},{duration:1000,ease:'standard'});run.pause();
      const geometry=[];
      for(const t of [125,500,875]){
       run.seek(t);
       geometry.push(targets.map(el=>{const rect=el.getBoundingClientRect();return [rect.width,rect.height,el.style.width,el.style.height]}));
      }
      let checksum=0;const start=performance.now();
      for(let i=0;i<120;i++){
       run.seek(1+(i*83)%999);
       checksum+=Number.parseFloat(targets[(i*7)%n].style.width);
      }
      const ms=performance.now()-start;
      const values=targets.map(el=>[el.style.width,el.style.height]);
      run.finish();if((await run.finished).status!=='finished')throw Error('completion');
      for(const el of targets){const rect=el.getBoundingClientRect();if(rect.width!==100||rect.height!==200||el.getAnimations().length)throw Error('cleanup');}
      return {ms,checksum,geometry,values};
     },{name,n});
     const {ms,...verified}=data;
     if(!ref)ref=verified;else assert.deepEqual(verified,ref);
     if(round>=0){const row={n,round,name,ms,checksum:verified.checksum};rows.push(row);console.log(JSON.stringify(row));}
    }finally{await page.close();}
   }
  }
 }
 const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
 for(const n of [100,1000])for(const name of ['baseline','candidate']){
  const r=rows.filter(x=>x.n===n&&x.name===name);
  console.log(JSON.stringify({summary:true,n,name,ms:med(r.map(x=>x.ms))}));
 }
 console.error('Chrome '+browser.version()+', exact CSS strings and geometry verified');
}finally{await browser.close();server.close();}
