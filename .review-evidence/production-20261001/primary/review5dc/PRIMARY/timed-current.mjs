import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import assert from'node:assert/strict';
import{stage}from'./fixture-local.mjs';
import{SERVER_PROFILE}from'./snapshot/source/bench/profile/server-profile-registration.mjs';
import{validateServerBrowserSample,serverBrowserClockBounds,compactServerSemanticEvidence}from'./snapshot/source/bench/profile/server-profile-contract.mjs';
const rows=[];const scene=SERVER_PROFILE.browserScenes[0];
function test(name,mutate,expected){const input=stage('aa',2).rows.find(r=>r.scene==='s2').samples.right;mutate(input);let accepted=true,message=null;try{validateServerBrowserSample(input,scene);}catch(e){accepted=false;message=e.message;}rows.push({name,expected,accepted,message,input});assert.equal(accepted,expected,name);}
test('healthy-coherent-current-all-fields',()=>{},true);
test('timed-leading75-inside-global34ms-bound',s=>{s.raw[0].startWitness.leadingPositions.value=75;},true);
test('timed-leading100-outside-global34ms-bound',s=>{s.raw[0].startWitness.leadingPositions.value=100;},false);
test('timed-small-batch-quarter75',s=>{for(const r of[...s.raw,...s.warmup]){r.startClock.endMs=r.startClock.beginMs+.8;r.batchStartMs=r.startClock.endMs-r.startClock.beginMs;r.startMs=r.batchStartMs/32;r.startWitness.readClock={beginMs:r.startClock.endMs+.1,endMs:r.startClock.endMs+.2};r.startWitness.leadingPositions.value=75;r.cancelClock={beginMs:r.startWitness.readClock.endMs+1,endMs:r.startWitness.readClock.endMs+17};}s.startMs=s.raw.reduce((sum,r)=>sum+r.startMs,0)/8;},false);
test('timed-endpoint-snap',s=>{s.raw[0].startWitness.leadingPositions.value=300;},false);
test('timed-cancel-survivor-target',s=>{s.raw[0].cancelWitness.frames[1].transforms={encoding:'rle',count:3200,runs:[[3199,0],[1,3]]};},false);
test('first-publication-last-target-quarter',s=>{s.semanticEvidence.onset.firstFrame.groups[0].positions={encoding:'rle',count:100,runs:[[99,0],[1,75]]};},false);
const inputs=['bench/profile/server-profile-contract.mjs','bench/compare/methodology.mjs'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(new URL('./snapshot/source/'+path,import.meta.url))).digest('hex')}));
writeFileSync(new URL('./timed-current-result.json',import.meta.url),JSON.stringify({actualRegisteredTimingSamples:0,inputs,rows},null,2)+'\n');console.log(JSON.stringify(rows.map(({name,expected,accepted,message})=>({name,expected,accepted,message}))));
