import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [base,candidate,out]=process.argv.slice(2);
const {deriveEntriesFromExports,measureEntries,IMPORT_COST_SCENARIOS,measureScenario}=await import(pathToFileURL(`${candidate}/scripts/size-gate.mjs`));
const {canonicalGzip,observationalBrotli}=await import(pathToFileURL(`${candidate}/scripts/compression-oracle.mjs`));
const result={};
for(const[key,root]of[['base',base],['candidate',candidate]]){
 const entries=measureEntries(deriveEntriesFromExports(JSON.parse(readFileSync(`${root}/package.json`,'utf8'))),root);
 assert(!entries.hasWarnings,JSON.stringify(entries.rows.filter(x=>x.error||x.exceeded)));
 const consumers=[];for(const scenario of IMPORT_COST_SCENARIOS){const row=await measureScenario(scenario,`${root}/dist/index.js`);assert(!row.error,JSON.stringify(row));consumers.push(row);}
 result[key]={entries,consumers};
}
function check(b,c,path=''){for(const k of Object.keys(b)){
 if(/(?:raw|gz|br)Bytes$/i.test(k))assert(c[k]<=b[k],`${path}.${k}: ${b[k]} -> ${c[k]}`);
 if(b[k]!==null&&typeof b[k]==='object')check(b[k],c[k],`${path}.${k}`);
}}
check(result.base,result.candidate);
const walk=(root,prefix='')=>readdirSync(join(root,prefix),{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(root,join(prefix,d.name)):[join(prefix,d.name)]).sort();
const files=walk(`${base}/dist`);assert.deepEqual(walk(`${candidate}/dist`),files);
result.distChanges=[];
for(const file of files){
 const b=readFileSync(`${base}/dist/${file}`),c=readFileSync(`${candidate}/dist/${file}`);
 if(b.equals(c))continue;
 const costs=buffer=>({rawBytes:buffer.length,gzBytes:canonicalGzip(buffer).length,brBytes:observationalBrotli(buffer).length});
 const row={file,base:costs(b),candidate:costs(c)};check(row.base,row.candidate,file);result.distChanges.push(row);
}
assert.deepEqual(result.distChanges.map(x=>x.file),['animate/index.cjs','animate/index.js']);
result.distFiles=files.length;writeFileSync(out,JSON.stringify(result,null,2));
console.log(JSON.stringify({entries:result.base.entries.rows.length,consumers:result.base.consumers.length,distFiles:files.length,changes:result.distChanges}));
