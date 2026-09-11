import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pairedClusterBootstrap } from './candidate/bench/compare/methodology.mjs';
const paths=['baseline/dist/compositor/index.js','candidate/dist/compositor/index.js'];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const before=paths.map(hash);
const [base,candidate]=await Promise.all(paths.map(p=>import(pathToFileURL(resolve(p)))));
const fresh={environment:{node:process.version,nodeSha:hash(process.execPath),cpu:os.cpus()[0].model,platform:os.platform(),release:os.release(),load:os.loadavg()},hashes:before,base:'5f375cff2e978914cfb6ffed4c0ae2d573d1415f',candidate:process.env.CANDIDATE_SHA,sourceBlob:hash('candidate/src/compositor/segmenter.ts'),semantic:{accepted:0,rejected:0},measurements:[]};
const report=process.env.RESUME ? JSON.parse(readFileSync('research.json','utf8')) : fresh;
if(process.env.RESUME) { assert.deepEqual(fresh.hashes,report.hashes);report.resumeEnvironment=fresh.environment; }
let seed=0x812ccd;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
for(let i=0;i<(process.env.RESUME?0:4096);i++){
 const mass=10**(-1+2*random()),omega=2+38*random(),zeta=0.04+3.96*random();
 const spring={mass,stiffness:mass*omega*omega,damping:2*mass*omega*zeta};
 const options={spring,property:'opacity',from:0,to:1,v0:-30+60*random(),tolerance:0.0005+0.005*random()};
 const capture=m=>{try{return{ok:true,value:m.compileSpringPlan(options)}}catch(e){return{ok:false,name:e.name,message:e.message}}};
 const a=capture(base),b=capture(candidate);assert.deepEqual(b,a);report.semantic[a.ok?'accepted':'rejected']++;
}
let sink=0;
const profiles=[['critical',100,20,0,0.0025],['under',170,14,3,0.0025],['over',100,40,-3,0.0025],['weak',100,2,0,0.0025],['velocity',170,26,-30,0.0025],['precise',100,20,0,0.00025]];
function task(module,profile,consume,warm=false,duplicate=false){const [,stiffness,damping,v0,tolerance]=profile;const cache=module.createSpringLinearCache(1);const springs=[{mass:1,stiffness,damping},{mass:1,stiffness:stiffness+0.001,damping}];const options={v0,tolerance};let cursor=0;return()=>{const s=cache.compile(springs[warm?0:(cursor++&1)],options);if(duplicate)cache.compile(springs[cursor++&1],options);if(consume){let h=0;for(let i=0;i<s.length;i++)h=(Math.imul(h,31)+s.charCodeAt(i))|0;sink^=h;}else sink^=s.length;};}
function measure(fn,count){const t=performance.now();for(let i=0;i<count;i++)fn();return (performance.now()-t)/count;}
function run(name,a,b){if(report.measurements.some(m=>m.name===name))return;for(let i=0;i<256;i++){a();b();}let count=16;const pilot=[];for(;;){const av=measure(a,count),bv=measure(b,count);pilot.push({count,a:av,b:bv});if(Math.min(av,bv)*count>=8||count>=262144)break;count*=2;}
 const A=[],B=[],raw=[];for(let block=0;block<64;block++){const order=block%2===0?['a','b','b','a']:['b','a','a','b'];const samples={a:[],b:[]};for(const side of order){const value=measure(side==='a'?a:b,count);samples[side].push(value);raw.push({block,side,value,count});}A.push({run:block,semantic:true,samples:samples.a});B.push({run:block,semantic:true,samples:samples.b});}
 const stats=pairedClusterBootstrap(B,A,{seed:0x812ccf,iterations:10000});report.measurements.push({name,count,pilot,raw,stats});writeFileSync('research.json',JSON.stringify(report,null,2));console.log(name,JSON.stringify(stats));}
for(const p of profiles){run(p[0]+'/cold',task(base,p,false),task(candidate,p,false));run(p[0]+'/cold+consume',task(base,p,true),task(candidate,p,true));}
run('warm-cache',task(base,profiles[0],false,true),task(candidate,profiles[0],false,true));
run('AA',task(base,profiles[0],true),task(base,profiles[0],true));
run('extra-cold-positive',task(base,profiles[0],true),task(base,profiles[0],true,false,true));
assert.deepEqual(paths.map(hash),before);report.sink=sink;report.afterLoad=os.loadavg();writeFileSync('research.json',JSON.stringify(report,null,2));console.log('semantic',report.semantic);
