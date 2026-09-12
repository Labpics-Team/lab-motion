import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [root,countText='1',multiplierText='1',samplesText='60']=process.argv.slice(2);
const count=Number(countText),multiplier=Number(multiplierText),samples=Number(samplesText);
const {animate}=await import(pathToFileURL(`${root}/animate/index.js`));
let starts=0,cancels=0,writes=0,complete=0;
const targets=Array.from({length:count},()=>({
 style:{getPropertyValue:()=>'',setProperty(){writes++;}},
 animate(){starts++;return{currentTime:100,cancel(){cancels++;}};},
}));
const pending=new Set();
const options={now:()=>0,setTimer(cb){const token=()=>{pending.delete(token);cb();};pending.add(token);return()=>pending.delete(token);},onComplete(){complete++;}};
const props={x:[0,100],opacity:[0,1]};
async function once(){
 const t0=process.hrtime.bigint();const c=animate(targets,props,options);const t1=process.hrtime.bigint();
 c.cancel();const t2=process.hrtime.bigint();await c.finished;const t3=process.hrtime.bigint();
 assert.equal(pending.size,0);assert.equal(complete,0);
 return{startNs:Number(t1-t0),cancelNs:Number(t2-t1),finishedNs:Number(t3-t1)};
}
for(let i=0;i<300;i++)await once();
starts=cancels=writes=complete=0;
const rows=[];
for(let i=0;i<samples;i++){
 const row={startNs:0,cancelNs:0,finishedNs:0};
 for(let k=0;k<multiplier;k++){const x=await once();row.startNs+=x.startNs;row.cancelNs+=x.cancelNs;row.finishedNs+=x.finishedNs;}
 rows.push(row);
}
assert.equal(starts,samples*multiplier*count*2);assert.equal(cancels,starts);assert.equal(writes,starts);
console.log(JSON.stringify({root,count,multiplier,samples,rows,semantic:{valid:true,starts,cancels,writes,complete,pending:pending.size}}));
