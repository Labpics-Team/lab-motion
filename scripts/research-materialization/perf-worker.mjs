import readline from 'node:readline';
import {parse} from './base/node_modules/.pnpm/node_modules/acorn/dist/acorn.mjs';
const [side,profile,mode,control='normal']=process.argv.slice(2);
const mod=await import(`./${side}/dist/compiler/vite/surface-probe.js`);
const s={mass:1,stiffness:170,damping:26};
const profiles={default:[s,240,360],under:[{...s,damping:9},240,360],over:[{mass:1,stiffness:100,damping:40},240,360],big:[s,1,4096],accept:[s,1,4096,undefined,.009],reject:[s,1,4096,undefined,.00883],negative:[{...s,damping:9},960,80],degenerate:[s,240,240],velocity:[s,240,360,undefined,undefined,1]};
const args=profiles[profile];let sink=0;
function consume(a){if(a===undefined){sink++;return;}sink+=a.durationMs+a.reciprocalSamples.length;
 if(mode.includes('consume')){
  for(const str of [a.easing,a.reciprocalEasing,a.blendEasing])for(let j=0;j<str.length;j++)sink+=str.charCodeAt(j);
  for(const val of a.reciprocalSamples)sink+=val;
  for(const val of a.blendSamples)sink+=val;
 }
}
const plugin=mod.motionCompiler();
const source=profile.startsWith('surface')?`import {animate} from '@labpics/motion/animate';\n`+Array.from({length:profile==='surface8'?8:1},(_,i)=>`animate(el${i}, {width:[240,360]}, {layout:'project'});`).join('\n'):'';
const ctx={parse:c=>parse(c,{ecmaVersion:'latest',sourceType:'module'}),warn:()=>{throw new Error('unexpected warn')}};
const one=profile.startsWith('surface')?()=>{if(mode.startsWith('cold'))mod.__clearSurfaceCache();const r=plugin.transform.call(ctx,source,'fixture.js');if(!r)throw new Error('no lowering');for(const str of [r.code,r.map.mappings])for(let j=0;j<str.length;j++)sink+=str.charCodeAt(j);}:()=>{if(mode.startsWith('cold'))mod.__clearSurfaceCache();consume(mod.__surfaceProbe(...args));};
if(!profile.startsWith('surface')){
 const checked=mod.__surfaceProbe(...args);
 if(['reject','negative'].includes(profile)!==(checked===undefined))throw new Error('unexpected profile admission');
 if(checked){
  if(![checked.durationMs,checked.minWidth,...checked.reciprocalSamples,...checked.blendSamples].every(Number.isFinite))throw new Error('nonfinite profile');
  if(checked.reciprocalSamples.length!==checked.blendSamples.length*2)throw new Error('sample topology');
 }
 mod.__clearSurfaceCache();
}
const work=control==='double'?()=>{one();one();}:one;
for(let i=0;i<16;i++)for(let k=0;k<64;k++)work();
console.log(JSON.stringify({ready:true,side,profile,mode,control}));
for await (const line of readline.createInterface({input:process.stdin})){
 const {count}=JSON.parse(line);const t=process.hrtime.bigint();for(let i=0;i<count;i++)work();const ns=Number(process.hrtime.bigint()-t)/count;
 console.log(JSON.stringify({ns,sink}));
}
