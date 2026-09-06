import assert from 'node:assert/strict';
export async function scenario(mod,cfg,{trace=true,track=false}={}){
 let queue=[],requests=0,frame=-1,completed=0,writes=0;const journal=[];const units=[];const controls=[];
 const requestFrame=cb=>{requests++;queue.push(cb);return requests;};
 const els=Array.from({length:cfg.n},(_,i)=>{const data=new Map([['opacity','1']]);return {i,data,style:{getPropertyValue(k){return data.get(k)||'';},setProperty(k,v){writes++;data.set(k,v);if(trace)journal.push([frame,i,k,v]);if(cfg.reentry && frame===3 && i===0 && k==='transform' && controls.length===1){controls.push(mod.animate(els[0],{x:[-20,80]},{spring:cfg.spring,requestFrame,matchMedia:()=>({matches:false})}));}if(cfg.throwOnWrite && frame===3 && i===2)throw new Error('deliberate host-write error');}}};});
 const oldAdd=mod.SurfaceBatch.prototype.bt;
 if(track)mod.SurfaceBatch.prototype.bt=function(unit,paused){units.push(unit);return oldAdd.call(this,unit,paused);};
 let c;const tStart=performance.now();
 try{c=mod.animate(els,{x:[0,cfg.span??100],y:[30,-70],scale:[.9,1.1],opacity:[1,.4]},{spring:cfg.spring,stagger:cfg.stagger,requestFrame,matchMedia:()=>({matches:cfg.reduced??false}),onComplete(){completed++;}});controls.push(c);}finally{if(track)mod.SurfaceBatch.prototype.bt=oldAdd;}
 const startMs=performance.now()-tStart;
 const states=[];const tFrames=performance.now();
 for(let f=0;f<cfg.times.length;f++){
  frame=f;
  if(cfg.controls && f===4)c.pause();
  if(cfg.controls && f===6){c.seek(12.5);c.play();}
  const current=queue;queue=[];for(const cb of current)cb(cfg.times[f]);
  if(track)states.push(units.map(u=>u.K('x')));
 }
 const frameMs=performance.now()-tFrames;
 const observed={requests,writes,completed,active:units.filter(u=>!u.nt).length};
 const phase=track?Array.from(new Set(units.map(u=>u.it?.gt).filter(Boolean))).map(b=>b.__phase && ({direct:b.__phase.direct,transport:b.__phase.transport,stepSolves:b.__phase.stepSolves,subnormal:b.__phase.subnormal})).filter(Boolean):[];
 const tCleanup=performance.now();frame=cfg.times.length;for(const control of controls)control.cancel();await Promise.all(controls.map(c=>c.finished));
 let drains=0;while(queue.length&&drains<3){const current=queue;queue=[];for(const cb of current)cb(10000+drains++);}
 assert.equal(queue.length,0,'no idle loop');
 const cleanupMs=performance.now()-tCleanup;
 return {observed,journal,states,phase,drains,timing:{startMs,frameMs,cleanupMs,totalMs:startMs+frameMs+cleanupMs}};
}
export function compare(a,b){
 let topology=0,maxPosition=0,maxVelocity=0,maxRendered=0,exactStringDifferences=0,witness;
 if(a.journal.length!==b.journal.length)topology++;
 const numbers=s=>(s.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)||[]).map(Number);
 for(let i=0;i<Math.min(a.journal.length,b.journal.length);i++){
  const x=a.journal[i],y=b.journal[i];
  if(x[0]!==y[0]||x[1]!==y[1]||x[2]!==y[2]){topology++;continue;}
  if(x[3]!==y[3])exactStringDifferences++;
  const parse=s=>{const v={x:0,y:0,sx:1,sy:1};for(const m of s.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\(([^)]*)\)/g)){const z=numbers(m[2]);if(m[1]==='translate'){v.x=z[0];v.y=z[1]??0;}else if(m[1]==='translateX')v.x=z[0];else if(m[1]==='translateY')v.y=z[0];else if(m[1]==='scale'){v.sx=z[0];v.sy=z[1]??z[0];}else throw new Error('unsupported research transform '+m[1]);}return [v.x,v.y,v.sx,v.sy];};
  const xn=x[2]==='transform'?parse(x[3]):numbers(x[3]),yn=y[2]==='transform'?parse(y[3]):numbers(y[3]);if(xn.length!==yn.length)topology++;
  for(let k=0;k<Math.min(xn.length,yn.length);k++){const d=Math.abs(xn[k]-yn[k]);if(!Number.isFinite(d)||d>maxRendered){maxRendered=d;witness={at:i,base:x,candidate:y};}}
 }
 for(let f=0;f<Math.min(a.states.length,b.states.length);f++)for(let i=0;i<a.states[f].length;i++){
  const x=a.states[f][i],y=b.states[f][i];if(!x||!y){if(Boolean(x)!==Boolean(y))topology++;continue;}
  maxPosition=Math.max(maxPosition,Math.abs(x.p-y.p));maxVelocity=Math.max(maxVelocity,Math.abs(x.T-y.T));
 }
 return {topology,maxPosition,maxVelocity,maxRendered,exactStringDifferences,witness};
}
