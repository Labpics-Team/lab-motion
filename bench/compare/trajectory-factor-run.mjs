import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import assert from 'node:assert/strict';
import {validateFactorRows} from './trajectory-factor-cases.mjs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  prepareBenchmarkCheckout, assertCheckoutUnchanged, assertFileHashesUnchanged,
  assertInstalledPackageTreesUnchanged, sha256File, sha256Bytes,
} from './provenance.mjs';

const [baseArg, candidateArg, outputArg] = process.argv.slice(2);
if (!baseArg || !candidateArg || !outputArg) throw Error('Usage: node trajectory-factor-run.mjs <clean-base-checkout> <clean-candidate-checkout> <output>');
const base = resolve(baseArg), candidate = resolve(candidateArg), out = resolve(outputArg);
const benchDirectory = import.meta.dirname;
const scripts = Object.fromEntries(['trajectory-factor-run.mjs','trajectory-factor-probe.mjs','trajectory-factor-browser.mjs','trajectory-factor-cases.mjs','provenance.mjs'].map(name=>{
  const path=join(benchDirectory,name);return [name,{path,sha256:sha256File(path)}];
}));
const requiredInputs = Object.entries(scripts).map(([name,s])=>[name,s.path]);
const prepare = root=>prepareBenchmarkCheckout({
  root, benchDirectory, requiredDist:['dist/motion/index.js','dist/frame/index.js'],
  requiredInputs, requiredPackages:['playwright'], requiredRootPackages:['tsup','typescript','esbuild'],
});
function invoke(cmd,args,cwd,shell=false){
  const r=spawnSync(cmd,args,{cwd,shell,encoding:'utf8',maxBuffer:32*1024*1024});
  if(r.status!==0)throw Error(r.error?.message??r.stderr??'command failed');
  return r;
}
// Both revisions must use the same dependency installation and the same size rules.
assert.equal(realpathSync(join(base,'node_modules')),realpathSync(join(candidate,'node_modules')),'share one installed root toolchain across both clean checkouts');
for(const file of ['package.json','pnpm-lock.yaml','scripts/size-gate.mjs','scripts/compression-oracle.mjs'])
  assert.equal(sha256File(join(base,file)),sha256File(join(candidate,file)),file+' differs');
const builds = {baseline:prepare(base),candidate:prepare(candidate)};
assert.deepEqual(builds.baseline.environment,builds.candidate.environment,'toolchain changed between arms');
const sizes = Object.fromEntries(Object.entries({baseline:base,candidate}).map(([name,root])=>{
  const r=invoke('pnpm',['size'],root,process.platform==='win32');return [name,r.stdout];
}));
const records = {};
for(const [name,script,args] of [
  ['node-evidence','trajectory-factor-probe.mjs',['--expose-gc']],
  ['node-aa','trajectory-factor-probe.mjs',['--expose-gc']],
  ['browser-evidence','trajectory-factor-browser.mjs',[]],
  ['browser-aa','trajectory-factor-browser.mjs',[]],
]){
  const dest=name.endsWith('-aa')?base:candidate;
  const r=invoke(process.execPath,[...args,scripts[script].path,join(base,'dist'),join(dest,'dist')],benchDirectory);
  const lines=r.stdout.trim().split(/\r?\n/);validateFactorRows(lines.map(line=>JSON.parse(line)),name.startsWith('browser'));
  records[name]={data:lines.join('\n')+'\n',diagnostic:r.stderr.trim()};
  console.log(name+' verified '+lines.length+' rows');
}
assertCheckoutUnchanged(base,builds.baseline);
assertCheckoutUnchanged(candidate,builds.candidate);
assertFileHashesUnchanged(scripts);
assertInstalledPackageTreesUnchanged(benchDirectory,builds.candidate.environment.packages);
for(const [name,root] of Object.entries({baseline:base,candidate}))assertInstalledPackageTreesUnchanged(root,builds[name].environment.rootPackages);
mkdirSync(out,{recursive:true});
for(const [name,record] of Object.entries(records))writeFileSync(join(out,name+'.jsonl'),record.data);
writeFileSync(join(out,'size-baseline.txt'),sizes.baseline);
writeFileSync(join(out,'size-candidate.txt'),sizes.candidate);
const receipt={schemaVersion:1,builds,scripts:Object.fromEntries(Object.entries(scripts).map(([name,s])=>[name,s.sha256])),
  rows:Object.fromEntries(Object.entries(records).map(([name,r])=>[name,{sha256:sha256Bytes(r.data),diagnostic:r.diagnostic}])),
  sizeReports:{baseline:sha256Bytes(sizes.baseline),candidate:sha256Bytes(sizes.candidate)}};
writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log('Receipt verified; raw observations saved.');
