import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [root,,multiplierText='1']=process.argv.slice(2),multiplier=Number(multiplierText);
const {animate}=await import(pathToFileURL(`${root}/animate/index.js`));
const rows=[];
for(const count of [1,100,1000]){
 const pending=new Set();let starts=0,cancels=0,writes=0,completes=0;
 const targets=Array.from({length:count},()=>({style:{getPropertyValue:()=>'',setProperty(){writes++;}},animate(){starts++;return{currentTime:100,cancel(){cancels++;}};}}));
 const options={now:()=>0,setTimer(cb){pending.add(cb);return()=>pending.delete(cb);},onComplete(){completes++;}};
 const props={x:[0,100],opacity:[0,1]};
 async function run(){
  const before=process.hrtime.bigint();const c=animate(targets,props,options);const started=process.hrtime.bigint();
  c.cancel();const ended=process.hrtime.bigint();await c.finished;
  assert.equal(pending.size,0);assert.equal(completes,0);
  return{startNs:Number(started-before),teardownNs:Number(ended-started)};
 }
 for(let i=0;i<200;i++)await run();starts=cancels=writes=0;
 const samples=[];
 for(let i=0;i<80;i++){
  const sample={startNs:0,teardownNs:0};
  for(let k=0;k<multiplier;k++){const measured=await run();for(const key of Object.keys(sample))sample[key]+=measured[key];}
  samples.push(sample);
 }
 assert.equal(starts,80*multiplier*count*2);assert.equal(cancels,starts);assert.equal(writes,starts);
 rows.push({motion:'waapi',count,samples,semantic:{valid:true,starts,cancels,writes,completes,pending:pending.size}});
}
console.log(JSON.stringify({root,multiplier,warmup:200,repetitions:80,rows}));
