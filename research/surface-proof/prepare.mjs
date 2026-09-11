import {build} from '../motion-pass/node_modules/esbuild/lib/main.js';
import {minify} from '../motion-pass/node_modules/terser/main.js';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {canonicalGzip as gz,observationalBrotli as br} from '../motion-pass/scripts/compression-oracle.mjs';
const roots=[['base',fileURLToPath(new URL('../motion-macro-base',import.meta.url)),'5f375cff2e978914cfb6ffed4c0ae2d573d1415f'],['candidate',fileURLToPath(new URL('../motion-pass',import.meta.url)),'45418c4ba9826a7701cd86b17a29061a62daeaf7']];
const hashes=[];
for(const [label,root,sha] of roots){
 if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==sha)throw Error('wrong SHA');
 execFileSync('git',['diff','--exit-code'],{cwd:root});
 const r=await build({stdin:{contents:"export {tryCompileSurfaceArtifact as compile} from './src/future-layout/artifact.js'; export {clearSpringExecutionArtifactCacheUnchecked as clear} from './src/compositor/curve.js';",resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',target:'es2022'});
 const m=await minify(r.outputFiles[0].text,{module:true,compress:{passes:3,pure_getters:true},mangle:{properties:{regex:/^_/}}});
 writeFileSync(new URL(label+'-probe.mjs',import.meta.url),m.code);
 const digest=f=>createHash('sha256').update(readFileSync(join(root,f))).digest('hex');
 hashes.push({label,sha,source:digest('src/future-layout/artifact.ts'),package:digest('package.json'),lock:digest('pnpm-lock.yaml'),tsup:digest('tsup.config.ts'),probe:createHash('sha256').update(m.code).digest('hex')});
}
writeFileSync(new URL('provenance.json',import.meta.url),JSON.stringify({node:process.version,executable:process.execPath,executableSha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),hashes},null,2));
function files(dir,p=''){return readdirSync(join(dir,p),{withFileTypes:true}).flatMap(d=>d.isDirectory()?files(dir,join(p,d.name)):/\.(cjs|js)$/.test(d.name)?[join(p,d.name)]:[]).sort();}
const old=join(roots[0][1],'dist'),current=join(roots[1][1],'dist');
const rows=files(old).map(path=>{const a=readFileSync(join(old,path)),b=readFileSync(join(current,path));const base=[a.length,gz(a).length,br(a).length],candidate=[b.length,gz(b).length,br(b).length];return {path,base,candidate,delta:candidate.map((v,i)=>v-base[i]),sha256:createHash('sha256').update(b).digest('hex')};});
writeFileSync(new URL('size-vector.json',import.meta.url),JSON.stringify(rows,null,2));
const regressions=rows.filter(r=>r.delta.some(v=>v>0));
console.log(JSON.stringify({entries:rows.length,regressions,changed:rows.filter(r=>r.delta.some(v=>v))},null,2));
if(rows.length!==84||regressions.length)throw Error('deterministic size falsifier');
