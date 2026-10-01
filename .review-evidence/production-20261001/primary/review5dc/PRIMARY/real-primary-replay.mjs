import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import assert from'node:assert/strict';
import{stage}from'./fixture-local.mjs';import{SERVER_PROFILE,serverProfileDigest}from'./snapshot/source/bench/profile/server-profile-registration.mjs';
import{evaluateStartSemanticEvidence}from'./snapshot/source/bench/compare/methodology.mjs';
import{compactServerSemanticEvidence,serverBrowserSemanticClockErrorMs,validateServerBrowserSample}from'./snapshot/source/bench/profile/server-profile-contract.mjs';
const primary=JSON.parse(readFileSync(new URL('./real-primary/semantic-only-result.json',import.meta.url)));
assert.equal(primary.protocolDigest,serverProfileDigest(SERVER_PROFILE));
const sources=primary.source.map(r=>{const sha256=createHash('sha256').update(readFileSync(new URL('./snapshot/source/'+r.name,import.meta.url))).digest('hex');assert.equal(sha256,r.sha256);return{...r,exactFrozenSourceMatched:true};});
const bundleSha256=createHash('sha256').update(readFileSync(new URL('./real-primary/candidate.iife.js',import.meta.url))).digest('hex');assert.equal(bundleSha256,primary.adapter.sha256);
assert.equal(primary.browser.sha256,SERVER_PROFILE.clockError.browserExecutableSha256);assert.equal(primary.node.sha256,SERVER_PROFILE.clockError.nodeExecutableSha256);
const rows=primary.rows.map(r=>{
 const e=r.evidence,error=serverBrowserSemanticClockErrorMs(r.monotonicHostUpperNs),config={...r.scene,...SERVER_PROFILE.browserSemantics,durationMs:128,toPx:300,semanticClockErrorMs:error};
 const producerReplayed=evaluateStartSemanticEvidence(e,config,1);assert(producerReplayed);
 const sample=stage('aa',2).rows.find(s=>s.scene===r.scene.id).samples.right;sample.semanticEvidence=compactServerSemanticEvidence({...e,valid:true});sample.monotonicHostUpperNs=r.monotonicHostUpperNs;validateServerBrowserSample(sample,r.scene);
 const slope=300/128,pairs=[],positions=[e.onset.firstFrame,...e.checkpoints];
 let phaseLow=-Infinity,phaseHigh=Infinity;
 for(const p of positions){for(const g of p.groups){assert.equal(g.documentFrame.beforeMs,g.documentFrame.afterMs);assert(Math.abs(g.documentFrame.beforeMs-p.frameTimestampMs)<=error);for(const[x,i]of g.positions.map((x,i)=>[x,i])){if(x<298)phaseLow=Math.max(phaseLow,g.documentFrame.beforeMs-error-i*r.scene.staggerGapMs-(x+.5)/slope);if(x>=.5)phaseHigh=Math.min(phaseHigh,g.documentFrame.afterMs+error-i*r.scene.staggerGapMs-(x-.5)/slope);}}}
 assert(phaseLow<=phaseHigh);
 for(let a=0;a<e.checkpoints.length;a++)for(let b=a+1;b<e.checkpoints.length;b++){const left=e.checkpoints[a].groups[0],right=e.checkpoints[b].groups[0],deltaMs=right.documentFrame.beforeMs-left.documentFrame.beforeMs;const targets=Array.from({length:r.scene.targetsPerCall},(_,i)=>i).filter(i=>left.positions[i]>=.5&&left.positions[i]<298&&right.positions[i]>=.5&&right.positions[i]<298);if(targets.length){const deviations=targets.map(i=>right.positions[i]-left.positions[i]-slope*deltaMs);assert(deviations.every(x=>Math.abs(x)+slope*2*error<=1));pairs.push({a,b,deltaMs,interiorTargets:targets.length,maxAbsoluteSlopeResidualPx:Math.max(...deviations.map(Math.abs)),clockDisplacementErrorPx:slope*2*error});}}
 assert(pairs.length>0);assert.equal(r.observed.remainingElements,0);assert.equal(r.observed.activeNative,0);
 return{scene:r.scene,actualRegisteredTimingSamples:0,primaryDiagnostic:true,ownBrowserExecution:false,producerReplayed,consumerAccepted:true,phase:{low:phaseLow,high:phaseHigh},pairs,firstFrame:{timestamp:e.onset.firstFrame.frameTimestampMs,zeros:e.onset.firstFrame.groups.every(g=>g.positions.every(x=>Math.abs(x)<=.5))},remainingElements:r.observed.remainingElements,activeNative:r.observed.activeNative};
});
const result={actualRegisteredTimingSamples:0,primarySha256:createHash('sha256').update(readFileSync(new URL('./real-primary/semantic-only-result.json',import.meta.url))).digest('hex'),sources,bundleSha256,artifactTarSha256:primary.tarball.sha256,packageTree:primary.packageTree,rows,limits:'Real supplied normal-motion observations replayed; timing/calibration/power/physical hardware claims absent. Synthetic API-cost fields used only as consumer shell.'};
writeFileSync(new URL('./real-primary-replay-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
