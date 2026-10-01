import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{createContext,runInContext}from'node:vm';import assert from'node:assert/strict';
import{stage}from'./fixture-local.mjs';import{evaluateStartSemanticEvidence}from'./snapshot/source/bench/compare/methodology.mjs';
import{SERVER_PROFILE,serverProfileDigest}from'./snapshot/source/bench/profile/server-profile-registration.mjs';
import{compactServerSemanticEvidence,serverBrowserClockBounds,validateServerBrowserSample}from'./snapshot/source/bench/profile/server-profile-contract.mjs';
import{evaluateStartSemanticEvidence as previousOracle}from'../server-method-measurement-closure-16f31-20261001/snapshot/source/bench/compare/methodology.mjs';
const bench=readFileSync(new URL('./snapshot/source/bench/compare/bench.mjs',import.meta.url),'utf8'),producerSource=bench.slice(bench.indexOf('export async function runSemanticStartCheck('),bench.indexOf('// ─── сценарий S5:')).trim().replace(/^export /,'');
const runCheck=Function('evaluateStartSemanticEvidence',`return (${producerSource})`)(evaluateStartSemanticEvidence);
const own=readFileSync(new URL('./semantic-replay.mjs',import.meta.url),'utf8');let vmSource=own.slice(own.indexOf('function virtualPage('),own.indexOf('const receipts=[];'));
vmSource=vmSource.replace('rafDelay=16','rafDelay=16,readCostMs=0,timerLagMs=0,initialProgress=0').replace('(clock-el.motion.start-el.motion.index*el.motion.gap)/(el.motion.duration*durationMultiplier)','(clock-el.motion.start-el.motion.index*el.motion.gap)/(el.motion.duration*durationMultiplier)+initialProgress')
 .replace("getComputedStyle:el=>({transform:String(position(el))})","getComputedStyle:el=>{const beginMs=clock,transform=String(position(el));clock+=readCostMs;observerLog.push({kind:'CSS',beginMs,endMs:clock,target:targets.indexOf(el),valuePx:Number(transform)});return{transform};}")
 .replace('let clock=100,starts=0,cancels=0;','const observerLog=[];let clock=100,starts=0,cancels=0;')
 .replace('clock+=ms;queueMicrotask(fn);',"const beginMs=clock;clock+=ms+timerLagMs;observerLog.push({kind:'timer',beginMs,requestedDelayMs:ms,lagMs:timerLagMs,endMs:clock});queueMicrotask(fn);")
 .replace('clock+=rafDelay;queueMicrotask(()=>fn(clock));',"clock+=rafDelay;observerLog.push({kind:'rAF',timestampMs:clock});queueMicrotask(()=>fn(clock));")
 .replace('const begin=clock;els.forEach','const begin=clock,beforePx=els.map(position);els.forEach')
 .replace('});clock+=.025;return',"});observerLog.push({kind:'SUT-start',beginMs:begin,beforePx,afterPx:els.map(position),initialProgress});clock+=.025;return")
 .replace('connected:targets.filter(el=>el.connected).length','connected:targets.filter(el=>el.connected).length,observerLog');
const virtualPage=Function('createContext','runInContext',`return (${vmSource})`)(createContext,runInContext);
const rows=[];
for(const[sceneIndex,name,options]of[[0,'healthy128-narrow',{}],[0,'duration64-narrow',{durationMultiplier:.5}],[0,'duration256-narrow',{durationMultiplier:2}],[0,'last-target-quadratic',{quadraticLast:true}],[0,'MC03-healthy128-wide',{readCostMs:.32,timerLagMs:40}],[0,'MC03-duration256-wide',{durationMultiplier:2,readCostMs:.32,timerLagMs:40}],[0,'healthy128-later-resolving',{readCostMs:.001,timerLagMs:40}],[0,'initial-jump75px-shortened-motion',{initialProgress:.25}],[1,'S3-healthy128',{}],[1,'S3-duration64',{durationMultiplier:.5}],[1,'S3-initial-progress-quarter',{initialProgress:.25}]]){
 const scene=SERVER_PROFILE.browserScenes[sceneIndex],sut=virtualPage(options),sample=stage('aa',2).rows.find(row=>row.scene===scene.id).samples.right;
 const clockErrorMs=serverBrowserClockBounds({beginMs:0,endMs:0},sample.monotonicHostUpperNs).errorMs,config={...scene,...SERVER_PROFILE.browserSemantics,semanticClockErrorMs:clockErrorMs,durationMs:128,toPx:300};
 const evidence=await runCheck(sut.page,config,1);sample.semanticEvidence=compactServerSemanticEvidence(evidence);let accepted=true,error=null;try{validateServerBrowserSample(sample,scene);}catch(cause){accepted=false;error=cause.message;}
 const purported=structuredClone(sample);purported.semanticEvidence.valid=true;let purportedAccepted=true,purportedError=null;try{validateServerBrowserSample(purported,scene);}catch(cause){purportedAccepted=false;purportedError=cause.message;}
 assert.equal(sut.read().connected,0);
 rows.push({name,synthetic:true,actualTimingSamples:0,scene,options,clockErrorMs,previous16f31Oracle:previousOracle(evidence,config,1),evidence,consumerInput:sample,accepted,error,purportedAccepted,purportedError,sut:sut.read()});
}
const inputs=['bench/compare/bench.mjs','bench/compare/methodology.mjs','bench/profile/server-profile-contract.mjs','bench/profile/server-profile-registration.mjs'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(new URL('./snapshot/source/'+path,import.meta.url))).digest('hex')}));
writeFileSync(new URL('./semantic-closure-result.json',import.meta.url),JSON.stringify({protocolDigest:serverProfileDigest(SERVER_PROFILE),producerFunctionSha256:createHash('sha256').update(producerSource).digest('hex'),inputs,independentVmSource:vmSource,rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({name,accepted,purportedAccepted,error,purportedError,evidence})=>({name,producerValid:evidence.valid,accepted,purportedAccepted,error,purportedError,frames:evidence.checkpoints.map(c=>({frameMs:c.frameTimestampMs,startMs:c.groups[0].readStartedMs,endMs:c.groups[0].readEndedMs,minPx:Math.min(...c.groups[0].positions),maxPx:Math.max(...c.groups[0].positions)}))}))));
