import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import assert from 'node:assert/strict';
import {stage} from './fixture-local.mjs';
import {evaluateStartSemanticEvidence} from './snapshot/source/bench/compare/methodology.mjs';
import {SERVER_PROFILE,serverProfileDigest} from './snapshot/source/bench/profile/server-profile-registration.mjs';
import {compactServerSemanticEvidence,serverBrowserClockBounds,validateServerBrowserSample} from './snapshot/source/bench/profile/server-profile-contract.mjs';
const bench=readFileSync(new URL('./snapshot/source/bench/compare/bench.mjs',import.meta.url),'utf8');
const exactSource=bench.slice(bench.indexOf('export async function runSemanticStartCheck('),bench.indexOf('// ─── сценарий S5:')).trim().replace(/^export /,'');
const runCheck=Function('evaluateStartSemanticEvidence',`return (${exactSource})`)(evaluateStartSemanticEvidence);
// Independent synthetic DOM/SUT: real time is an explicit deterministic state, no browser.
function virtualPage({durationMultiplier=1,quadraticLast=false,rafDelay=16}={}){
 let clock=100,starts=0,cancels=0;const targets=[];
 const position=el=>{if(!el.motion)return el.x;const p=Math.max(0,Math.min(1,(clock-el.motion.start-el.motion.index*el.motion.gap)/(el.motion.duration*durationMultiplier)));return el.motion.to*(quadraticLast&&el.motion.last?p*p:p);};
 const start=(els,to,duration,gap=0)=>{starts++;const begin=clock;els.forEach((el,index)=>{el.motion={start:begin,index,last:index===els.length-1,gap,to,duration};});clock+=.025;return{cancel(){cancels++;els.forEach(el=>{el.x=position(el);el.motion=null;});}};};
 const sandbox={performance:{now(){clock+=.001;return Math.floor(clock/.005)*.005;}},document:{createElement(){const el={x:0,motion:null,connected:false,remove(){el.connected=false;}};targets.push(el);return el;},body:{appendChild(el){el.connected=true;}}},getComputedStyle:el=>({transform:String(position(el))}),DOMMatrixReadOnly:class{constructor(text){this.e=Number(text);}},setTimeout(fn,ms){clock+=ms;queueMicrotask(fn);},requestAnimationFrame(fn){clock+=rafDelay;queueMicrotask(()=>fn(clock));},__adapterModule:{start,startStagger:start}};
 sandbox.window=sandbox;const realm=createContext(sandbox);
 return{page:{async evaluate(fn,arg){return runInContext(`(${fn.toString()})`,realm)(arg);}},read(){return{starts,cancels,connected:targets.filter(el=>el.connected).length};}};
}
const receipts=[];
for(const [sceneIndex,name,options,expected] of [[0,'S2-duration128',{},true],[0,'S2-duration64',{durationMultiplier:.5},false],[0,'S2-duration256',{durationMultiplier:2},false],[0,'S2-last-target-quadratic',{quadraticLast:true},false],[1,'S3-duration128',{},true],[1,'S3-duration64',{durationMultiplier:.5},false],[0,'S2-late-saturated-raf',{rafDelay:160},false]]){
 const scene=SERVER_PROFILE.browserScenes[sceneIndex],sut=virtualPage(options);
 const sample=stage('aa',2).rows.find(row=>row.scene===scene.id).samples.right;
 const semanticClockErrorMs=serverBrowserClockBounds({beginMs:0,endMs:0},sample.monotonicHostUpperNs).errorMs;
 const config={...scene,...SERVER_PROFILE.browserSemantics,durationMs:128,toPx:300,semanticClockErrorMs};
 const acquired=await runCheck(sut.page,config,1),compacted=compactServerSemanticEvidence(acquired);sample.semanticEvidence=compacted;
 let accepted=true,error=null;try{validateServerBrowserSample(sample,scene);}catch(cause){accepted=false;error=cause.message;}
 // Test consumer arithmetic even when an upstream boolean dishonestly says valid.
 const purportedValid=structuredClone(compacted);purportedValid.valid=true;sample.semanticEvidence=purportedValid;
 let purportedValidAccepted=true,purportedValidError=null;try{validateServerBrowserSample(sample,scene);}catch(cause){purportedValidAccepted=false;purportedValidError=cause.message;}
 const slopes=acquired.checkpoints.slice(1).map((checkpoint,index)=>{const previous=acquired.checkpoints[index],a=previous.groups[0],b=checkpoint.groups[0];return{frameDeltaMs:checkpoint.frameTimestampMs-previous.frameTimestampMs,firstTargetDisplacement:b.positions[0]-a.positions[0],lastTargetDisplacement:b.positions.at(-1)-a.positions.at(-1),registeredSlopePxPerMs:300/128};});
 assert.equal(accepted,expected,name);assert.equal(purportedValidAccepted,expected,name+' consumer numeric');assert.equal(acquired.valid,expected,name+' producer');assert.equal(sut.read().connected,0);
 receipts.push({name,synthetic:true,actualTimingSamples:0,options,expected,accepted,error,purportedValidAccepted,purportedValidError,slopes,acquired,compacted,sut:sut.read()});
}
writeFileSync(new URL('./semantic-replay-result.json',import.meta.url),JSON.stringify({protocol:serverProfileDigest(SERVER_PROFILE),frozenFunctionSha256:createHash('sha256').update(exactSource).digest('hex'),receipts},null,2)+'\n');
console.log(JSON.stringify(receipts.map(({name,accepted,error,purportedValidAccepted,purportedValidError,slopes,sut})=>({name,accepted,error,purportedValidAccepted,purportedValidError,slopes,sut}))));
