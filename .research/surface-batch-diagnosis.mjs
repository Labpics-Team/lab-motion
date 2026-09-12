import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const seed=resolve(process.env.SEED_DIR), output=resolve(process.env.EVIDENCE_DIR);
await mkdir(output,{recursive:true});
const source=await readFile(join(seed,'surface-fixed-worker.mjs'),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
assert.equal(sha(source),'c4613385e7f97f2b191db2e80d1ae4d66197b555cc7a0759983b3e066479b6a7');
function replaceOnce(s,a,b){assert.equal(s.split(a).length,2,a);return s.replace(a,b);}
const files={};
for(const kind of ['current','turn']){
 let code="import { writeSync } from 'node:fs';\nimport { setImmediate as taskTurn } from 'node:timers/promises';\n"+source;
 code=replaceOnce(code,'  for (const side of warmOrder) {\n',`  for (const side of warmOrder) {\n${kind==='turn'?'    await taskTurn();\n':''}`);
 code=replaceOnce(code,'    const detail = timed(side === 0 ? opA : opB);',
  `    if (round === 64) writeSync(1, '__BURST_BEGIN__' + side + '\\n');\n    const detail = timed(side === 0 ? opA : opB);\n    if (round === 64) writeSync(1, '__BURST_END__' + side + '\\n');`);
 code=replaceOnce(code,'  const cpu = process.cpuUsage();','  const cpu = process.cpuUsage();\n  const threadCpu = process.threadCpuUsage();');
 code=replaceOnce(code,'    cpuUs: endCpu.user + endCpu.system,','    cpuUs: endCpu.user + endCpu.system,\n    threadCpu: process.threadCpuUsage(threadCpu),');
 files[kind]=join(output,`batch-${kind}-worker.mjs`);
 await writeFile(files[kind],code);
}
const jobs=[];
for(let cluster=0;cluster<16;cluster++)for(const kind of cluster%2?['turn','current']:['current','turn']){
 jobs.push({kind,worker:files[kind],data:{cluster,scenario:'batch',calls:8,positiveControl:false,
 sideAPath:join(seed,'baseline/dist/compiler/vite/index.js'),sideBPath:join(seed,'baseline/dist/compiler/vite/index.js'),acornPath:join(seed,'acorn.mjs')}});
}
const driver=join(output,'batch-diagnostic-driver.mjs');
await writeFile(driver,`import {Worker} from 'node:worker_threads';
import {writeFileSync,writeSync} from 'node:fs';
const jobs=JSON.parse(process.env.BATCH_JOBS);
const records=[];
for(const job of jobs){
 writeSync(1,'__CLUSTER_BEGIN__'+job.kind+':'+job.data.cluster+'\\n');
 const row=await new Promise((resolve,reject)=>{
  const worker=new Worker(job.worker,{workerData:job.data});
  let got=false;
  worker.once('message',async row=>{got=true;await worker.terminate();resolve(row);});
  worker.once('error',reject);
  worker.once('exit',code=>{if(!got)reject(new Error('worker exit without receipt: '+code));});
 });
 records.push({kind:job.kind,...row});
 writeSync(1,'__CLUSTER_END__'+job.kind+':'+job.data.cluster+'\\n');
}
writeFileSync(process.env.BATCH_RESULT,JSON.stringify(records,null,2));
`);
const child=spawnSync(process.execPath,['--trace-opt','--trace-deopt','--trace-turbo-inlining','--trace-gc',driver],{
 env:{...process.env,BATCH_JOBS:JSON.stringify(jobs),BATCH_RESULT:join(output,'batch-records.json')},encoding:'utf8',maxBuffer:64*1024*1024,timeout:240000,
});
await writeFile(join(output,'batch-diagnostic.log'),child.stdout+child.stderr);
assert.ifError(child.error);assert.equal(child.status,0,child.stderr);
const rows=[];
for(const job of jobs){
 const id=job.kind+':'+job.data.cluster;
 const block=child.stdout.split('__CLUSTER_BEGIN__'+id+'\n')[1]?.split('__CLUSTER_END__'+id+'\n')[0];assert(block,id);
 const bursts=[...block.matchAll(/__BURST_BEGIN__(\d)\n([\s\S]*?)__BURST_END__\1\n/g)];assert.equal(bursts.length,4,id);
 rows.push({kind:job.kind,cluster:job.data.cluster,bursts:bursts.map(m=>({side:+m[1],events:m[2].split('\n').filter(line=>/completed (compiling|optimizing)|bailout|deoptimizing|Scavenge|Mark-Compact/.test(line))}))});
}
await writeFile(join(output,'batch-attribution.json'),JSON.stringify(rows,null,2));
const summary=Object.fromEntries(['current','turn'].map(kind=>[kind,{
 isolates:rows.filter(r=>r.kind===kind).length,
 withTimedEvents:rows.filter(r=>r.kind===kind&&r.bursts.some(b=>b.events.length)).length,
 events:rows.filter(r=>r.kind===kind).flatMap(r=>r.bursts).flatMap(b=>b.events),
}]));
await writeFile(join(output,'batch-summary.json'),JSON.stringify({status:'DIAGNOSTIC_ONLY',sourceSha256:sha(source),node:process.version,summary},null,2));
console.log(JSON.stringify(summary,null,2));
