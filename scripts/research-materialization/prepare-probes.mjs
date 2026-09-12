import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from './base/node_modules/.pnpm/node_modules/acorn/dist/acorn.mjs';
const sha = s=>createHash('sha256').update(s).digest('hex');
const manifest={};
for(const side of ['base','candidate']) {
 const file=`${side}/dist/compiler/vite/index.js`,code=fs.readFileSync(file,'utf8');
 const ast=parse(code,{ecmaVersion:'latest',sourceType:'module'}),matches=[];
 const walk=n=>{if(!n||typeof n!=='object')return;
  if(n.type==='FunctionExpression'&&n.params.length===6&&code.slice(n.start,n.end).includes('reciprocalSamples'))matches.push(n);
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);
 };walk(ast);
 if(matches.length!==1)throw new Error('ambiguous artifact function '+side);
 const caches=[];
 for(const n of ast.body)if(n.type==='VariableDeclaration')for(const d of n.declarations){
  if(d.init?.type!=='ObjectExpression')continue;
  const p=d.init.properties;
  if(p.some(x=>x.value.type==='NewExpression'&&x.value.callee.name==='Map')&&p.some(x=>x.value.value===256))caches.push(d);
 }
 if(caches.length!==1)throw new Error('ambiguous cache '+side);
 const cache=caches[0],name=cache.id.name,props=cache.init.properties;
 const map=props.find(x=>x.value.type==='NewExpression').key.name;
 const links=props.filter(x=>x.value.type==='UnaryExpression'&&x.value.operator==='void').map(x=>x.key.name);
 if(links.length!==2)throw new Error('bad links');
 const body=code.slice(matches[0].start,matches[0].end);
 const suffix=`\n// Research-only lift: function body above is copied byte-for-byte; never shipped.\nexport const __surfaceProbe=${body};\nexport function __clearSurfaceCache(){${name}.${map}.clear();${links.map(k=>`${name}.${k}=void 0;`).join('')}}\n`;
 fs.writeFileSync(`${side}/dist/compiler/vite/surface-probe.js`,code+suffix);
 manifest[side]={distSha256:sha(code),functionSha256:sha(body),functionBytes:body.length,cache:name,map,links};
 const m=await import(`./${side}/dist/compiler/vite/surface-probe.js`);
 const a=m.__surfaceProbe({mass:1,stiffness:170,damping:26},240,360);
 console.log(side,a.reciprocalSamples.length/2,a.durationMs,a.reciprocalEasing.slice(0,45));
 m.__clearSurfaceCache();
}
fs.writeFileSync('probe-manifest.json',JSON.stringify(manifest,null,2));
