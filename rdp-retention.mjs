import fs from 'node:fs';import{spawnSync}from'node:child_process';import{pathToFileURL}from'node:url';import{resolve}from'node:path';import{writeHeapSnapshot}from'node:v8';import assert from'node:assert/strict';
const paths=['baseline/dist/compositor/index.js','candidate/dist/compositor/index.js'];
if(process.argv[2]==='child'){
 const [side,countText,mode]=process.argv.slice(3),count=Number(countText);const api=await import(pathToFileURL(resolve(paths[+side])));const cache=api.createSpringLinearCache(1);let cursor=0;
 const compile=()=>cache.compile({mass:1,stiffness:100+(cursor++%10000)*.001,damping:20},{v0:0,tolerance:.0025});
 for(let i=0;i<8192;i++)compile();cache.clear();global.gc();global.gc();const before=process.memoryUsage();
 globalThis.__labRdpHeld=[];for(let i=0;i<count;i++)globalThis.__labRdpHeld.push(compile());
 if(mode==='positive')globalThis.__labRdpHeld=globalThis.__labRdpHeld.map(s=>({s,leak:new Float64Array(4098)}));
 global.gc();global.gc();const held=process.memoryUsage();
 if(mode==='snapshot')writeHeapSnapshot(`retention-${side}-${count}-held.heapsnapshot`);
 let sum=0;for(const item of globalThis.__labRdpHeld){const s=typeof item==='string'?item:item.s;for(let i=0;i<s.length;i++)sum=(Math.imul(sum,31)+s.charCodeAt(i))|0;}
 global.gc();global.gc();const consumed=process.memoryUsage();
 if(mode==='snapshot')writeHeapSnapshot(`retention-${side}-${count}-consumed.heapsnapshot`);
 // Корень наблюдаем после обеих GC-границ: JIT не может выкинуть last-use local.
 assert.equal(globalThis.__labRdpHeld.length,count);delete globalThis.__labRdpHeld;cache.clear();await new Promise(r=>setImmediate(r));global.gc();global.gc();const released=process.memoryUsage();
 console.log(JSON.stringify({side,count,mode,before,held,consumed,released,hash:sum}));process.exit(0);
}
const report={note:'Диагностический scale-pass: global root, исходные gross-heap результаты не заменяются.',rows:[]};
for(const count of [0,128,512,2048])for(let block=0;block<4;block++)for(const side of block%2?[1,0,0,1]:[0,1,1,0]){
 const p=spawnSync(process.execPath,['--expose-gc',import.meta.filename,'child',side,count,'normal'],{encoding:'utf8',timeout:20000});if(p.status!==0)throw Error(p.stderr);report.rows.push({block,...JSON.parse(p.stdout)});fs.writeFileSync('retention-proof.json',JSON.stringify(report,null,2));
}
for(const side of [0,1])for(const mode of ['positive','snapshot']){const p=spawnSync(process.execPath,['--expose-gc',import.meta.filename,'child',side,512,mode],{encoding:'utf8',timeout:20000});if(p.status!==0)throw Error(p.stderr);report.rows.push(JSON.parse(p.stdout));fs.writeFileSync('retention-proof.json',JSON.stringify(report,null,2));}
for(const count of [0,128,512,2048])for(const side of ['0','1']){const rows=report.rows.filter(x=>x.side===side&&x.count===count&&x.mode==='normal');const median=xs=>xs.sort((a,b)=>a-b)[xs.length>>1];console.log(count,side,JSON.stringify(Object.fromEntries(['held','consumed','released'].map(k=>[k,median(rows.map(x=>x[k].heapUsed-x.before.heapUsed))]))));}
