import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const spec=JSON.parse(process.argv[2]);
const sha256=file=>createHash('sha256').update(readFileSync(new URL(file,import.meta.url))).digest('hex');
const consumeString=s=>{let v=0;for(let i=0;i<s.length;i++)v=(Math.imul(v,31)+s.charCodeAt(i))|0;return v;};
let checksum=0,last;
let call,consume,meta;
if(spec.kind==='dynamic'){
 const require=createRequire(import.meta.url);
 const {parse}=require('../motion-pass/node_modules/.pnpm/acorn@8.18.0/node_modules/acorn/dist/acorn.js');
 const root=spec.variant==='base'?'motion-macro-base':'motion-pass';
 const modulePath=`../${root}/dist/compiler/vite/index.cjs`;
 const compiler=require(modulePath).motionCompiler();
 const code="import {animate} from '@labpics/motion/animate';export function play(el,w){animate(el,{width:[240,w]},{layout:'project',spring:{mass:1,stiffness:170,damping:26}});}";
 const ctx={parse:s=>parse(s,{ecmaVersion:'latest',sourceType:'module'}),warn:x=>{throw Error(x);}};
 call=()=>compiler.transform.call(ctx,code,'fixture.js');
 consume=r=>r?consumeString(r.code)+consumeString(r.map.mappings):1;
 if(call()!==undefined)throw Error('dynamic must remain a no-op');
 meta={variant:spec.variant,source:modulePath,sha256:sha256(modulePath),semantic:'no-op'};
}else{
 const file=`./${spec.variant}-probe.mjs`;
 const mod=await import(file);
 const args=[{mass:1,stiffness:spec.k,damping:spec.c},spec.a,spec.b,undefined,spec.budget,spec.v];
 const doCall=()=>{if(spec.cold)mod.clear();return mod.compile(...args);};
 const read=r=>r?consumeString(r.reciprocalEasing)+consumeString(r.blendEasing):1;
 call=spec.twice?()=>{const first=doCall();checksum+=read(first);return doCall();}:doCall;
 consume=spec.consumed?read:()=>0;
 const value=doCall();
 if(!!value===!!spec.reject)throw Error('wrong admission');
 // Наблюдение вне тайминга: общий P и Q/A с удалёнными только тождественными дублями.
 const canonical=s=>s.slice(7,-1).split(',').map(x=>x.trim()).filter((x,i,a)=>i===0||x!==a[i-1]).join(',');
 const signature=value?JSON.stringify([value.easing,value.durationMs,canonical(value.reciprocalEasing),canonical(value.blendEasing)]):'reject';
 meta={variant:spec.variant,source:file,sha256:sha256(file),semanticSha256:createHash('sha256').update(signature).digest('hex')};
}
const run=()=>{
 if(!spec.cold)call();
 const start=process.hrtime.bigint();
 for(let i=0;i<spec.count;i++){
  last=call();checksum+=consume(last);checksum+=last?.durationMs??last?.code?.length??1;
 }
 return Number(process.hrtime.bigint()-start)/spec.count;
};
process.stdout.write(JSON.stringify({ready:true,node:process.version,pid:process.pid,meta})+'\n');
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 if(line==='q')break;
 if(line!=='r')throw Error('unknown protocol');
 process.stdout.write(JSON.stringify({ns:run()})+'\n');
}
process.stdout.write(JSON.stringify({done:true,checksum,retained:!!last})+'\n');
