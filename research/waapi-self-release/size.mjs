import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [base,candidate,out]=process.argv.slice(2);
const api=await import(pathToFileURL(`${candidate}/scripts/size-gate.mjs`));
const compression=await import(pathToFileURL(`${candidate}/scripts/compression-oracle.mjs`));
const result={};
for(const [id,root] of [['base',base],['candidate',candidate]]){
 const entries=api.measureEntries(api.deriveEntriesFromExports(JSON.parse(readFileSync(`${root}/package.json`,'utf8'))),root);
 assert(!entries.hasWarnings,`${id} entry warnings`);
 const consumers=[];for(const scenario of api.IMPORT_COST_SCENARIOS){const row=await api.measureScenario(scenario,`${root}/dist/index.js`);assert(!row.error,JSON.stringify(row));consumers.push(row);}
 result[id]={entries,consumers};
}
function protect(b,c,path='root'){
 if(Array.isArray(b)){for(let i=0;i<b.length;i++)protect(b[i],c[i],`${path}[${i}]`);return;}
 if(!b||typeof b!=='object')return;
 for(const [k,v] of Object.entries(b)){
  if(typeof v==='number'&&/(?:raw|gz|br)Bytes$/i.test(k))assert(c[k]<=v,`${path}.${k}: ${v} -> ${c[k]}`);
  else if(v&&typeof v==='object')protect(v,c[k],`${path}.${k}`);
 }
}
protect(result.base,result.candidate);
const walk=(root,p='')=>readdirSync(join(root,p),{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(root,join(p,d.name)):[join(p,d.name)]).sort();
const files=walk(`${base}/dist`);assert.deepEqual(walk(`${candidate}/dist`),files);result.dist=[];
for(const file of files){const b=readFileSync(`${base}/dist/${file}`),c=readFileSync(`${candidate}/dist/${file}`);if(b.equals(c))continue;
 const cost=x=>({rawBytes:x.length,gzBytes:compression.canonicalGzip(x).length,brBytes:compression.observationalBrotli(x).length});const row={file,base:cost(b),candidate:cost(c)};protect(row.base,row.candidate,file);result.dist.push(row);}
writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify({changed:result.dist,entries:result.base.entries.rows.length,consumers:result.base.consumers.length}));
