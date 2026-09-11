import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import * as base from './baseline/dist/compositor/index.js';
import * as candidate from './candidate/dist/compositor/index.js';
import {pairedClusterBootstrap} from './candidate/bench/compare/methodology.mjs';
const digest=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const paths=['baseline/dist/compositor/index.js','candidate/dist/compositor/index.js'];
const hashes=paths.map(digest);
assert.deepEqual(hashes,['453c2ad6b5836f72a7bc5883e40b1f0dd33494c67ecc857d39259d51795163a7','51e5fcb99d7b83d6ae077800424e9b1cc0873fb294e3a93164f6143cb6184dba']);
const report={base:process.env.BASE_SHA,candidate:process.env.CANDIDATE_SHA,node:process.version,nodeHash:digest(process.execPath),cpu:os.cpus()[0].model,kernel:os.release(),loadBefore:os.loadavg(),hashes,preregistration:5638730309,measurements:[]};
const profiles=[['critical/cold+consume',100,20,0,.0025,true,512],['under/cold',170,14,3,.0025,false,256],['velocity/cold',170,26,-30,.0025,false,256],['AA',100,20,0,.0025,true,512],['extra-cold-positive',100,20,0,.0025,true,256]];
let sink=0;
function task(api,p,duplicate=false){const [,k,d,v0,tolerance,consume]=p;const cache=api.createSpringLinearCache(1),springs=[{mass:1,stiffness:k,damping:d},{mass:1,stiffness:k+.001,damping:d}],options={v0,tolerance};let c=0;return()=>{const s=cache.compile(springs[c++&1],options);if(duplicate)cache.compile(springs[c++&1],options);if(consume){let h=0;for(let i=0;i<s.length;i++)h=(Math.imul(h,31)+s.charCodeAt(i))|0;sink^=h;}else sink^=s.length;};}
const measure=(fn,n)=>{const t=performance.now();for(let i=0;i<n;i++)fn();return(performance.now()-t)/n;};
for(const p of profiles){const name=p[0],count=p[6];const a=task(base,p),b=task(name==='AA'||name==='extra-cold-positive'?base:candidate,p,name==='extra-cold-positive');for(let i=0;i<256;i++){a();b();}
 const A=[],B=[],raw=[];
 for(let block=0;block<512;block++){const rows={a:[],b:[]};for(const side of block%2?['b','a','a','b']:['a','b','b','a']){const value=measure(side==='a'?a:b,count);rows[side].push(value);raw.push({block,side,value,count});}A.push({run:block,semantic:true,samples:rows.a});B.push({run:block,semantic:true,samples:rows.b});}
 const stats=pairedClusterBootstrap(B,A,{seed:0x812ccf,iterations:10000});report.measurements.push({name,count,raw,stats});fs.writeFileSync('tail-confirmatory.json',JSON.stringify(report,null,2));console.log(name,JSON.stringify(stats));
}
assert.deepEqual(paths.map(digest),hashes);report.sink=sink;report.loadAfter=os.loadavg();report.admission=report.measurements.slice(0,3).every(m=>m.stats.p95.high<=1.05)&&report.measurements[3].stats.p50.low<=1&&report.measurements[3].stats.p50.high>=1&&report.measurements[4].stats.p50.low>1;fs.writeFileSync('tail-confirmatory.json',JSON.stringify(report,null,2));console.log('ADMISSION',report.admission);
