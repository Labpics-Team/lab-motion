import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.EVIDENCE_ROOT);
const { parse } = await import(pathToFileURL(join(root, 'acorn.mjs')));
const [a, b] = await Promise.all(['baseline', 'candidate'].map(side => import(pathToFileURL(join(root, side, 'dist/compiler/vite/index.js')))));
const base = a.motionCompiler(), candidate = b.motionCompiler();
const sources = [];
const springCases = [undefined, {mass:1,stiffness:170,damping:26}, {mass:1,stiffness:100,damping:20},
  {mass:1,stiffness:100,damping:2}, {mass:1,stiffness:100,damping:80},
  {mass:1,stiffness:170,damping:4,velocity:-5000}, {mass:1,stiffness:170,damping:26,velocity:5}];
const code = (from, to, spring, count = 1) => "import {animate} from '@labpics/motion/animate';\n" +
  Array.from({length:count}, (_, i) => `animate(el${i},{width:[${from},${to}]},{layout:'project'${spring ? ',spring:' + JSON.stringify(spring) : ''}});`).join('\n');
for (const from of [0.125, 1, 120, 240, 360, 1024, 1e6]) {
  for (const to of [0.125, 1, 120, 240, 360, 1024, 1e6]) {
    for (const spring of springCases) sources.push(code(from, to, spring));
  }
}
for (let i = 0; i < 512; i++) sources.push(code(240, 360, {mass:1, stiffness:170*(1+(i+1)*2**-40), damping:26}));
for (const spring of springCases) sources.push(code(240, 360, spring, 8));
const prefix = "import {animate} from '@labpics/motion/animate';\n";
for (const call of [
  "animate(el,{width:[240,width]},{layout:'project'});",
  "const handle=animate(el,{width:[240,360]},{layout:'project'});",
  "function f(){return animate(el,{width:[240,360]},{layout:'project'});}",
  "animate(el,{width:[240,360]},{layout:'project',onFrame(){}});",
  "function f(animate){animate(el,{width:[240,360]},{layout:'project'});}",
  "animate(el,{width:[240,360]},{layout:'project',spring:dynamic});",
]) sources.push(prefix + call);
function evaluate(plugin, source) {
  const ast = parse(source, {ecmaVersion:2022,sourceType:'module'});
  const warnings = [];
  try {
    const output = plugin.transform.call({parse:() => ast, warn:value => warnings.push(String(value))}, source, 'consumer.js');
    return {output:output === undefined ? null : JSON.parse(JSON.stringify(output)), warnings};
  } catch (error) { return {error:{name:error.name,message:error.message},warnings}; }
}
let accepted = 0, rejected = 0, exceptions = 0;
const digest = createHash('sha256');
for (const source of sources) {
  const left = evaluate(base, source), right = evaluate(candidate, source);
  assert.deepEqual(right, left, source);
  digest.update(JSON.stringify(left));
  if (left.error) exceptions++;
  else if (left.output === null) rejected++;
  else accepted++;
}
assert(accepted > 500 && rejected > 5, 'differential must exercise accepted and rejected paths');
const witness = evaluate(base, code(240, 360));
assert(witness.output !== null && !witness.error);
for (const mutant of [
  {...witness,output:null},
  {...witness,output:{...witness.output,code:witness.output.code+'/* altered */'}},
  {...witness,output:{...witness.output,map:{...witness.output.map,mappings:'AAAA-mutated'}}},
]) assert.throws(() => assert.deepEqual(mutant, witness));

const split = String.prototype.split;
function counted(plugin, source) {
  const ast = parse(source, {ecmaVersion:2022,sourceType:'module'});
  let splitCalls = 0;
  String.prototype.split = function(...args) { splitCalls++; return split.apply(this, args); };
  let output;
  try { output = plugin.transform.call({parse:()=>ast,warn:x=>{throw new Error(String(x));}}, source, 'consumer.js'); }
  finally { String.prototype.split = split; }
  return {splitCalls,output:output === undefined ? null : JSON.parse(JSON.stringify(output))};
}
function expectedRemoved(output) {
  if (output === null) return 0;
  const ast = parse(output.code,{ecmaVersion:2022,sourceType:'module'});
  let count = 0;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name.startsWith('__labMotionSurface')) {
      const artifact = node.arguments[1];
      assert.equal(artifact.type,'ObjectExpression');
      for (const key of ['p','q','a']) {
        const literal = artifact.properties.find(property => property.key.name === key).value.value;
        const stops = literal.slice(7,-1).split(',');
        count += 1 + stops.length;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  return count;
}
const work = [];
for (const [name, source] of [['ordinary',code(240,360)],['batch',code(240,360,undefined,8)],
  ['degenerate',code(240,240)],['reject',prefix+"animate(el,{width:[240,width]},{layout:'project'});"]]) {
  const left = counted(base,source), right = counted(candidate,source);
  assert.deepEqual(right.output,left.output);
  const removed = expectedRemoved(left.output);
  assert.equal(left.splitCalls-right.splitCalls,removed,name);
  work.push({name,baseSplitCalls:left.splitCalls,candidateSplitCalls:right.splitCalls,removed});
}
assert(work.find(row=>row.name==='ordinary').removed > 20);
assert.equal(work.find(row=>row.name==='reject').removed,0);

async function files(directory, prefix='') {
  const out=[];
  for (const entry of await readdir(join(directory,prefix),{withFileTypes:true})) {
    const name=join(prefix,entry.name);
    if(entry.isDirectory()) out.push(...await files(directory,name)); else out.push(name);
  }
  return out.sort();
}
const list = await files(join(root,'baseline/dist'));
assert.deepEqual(await files(join(root,'candidate/dist')),list);
const changed=[];
for(const file of list){
  const left=await readFile(join(root,'baseline/dist',file));
  const right=await readFile(join(root,'candidate/dist',file));
  if(!left.equals(right)) changed.push({file,baseBytes:left.length,candidateBytes:right.length});
}
assert(changed.length>0);
assert(changed.every(row=>row.file.startsWith('compiler/vite/')),JSON.stringify(changed));
const receipt={sources:sources.length,accepted,rejected,exceptions,outputSha256:digest.digest('hex'),
  positiveControls:3,work,changedFiles:changed,identicalDistFiles:list.length-changed.length,
  node:process.version,scope:'Exact shipped-byte/output/call-count proof. No wall-clock claim from this oracle.'};
await writeFile(join(root,'independent-equivalence.json'),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt,null,2));
