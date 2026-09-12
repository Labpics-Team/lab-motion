import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pairedClusterBootstrap} from './base/bench/compare/methodology.mjs';
import {readCheckoutState,hashFileTree,assertCheckoutUnchanged,captureBenchmarkEnvironment} from './base/bench/compare/provenance.mjs';

const scenarios=[];
for(const profile of ['default','under','over','velocity','big','accept','reject']) {
 for(const mode of ['warm-return','warm-consume','cold-return','cold-consume'])scenarios.push({profile,mode,count:['big','accept','reject'].includes(profile)?32:512});
}
for(const profile of ['negative','degenerate'])for(const mode of ['warm-return','warm-consume'])scenarios.push({profile,mode,count:4096});
for(const profile of ['surface1','surface8'])for(const mode of ['warm-consume','cold-consume'])scenarios.push({profile,mode,count:profile==='surface8'?32:128});
for(const profile of ['default','reject','surface8'])scenarios.push({profile,mode:profile==='surface8'?'warm-consume':'warm-return',count:profile==='default'?512:32,control:'normal'});
for(const profile of ['default','reject'])scenarios.push({profile,mode:'warm-return',count:profile==='default'?512:32,control:'double'});
const blocks=512, iterations=10000;
const manifest=JSON.parse(fs.readFileSync('probe-manifest.json','utf8'));
const provenance=Object.fromEntries(['base','candidate'].map(side=>{
 const root=path.resolve(side),state=readCheckoutState(root);if(state.dirty)throw new Error(`${side}: dirty checkout`);
 return[side,{...state,distRuntime:hashFileTree(path.join(root,'dist'),p=>/\.(c?js|mjs)$/.test(p)),environment:captureBenchmarkEnvironment(root,root,[],{requiredRootPackages:['tsup','typescript','esbuild','pako']})}];
}));
// The package contract declares ranges for these tools; attest actual frozen-lock
// installations directly, without modifying package metadata or claiming exact declarations.
function rangeTooling(side) {
 return Object.fromEntries(['terser','vite'].map(name=>{
  const root=fs.realpathSync(path.join(side,'node_modules',name));
  return [name,{version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,...hashFileTree(root)}];
 }));
}
for(const side of ['base','candidate'])provenance[side].rangeTooling=rangeTooling(side);
if(JSON.stringify(provenance.base.rangeTooling)!==JSON.stringify(provenance.candidate.rangeTooling))throw new Error('toolchain sides differ');
async function worker(side,profile,mode,control='normal'){
 const p=spawn(process.execPath,['perf-worker.mjs',side,profile,mode,control],{stdio:['pipe','pipe','inherit']});
 const iterator=readline.createInterface({input:p.stdout})[Symbol.asyncIterator]();
 const ready=await iterator.next();if(ready.done||!JSON.parse(ready.value).ready)throw new Error('worker not ready');
 return {measure:async count=>{p.stdin.write(JSON.stringify({count})+'\n');const line=await iterator.next();if(line.done)throw new Error('worker exited');const r=JSON.parse(line.value);if(!(r.ns>0)||!Number.isFinite(r.ns)||!Number.isFinite(r.sink))throw new Error('invalid sample');return r.ns;},close:()=>new Promise(resolve=>{p.once('exit',resolve);p.stdin.end();})};
}
const output={preregistration:{blocks,iterations,scenarios,p95NonInferiority:1.05,p50PracticalGain:.95,seed:0x5122026,noOutlierFiltering:true},environment:{node:process.version,v8:process.versions.v8,cpu:os.cpus()[0].model,cpus:os.cpus().length,platform:os.platform(),release:os.release(),date:new Date().toISOString(),loadBefore:os.loadavg()},manifest,provenance,profiles:[]};
fs.mkdirSync('evidence',{recursive:true});
for(const spec of scenarios){
 const ws=await Promise.all([worker('base',spec.profile,spec.mode),worker(spec.control?'base':'candidate',spec.profile,spec.mode,spec.control)]),values=[[],[]];
 for(let run=0;run<blocks;run++){
  const row=[[],[]];for(const side of(run%2?[1,0,0,1]:[0,1,1,0]))row[side].push(await ws[side].measure(spec.count));
  row.forEach((samples,side)=>values[side].push({run,samples,semantic:true}));
 }
 await Promise.all(ws.map(w=>w.close()));
 output.profiles.push({...spec,raw:values});fs.writeFileSync('evidence/confirm-raw.json',JSON.stringify(output));
 console.log('sampled',spec.profile,spec.mode,spec.control??'candidate');
}
// Statistics run after every timed sample: no bootstrap work contaminates another profile.
for(const row of output.profiles){row.result=pairedClusterBootstrap(row.raw[1],row.raw[0],{seed:0x5122026,iterations});console.log('result',row.profile,row.mode,row.control??'candidate',JSON.stringify(row.result));}
for(const side of ['base','candidate']){
 assertCheckoutUnchanged(path.resolve(side),provenance[side]);
 if(JSON.stringify(rangeTooling(side))!==JSON.stringify(provenance[side].rangeTooling))throw new Error('toolchain changed');
 const after=captureBenchmarkEnvironment(path.resolve(side),path.resolve(side),[],{requiredRootPackages:['tsup','typescript','esbuild','pako']});
 if(JSON.stringify(after)!==JSON.stringify(provenance[side].environment))throw new Error('environment changed');
}
output.environment.loadAfter=os.loadavg();
output.admission={allCandidateTails:output.profiles.filter(x=>!x.control).every(x=>x.result.p95.high<=1.05),aa:output.profiles.filter(x=>x.control==='normal').every(x=>x.result.p50.low<=1&&x.result.p50.high>=1&&x.result.p95.high<=1.05),positive:output.profiles.filter(x=>x.control==='double').every(x=>x.result.p50.low>1.5)};
fs.writeFileSync('evidence/confirm.json',JSON.stringify(output));console.log('ADMISSION',output.admission);
