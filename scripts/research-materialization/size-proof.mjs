import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {canonicalGzip,observationalBrotli} from './base/scripts/compression-oracle.mjs';
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const all=Object.fromEntries(['base','candidate'].map(side=>[side,Object.fromEntries(walk(`${side}/dist`).filter(p=>/\.(js|cjs)$/.test(p)).map(p=>{const b=fs.readFileSync(p);return[p.slice(side.length+6),{raw:b.length,gzip:canonicalGzip(b).length,brotli:observationalBrotli(b).length,sha256:createHash('sha256').update(b).digest('hex')}]}))]));
const regressions=[],changed=[];
for(const [file,b]of Object.entries(all.base)){
 const c=all.candidate[file];if(!c)throw new Error('missing '+file);
 if(b.sha256!==c.sha256)changed.push({file,base:b,candidate:c});
 for(const metric of ['raw','gzip','brotli'])if(c[metric]>b[metric])regressions.push({file,metric,base:b[metric],candidate:c[metric]});
}
const declarations=walk('base/dist').filter(p=>/\.d\.(ts|cts)$/.test(p));
for(const p of declarations)if(!fs.readFileSync(p).equals(fs.readFileSync(p.replace(/^base\//,'candidate/'))))throw new Error('declaration drift '+p);
fs.mkdirSync('evidence',{recursive:true});fs.writeFileSync('evidence/sizes.json',JSON.stringify({all,changed,regressions},null,2));
console.log(JSON.stringify({files:Object.keys(all.base).length,changed,regressions},null,2));if(regressions.length)process.exitCode=1;
