import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{createContext,runInContext}from'node:vm';
import{stage}from'./fixture-local.mjs';import{evaluateStartSemanticEvidence}from'./snapshot/source/bench/compare/methodology.mjs';
import{SERVER_PROFILE}from'./snapshot/source/bench/profile/server-profile-registration.mjs';
import{compactServerSemanticEvidence,serverBrowserClockBounds,validateServerBrowserSample}from'./snapshot/source/bench/profile/server-profile-contract.mjs';
const bench=readFileSync(new URL('./snapshot/source/bench/compare/bench.mjs',import.meta.url),'utf8');
const exactSource=bench.slice(bench.indexOf('export async function runSemanticStartCheck('),bench.indexOf('// ─── сценарий S5:')).trim().replace(/^export /,'');
const runCheck=Function('evaluateStartSemanticEvidence',`return (${exactSource})`)(evaluateStartSemanticEvidence);
const own=readFileSync(new URL('./semantic-replay.mjs',import.meta.url),'utf8');
let vmSource=own.slice(own.indexOf('function virtualPage('),own.indexOf('const receipts=[];'));
vmSource=vmSource.replace('rafDelay=16','rafDelay=16,readCostMs=0,timerLagMs=0').replace("getComputedStyle:el=>({transform:String(position(el))})","getComputedStyle:el=>{const transform=String(position(el));clock+=readCostMs;return{transform};}").replace('clock+=ms;queueMicrotask(fn);','clock+=ms+timerLagMs;queueMicrotask(fn);');
// Primary observer log is outside the synthetic time model and does not advance it.
vmSource=vmSource.replace('let clock=100,starts=0,cancels=0;','const observerLog=[];let clock=100,starts=0,cancels=0;')
 .replace("const transform=String(position(el));clock+=readCostMs;return{transform};","const beginMs=clock,transform=String(position(el));clock+=readCostMs;observerLog.push({kind:'CSS',beginMs,endMs:clock,target:targets.indexOf(el),valuePx:Number(transform)});return{transform};")
 .replace('clock+=ms+timerLagMs;queueMicrotask(fn);',"const beginMs=clock;clock+=ms+timerLagMs;observerLog.push({kind:'timer',beginMs,requestedDelayMs:ms,lagMs:timerLagMs,endMs:clock});queueMicrotask(fn);")
 .replace('clock+=rafDelay;queueMicrotask(()=>fn(clock));',"clock+=rafDelay;observerLog.push({kind:'rAF',timestampMs:clock});queueMicrotask(()=>fn(clock));")
 .replace('connected:targets.filter(el=>el.connected).length','connected:targets.filter(el=>el.connected).length,observerLog');
const virtualPage=Function('createContext','runInContext',`return (${vmSource})`)(createContext,runInContext);
const scene=SERVER_PROFILE.browserScenes[0],rows=[];
for(const multiplier of[1,2]){
 const options={durationMultiplier:multiplier,readCostMs:.32,timerLagMs:40},sut=virtualPage(options),sample=stage('aa',2).rows.find(row=>row.scene===scene.id).samples.right;
 const semanticClockErrorMs=serverBrowserClockBounds({beginMs:0,endMs:0},sample.monotonicHostUpperNs).errorMs;
 const config={...scene,...SERVER_PROFILE.browserSemantics,durationMs:128,toPx:300,semanticClockErrorMs};
 const evidence=await runCheck(sut.page,config,1);sample.semanticEvidence=compactServerSemanticEvidence(evidence);
 let accepted=true,error=null;try{validateServerBrowserSample(sample,scene);}catch(cause){accepted=false;error=cause.message;}
 rows.push({synthetic:true,actualTimingSamples:0,registeredDurationMs:128,actualSyntheticDurationMs:128*multiplier,options,accepted,error,evidence,consumerInput:sample,sut:sut.read()});
}
const sourceIdentities=['bench/compare/bench.mjs','bench/compare/methodology.mjs','bench/profile/server-profile-contract.mjs','bench/profile/server-profile-registration.mjs'].map(relative=>({relative,sha256:createHash('sha256').update(readFileSync(new URL('./snapshot/source/'+relative,import.meta.url))).digest('hex')}));
writeFileSync(new URL('./semantic-window-probe-result.json',import.meta.url),JSON.stringify({hypothesis:'wide actual read windows can make incompatible speed compatible, with late terminal timer; no fake clock fields',frozenProducerSha256:createHash('sha256').update(exactSource).digest('hex'),sourceIdentities,independentVmSource:vmSource,rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({actualSyntheticDurationMs,accepted,error,evidence,sut})=>({actualSyntheticDurationMs,accepted,error,producerValid:evidence.valid,checkpoints:evidence.checkpoints.map(c=>({frame:c.frameTimestampMs,start:c.groups[0].readStartedMs,end:c.groups[0].readEndedMs,first:c.groups[0].positions[0],last:c.groups[0].positions.at(-1)})),terminal:evidence.terminal[0][0],sut:{starts:sut.starts,cancels:sut.cancels,connected:sut.connected,CSSreads:sut.observerLog.filter(event=>event.kind==='CSS').length}}))));
