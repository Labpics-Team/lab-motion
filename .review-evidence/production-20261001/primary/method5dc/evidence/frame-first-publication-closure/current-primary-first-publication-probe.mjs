// Независимая линейная VM задаёт движение; existing owner приобретает raw.
// Это synthetic validation, а не performance samples или selection N.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {stage,syntheticBrowser,syntheticSemanticControl} from './current-fixtures.mjs';
import {SERVER_PROFILE,serverProfileDigest} from '/workspace/lab-motion/bench/profile/server-profile-registration.mjs';
import {compactServerSemanticEvidence,validateServerBrowserSample} from '/workspace/lab-motion/bench/profile/server-profile-contract.mjs';
const definitions=[[0,'healthy128-narrow',{}],[0,'duration64-narrow',{durationMultiplier:.5}],[0,'duration256-narrow',{durationMultiplier:2}],
 [0,'quadratic-motion',{shape:'quadratic'}],[0,'MC03-healthy128-wide',{readCostMs:.32,timerLagMs:40}],
 [0,'MC03-duration256-wide',{durationMultiplier:2,readCostMs:.32,timerLagMs:40}],
 [0,'healthy128-later-resolving',{readCostMs:.001,timerLagMs:40}],
 [0,'initial-jump75px-shortened-motion',{initialProgress:.25}],[1,'S3-healthy128',{}],
 [1,'S3-duration64',{durationMultiplier:.5}],[1,'S3-initial-progress-quarter',{initialProgress:.25}],
 [0,'stale50-healthy-s2',{documentOriginLagMs:50}],[1,'stale50-healthy-s3',{documentOriginLagMs:50}],
 [0,'stale50-first-quarter-s2',{documentOriginLagMs:50,quarterAtFrame:1}],
 [0,'stale50-late-quarter-s2',{documentOriginLagMs:50,quarterAtFrame:2}],
 [1,'stale50-first-quarter-s3',{documentOriginLagMs:50,quarterAtFrame:1}],
 [1,'stale50-late-quarter-s3',{documentOriginLagMs:50,quarterAtFrame:2}]];
const rows=[];
for(const[index,name,options]of definitions){
 const scene=SERVER_PROFILE.browserScenes[index],fake=syntheticBrowser(options);
 try{
  const evidence=await syntheticSemanticControl(fake,scene),sample=stage('aa',2).rows.find(row=>row.scene===scene.id).samples.right;
  sample.semanticEvidence=compactServerSemanticEvidence(evidence);
  let accepted=true,error=null;try{validateServerBrowserSample(sample,scene);}catch(cause){accepted=false;error=cause.message;}
  const purported=structuredClone(sample);purported.semanticEvidence.valid=true;
  let purportedAccepted=true,purportedError=null;try{validateServerBrowserSample(purported,scene);}catch(cause){purportedAccepted=false;purportedError=cause.message;}
  assert.equal(fake.read().connected,0);
  const expectedHealthy=['healthy128-narrow','healthy128-later-resolving','S3-healthy128','stale50-healthy-s2','stale50-healthy-s3'].includes(name);
  assert.equal(accepted,expectedHealthy,name);assert.equal(purportedAccepted,expectedHealthy,name);
  assert(evidence.onset.firstFrame);assert(evidence.checkpoints.every(point=>point.groups.every(group=>group.documentFrame)));
  rows.push({name,synthetic:true,actualTimingSamples:0,scene,options,evidence,consumerInput:sample,accepted,error,purportedAccepted,purportedError,sut:fake.read()});
 }finally{fake.dispose();}
}
const root='/workspace/lab-motion',source=['bench/compare/bench.mjs','bench/compare/methodology.mjs','bench/profile/server-profile-contract.mjs','bench/profile/server-profile-registration.mjs','test/server-profile-contract.test.ts'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(root+'/'+path)).digest('hex')}));
writeFileSync(new URL('./current-primary-first-publication-result.json',import.meta.url),JSON.stringify({protocolDigest:serverProfileDigest(SERVER_PROFILE),source,rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({name,accepted,purportedAccepted,error,purportedError})=>({name,accepted,purportedAccepted,error,purportedError}))));
