import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { scenario } from './scenario.mjs';
const url=new URL('./package/dist/animate/',import.meta.url);
const base=await readFile(new URL('research-baseline.mjs',url),'utf8');
const full=await readFile(new URL('research-forward-release.mjs',url),'utf8');
const start=full.indexOf('Yt.prototype.li=function(ts)');
if(start<0)throw Error('missing scheduler control');
const ordering=full.slice(start).replace('this.__phase.active=true;this.__phase.anchor=true;','').replace('this.__phase.active=false;','');
await writeFile(new URL('research-order-only.mjs',url),base+'\n'+ordering);
const mods={A:await import(new URL('research-baseline.mjs',url)),O:await import(new URL('research-order-only.mjs',url)),F:await import(new URL('research-forward-release.mjs',url))};
const configs=[{name:'coherent',stagger:0},{name:'dense-stagger',stagger:.05},{name:'wide-stagger',stagger:1}].map(c=>({...c,n:1000,spring:{mass:1,stiffness:170,damping:26},times:Array.from({length:60},(_,i)=>i*1000/120)}));
const orders=['AOF','OFA','FAO','FOA','OAF','AFO'];
for(const c of configs)for(let i=0;i<6;i++)for(const id of ['A','O','F'])await scenario(mods[id],c,{trace:false});
const rows=[];
for(let block=0;block<18;block++)for(let offset=0;offset<3;offset++){
 const c=configs[(block+offset)%3],order=orders[block%6],samples=[];
 for(const id of order){const r=await scenario(mods[id],c,{trace:false});samples.push({id,...r.timing,observed:r.observed,drains:r.drains});}
 rows.push({block,cell:c.name,order,samples});
}
const hashes={};for(const [id,name]of [['A','research-baseline.mjs'],['O','research-order-only.mjs'],['F','research-forward-release.mjs']])hashes[id]=createHash('sha256').update(await readFile(new URL(name,url))).digest('hex');
await writeFile(new URL(`causal-${process.argv[2]||1}.json`,import.meta.url),JSON.stringify({protocol:'18 six-order Latin balanced blocks; 3 variants: original A, ordering-only O, forward semigroup F; 6 warmups each/cell. Diagnostic causal control, not new production hypothesis.',hashes,configs,rows},null,2));
