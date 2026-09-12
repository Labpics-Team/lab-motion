import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
// node analyze.mjs <exact-repo> <artifact/paired> <output> <aa|double|ab> <main|waapi> <profile-index>
const [root,input,out,kind,engine,indexText]=process.argv.slice(2),index=Number(indexText);
const {pairedClusterBootstrap,evaluatePerformanceClaim}=await import(pathToFileURL(resolve(root,'bench/compare/methodology.mjs')));
const raw=JSON.parse(readFileSync(`${input}/${kind}.json`,'utf8'));
const expected={aa:8,double:4,ab:16}[kind];
assert.equal(raw.blocks,expected);assert.equal(raw.rows.length,expected);
for(const row of raw.rows)assert.deepEqual(row.order,row.run%2?['candidate','base']:['base','candidate']);
const result=[];
const first=raw.rows[0].base[engine].rows[index];
for(const metric of Object.keys(first.samples[0])){
 const clusters=id=>raw.rows.map(row=>{
  const participant=row[id][engine],profile=participant.rows[index];
  assert.equal(profile.motion,first.motion);assert.equal(profile.count,first.count);assert.equal(profile.samples.length,80);
  assert.equal(participant.multiplier,kind==='double'&&id==='candidate'?2:1);
  if(engine==='main'){
   assert.equal(profile.semantic.lastValueHash,row.base[engine].rows[index].semantic.lastValueHash);
   assert.equal(profile.semantic.totalWrites,60*profile.count);
  }
  return {run:row.run,samples:profile.samples.map(s=>s[metric]),semantic:profile.semantic.valid};
 });
 const evidence=pairedClusterBootstrap(clusters('candidate'),clusters('base'),{seed:20260912,iterations:10000});
 // Внутренние наблюдения не усредняются в медианы пар: SSOT сохраняет
 // настоящий p95 и ресэмплирует целые парные run-кластеры.
 const admission=evaluatePerformanceClaim(evidence,{absoluteThreshold:0,holmAccepted:false});
 result.push({kind,engine,motion:first.motion,count:first.count,metric,...evidence,
  p95NonInferiority:admission.gates.p95NonInferiority,
  aaP50Resolved:evidence.p50.low>=.95&&evidence.p50.high<=1.05,
  aaP95Resolved:evidence.p95.low>=.95&&evidence.p95.high<=1.05,
  p50ExcludesZeroRegression:evidence.p50.low>1,
  p95ExtraWorkDetected:evidence.p95.low>1.5,
  p50ExtraWorkDetected:evidence.p50.low>1.5});
}
mkdirSync(out,{recursive:true});writeFileSync(`${out}/${kind}-${engine}-${index}.json`,JSON.stringify(result,null,2));
for(const row of result)console.log(JSON.stringify(row));
