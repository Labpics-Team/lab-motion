import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
const [root,callsText='100',countText='10']=process.argv.slice(2);
const calls=Number(callsText),count=Number(countText);
assert.equal(typeof global.gc,'function','--expose-gc required');
const {animate}=await import(pathToFileURL(`${root}/animate/index.js`));
const held=[];const refs=[];const timers=new Set();
const setTimer=(cb)=>{const fire=()=>{timers.delete(fire);cb();};timers.add(fire);return()=>timers.delete(fire);};
function target(index){return {payload:`target-${index}-`+'x'.repeat(128),style:{getPropertyValue:()=>'',setProperty(){}},animate:()=>({currentTime:100,cancel(){}})};}
async function collect(){for(let i=0;i<30;i++){await setImmediate();global.gc();}}
for(let i=0;i<100;i++){
 const el=target(i);const c=animate(el,{x:[0,100],opacity:[0,1]},{now:()=>0,setTimer});c.cancel();await c.finished;
}
await collect();const empty=process.memoryUsage().heapUsed;
for(let call=0;call<calls;call++){
 const targets=Array.from({length:count},(_,i)=>target(call*count+i));
 for(const el of targets)refs.push(new WeakRef(el));
 const controls=animate(targets,{x:[0,100],opacity:[0,1]},{now:()=>0,setTimer});
 controls.cancel();await controls.finished;held.push(controls);
}
assert.equal(timers.size,0,'probe retains timers');
await collect();const terminal=process.memoryUsage().heapUsed;
const alive=refs.filter(r=>r.deref()!==undefined).length;
for(const controls of held){controls.play();controls.pause();controls.seek(1);controls.cancel();controls.stop();await controls.finished;}
held.length=0;await collect();const dropped=process.memoryUsage().heapUsed;
const droppedAlive=refs.filter(r=>r.deref()!==undefined).length;
assert.equal(droppedAlive,0,'dropped controls must release targets');
console.log(JSON.stringify({root,calls,count,targets:calls*count,empty,terminal,dropped,retained:terminal-empty,alive,droppedAlive,node:process.version,v8:process.versions.v8}));
