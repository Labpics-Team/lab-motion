import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
const [root,stage='terminal',callsText='100',countText='10']=process.argv.slice(2);
const calls=Number(callsText),count=Number(countText);
assert.equal(typeof global.gc,'function');
const {animate}=await import(pathToFileURL(`${root}/animate/index.js`));
const timers=new Set();
function setTimer(cb){const fire=()=>{timers.delete(fire);cb();};timers.add(fire);return()=>timers.delete(fire);}
const options={setTimer,now:()=>0},props={x:[0,100],opacity:[0,1]},keep=[],refs=[];
function setup(retain){
 const targets=Array.from({length:count},()=>({style:{getPropertyValue:()=>'',setProperty(){}},animate:()=>({currentTime:100,cancel(){}})}));
 const controls=animate(targets,props,options);
 if(retain){keep.push(controls);for(const target of targets)refs.push(new WeakRef(target));}
 if(stage==='terminal'||!retain)controls.cancel();
 return controls.finished;
}
for(let i=0;i<200;i++)await setup(false);
async function collect(){for(let i=0;i<12;i++){await setImmediate();global.gc();}}
await collect();const empty=process.memoryUsage().heapUsed;
for(let i=0;i<calls;i++)setup(true);
if(stage==='terminal')await Promise.all(keep.map(c=>c.finished));
await collect();const held=process.memoryUsage().heapUsed;
const alive=refs.filter(r=>r.deref()!==undefined).length;
if(stage==='active')assert.equal(alive,calls*count);
function finishAll(){for(const controls of keep)controls.cancel();return Promise.all(keep.map(c=>c.finished));}
await finishAll();keep.length=0;await collect();
const dropped=process.memoryUsage().heapUsed,afterDropAlive=refs.filter(r=>r.deref()!==undefined).length;
assert.equal(afterDropAlive,0,'dropped controls must release every target');refs.length=0;assert.equal(timers.size,0);
console.log(JSON.stringify({root,stage,calls,count,empty,held,dropped,retained:held-empty,afterDropDelta:dropped-empty,afterDropAlive,alive,targets:calls*count,environment:{node:process.version,v8:process.versions.v8}}));
