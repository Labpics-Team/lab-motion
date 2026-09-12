import assert from 'node:assert/strict';import fs from 'node:fs';
const variants=await Promise.all(['base','candidate'].map(s=>import(`./${s}/dist/compiler/vite/surface-probe.js`)));
const unique=(a)=>{const b=[];for(let i=0;i<a.length;i+=2){if(b.length&&a[i]===b.at(-2)){assert.ok(Object.is(a[i+1],b.at(-1)));}else b.push(a[i],a[i+1]);}return b;};
import {canonicalGzip,observationalBrotli} from './base/scripts/compression-oracle.mjs';
const artifactSizes=[];
const literal=a=>`{w0:${a.fromWidth},w1:${a.toWidth},d:${a.durationMs},p:${JSON.stringify(a.easing)},q:${JSON.stringify(a.reciprocalEasing)},a:${JSON.stringify(a.blendEasing)}}`;
const size=a=>{const bytes=Buffer.from(literal(a));return {raw:bytes.length,gzip:canonicalGzip(bytes).length,brotli:observationalBrotli(bytes).length,stops:a.reciprocalSamples.length/2};};
const consume=a=>a?.reciprocalEasing.length;
let state=0x517cade;const rand=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
const inputs=[];
for(const damping of [9,19.99,20,20.01,26,40])for(const [from,to]of [[240,360],[360,240],[400,401],[80,960],[960,80],[1,4096],[1e-300,2e-300],[1e300,2e300],[1,1+Number.EPSILON]])for(const budget of [.25,.009,.00883,.00001])inputs.push([{mass:1,stiffness:100,damping},from,to,1/400,budget,0]);
for(let i=0;i<1800;i++){
 const m=10**(-2+4*rand()),w=2**(-2+6*rand()),z=.1+3*rand();
 const from=10**(-1+5*rand()),to=from*10**(-2+4*rand());
 inputs.push([{mass:m,stiffness:m*w*w,damping:2*m*w*z},from,to,[1/400,.001,.00025][i%3],10**(-4+4*rand()),(rand()-.5)*4]);
}
let accepted=0,rejected=0;
for(const [index,input] of inputs.entries()){
 const results=variants.map(m=>{try{return{a:m.__surfaceProbe(...input)}}catch(e){return{error:[e.name,e.message]}}});
 const [b,c]=results;
 assert.deepEqual(c.error,b.error,`throw ${index}`);
 assert.equal(c.a!==undefined,b.a!==undefined,`admission ${index}`);
 if(c.a){accepted++;const a=c.a,old=b.a;
  for(const k of ['easing','durationMs','minWidth','fromWidth','toWidth'])assert.deepEqual(a[k],old[k],`${k} ${index}`);
  assert.deepEqual(a.samples,old.samples);
  assert.deepEqual(Array.from(a.reciprocalSamples),unique(old.reciprocalSamples));
  const oldBlend=[];for(let j=0;j<old.blendSamples.length;j++)oldBlend.push(old.reciprocalSamples[2*j],old.blendSamples[j]);
  assert.deepEqual(a.blendSamples,unique(oldBlend).filter((_,j)=>j%2));
  const parse=s=>s.slice(7,-1).split(',').flatMap(p=>{const [v,x]=p.trim().split(' ');return[Number(x.slice(0,-1)),Number(v)];});
  for(const k of ['reciprocalEasing','blendEasing'])assert.deepEqual(parse(a[k]),unique(parse(old[k])));
  artifactSizes.push({index,base:size(old),candidate:size(a)});consume(a);
 }else rejected++;
 if(index%200===0)variants.forEach(m=>m.__clearSurfaceCache());
}
const result={total:inputs.length,accepted,rejected,mismatches:0,seed:'0x517cade',description:'actual minified function body; frozen base duplicate-neutral semantic oracle'};
fs.writeFileSync('evidence/differential.json',JSON.stringify(result,null,2));console.log(result);

const regressions=artifactSizes.flatMap(row=>['raw','gzip','brotli'].filter(k=>row.candidate[k]>row.base[k]).map(metric=>({index:row.index,metric,base:row.base[metric],candidate:row.candidate[metric],input:inputs[row.index]})));
fs.writeFileSync('evidence/artifact-sizes.json',JSON.stringify({cases:artifactSizes,regressions}));console.log('ARTIFACT_REGRESSIONS',JSON.stringify(regressions));if(regressions.length)process.exitCode=1;
