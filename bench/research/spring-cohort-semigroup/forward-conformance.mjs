import {scenario,compare} from './scenario.mjs';import {writeFile} from 'node:fs/promises';
const A=await import('./package/dist/animate/research-baseline.mjs');
const B=await import('./package/dist/animate/research-guarded.mjs');
const C=await import('./package/dist/animate/research-forward.mjs');
const rows=[];
const ordinary=Array.from({length:60},(_,i)=>i*1000/120);
for(const cfg of [
 ...[1,100,1000].flatMap(n=>[0,.05,1].map(stagger=>({name:`default-${n}-${stagger}`,n,stagger,spring:{mass:1,stiffness:170,damping:26},times:ordinary}))),
 ...[.1,.5,.999999,1,1.000001,2,20].map(z=>({name:`zeta-${z}`,n:100,stagger:1,spring:{mass:1,stiffness:400,damping:40*z},times:ordinary})),
 ...[1000,2000].flatMap(w=>[.5,1,2].map(z=>({name:`jump-${w}-${z}`,n:1000,stagger:1.5,spring:{mass:1,stiffness:w*w,damping:2*z*w},times:[0,1500,1508.3333333333333,1516.6666666666667]}))),
 ...['controls','reentry','throwOnWrite','reduced'].map(k=>({name:k,n:17,stagger:1,spring:{mass:1,stiffness:170,damping:26},times:ordinary,[k]:true}))
]){
 const a=await scenario(A,cfg,{track:true});
 const b=await scenario(B,cfg,{track:true});const c=await scenario(C,cfg,{track:true});
 const row={cfg,unguarded:compare(a,b),guarded:compare(a,c),observed:{base:a.observed,unguarded:b.observed,guarded:c.observed},phase:c.phase};
 rows.push(row);console.log(cfg.name,JSON.stringify({unguarded:row.unguarded.maxRendered,guarded:row.guarded.maxRendered,topology:row.guarded.topology,counts:row.phase}));
}
await writeFile(new URL('forward-conformance.json',import.meta.url),JSON.stringify(rows,null,2));
