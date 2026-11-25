import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});
const cases=[{n:1000,k:2},{n:500,k:4},{n:100,k:128}];
const rows=[];
try {
for(const {n,k} of cases)for(let round=-2;round<10;round++) {
 const ids=['direct','clone','construct'];
 const order=ids.map((_,i)=>ids[(i+round+3)%3]);
 for(const id of order) {
  const page=await browser.newPage({viewport:{width:1200,height:700}});const cdp=await page.context().newCDPSession(page);
  try {
   await page.setContent('<div id="root" style="contain:layout style paint;position:relative;width:1100px;height:600px"></div>');
   await page.evaluate(n=>{root.innerHTML=Array.from({length:n},(_,i)=>'<div style="position:absolute;left:'+i%50*14+'px;top:'+Math.floor(i/50)*14+'px;width:8px;height:8px;background:#d33"></div>').join('');root.getBoundingClientRect()},n);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   await cdp.send('Performance.enable',{timeDomain:'threadTicks'});
   const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
   const before=await metric();
   const data=await page.evaluate(async({id,k})=>{
    const t=performance.now(), frames=Array.from({length:k},(_,i)=>({transform:'translateX('+300*i/(k-1)+'px)',offset:i/(k-1)})),options={duration:400,easing:'linear',fill:'both'};
    const template=id==='clone'?new KeyframeEffect(null,frames,options):null;
    const effects=Array.from(root.children,el=>{
     if(id==='direct')return el.animate(frames,options);
     const effect=template?new KeyframeEffect(template):new KeyframeEffect(el,frames,options);
     if(template)effect.target=el;
     const animation=new Animation(effect,el.ownerDocument.timeline);animation.play();return animation;
    });
    const apiMs=performance.now()-t;
    await Promise.all(effects.map(e=>e.finished));const completionMs=performance.now()-t;
    const maxError=Math.max(...Array.from(root.children,el=>Math.abs(new DOMMatrixReadOnly(getComputedStyle(el).transform).e-300)));
    for(const e of effects)e.cancel();
    return {apiMs,completionMs,maxError,remaining:document.getAnimations().length};
   },{id,k});
   const after=await metric();
   assert(data.maxError<=.05&&data.remaining===0&&data.completionMs>=350,JSON.stringify(data));
   if(round>=0){const row={n,k,id,round,...data,taskMs:1000*(after.TaskDuration-before.TaskDuration)};rows.push(row);console.log(JSON.stringify(row));}
  }finally{await page.close()}
 }
}
const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
for(const {n,k} of cases)for(const id of ['direct','clone','construct']){const r=rows.filter(x=>x.n===n&&x.k===k&&x.id===id);console.log(JSON.stringify({summary:true,n,k,id,...Object.fromEntries(['apiMs','completionMs','taskMs'].map(k=>[k,med(r.map(x=>x[k]))]))}))}
console.log(JSON.stringify({chrome:browser.version(),node:process.version}));
}finally{await browser.close()}
