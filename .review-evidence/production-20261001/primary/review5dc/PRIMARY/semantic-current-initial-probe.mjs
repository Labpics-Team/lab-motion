import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import assert from 'node:assert/strict';
import {stage} from './fixture-local.mjs';
import {SERVER_PROFILE,serverProfileDigest} from './snapshot/source/bench/profile/server-profile-registration.mjs';
import {evaluateStartSemanticEvidence} from './snapshot/source/bench/compare/methodology.mjs';
import {compactServerSemanticEvidence,validateServerBrowserSample,serverBrowserSemanticClockErrorMs} from './snapshot/source/bench/profile/server-profile-contract.mjs';

// Oracle: x=300 clamp((publication-start-i*gap)/(128*factor)); the VM derives
// coordinates without importing the producer's interval/phase acceptance law.
// Wall read cost, publication time and callback execution lag are independent.
function virtualPage(options={}) {
  let wall=100, frame=100, starts=0, cancels=0, frameNumber=0;
  const targets=[],log=[];
  const {durationMultiplier=1,readCostMs=0,timerLagMs=0,rafLagMs=0,initialProgress=0,firstPublicationJump=0,delayedStartMs=0}=options;
  function position(el) {
    if (!el.motion) return el.x;
    const m=el.motion;
    if (m.phase===null) return 300*initialProgress;
    const age=frame-m.phase-m.index*m.gap-delayedStartMs;
    let progress=Math.max(0,Math.min(1,age/(m.duration*durationMultiplier)+initialProgress+firstPublicationJump));
    if(options.quadraticLast&&m.index===m.count-1) progress*=progress;
    if(options.wrongEarlyProgress&&age>0&&age<20) progress=Math.min(1,progress+.2);
    return 300*progress;
  }
  function start(els,to,duration,gap=0) {
    starts++; const before=els.map(position),begin=wall;
    for(const [index,el] of els.entries()) el.motion={phase:null,index,count:els.length,gap,duration};
    wall+=.025;
    log.push({kind:'SUT-start',beginMs:begin,endMs:wall,group:starts,beforePx:before,afterPx:els.map(position)});
    return {cancel(){cancels++;for(const el of els){el.x=position(el);el.motion=null;}log.push({kind:'SUT-cancel',wallMs:wall,group:cancels});}};
  }
  const sandbox={
    window:{__adapterModule:{start,startStagger:start}},
    performance:{now:()=>wall,timeOrigin:1000},
    document:{body:{appendChild(el){el.connected=true;targets.push(el);}},createElement(){return{x:0,motion:null,connected:false,remove(){this.connected=false;}};},
      timeline:{get currentTime(){const v=options.documentClock==='missing'?null:frame+(options.documentClock==='unstable'?(++sandbox.frameReads)*.01:options.documentClock==='unrelated'?1:0);log.push({kind:'document',wallMs:wall,valueMs:v});return v;}}},
    frameReads:0,
    DOMMatrixReadOnly:class{constructor(value){this.e=Number(value);}},
    getComputedStyle(el){const begin=wall,value=position(el);wall+=readCostMs;log.push({kind:'CSS',beginMs:begin,endMs:wall,target:targets.indexOf(el),valuePx:value,publicationMs:frame});return{transform:String(value)};},
    setTimeout(fn,delay){const begin=wall;wall+=delay+timerLagMs;frame=wall;log.push({kind:'timer',beginMs:begin,delayMs:delay,lagMs:timerLagMs,endMs:wall});queueMicrotask(fn);},
    requestAnimationFrame(fn){wall+=16;frame=wall;frameNumber++;for(const el of targets)if(el.motion?.phase===null)el.motion.phase=frame;wall+=rafLagMs;log.push({kind:'rAF',timestampMs:frame,executionWallMs:wall,frameNumber});queueMicrotask(()=>fn(frame));},
    queueMicrotask,console
  };
  const context=createContext(sandbox);
  return {page:{evaluate(fn,arg){return runInContext('('+fn.toString()+')',context)(arg);}},read(){return{starts,cancels,connected:targets.filter(el=>el.connected).length,frameNumber,observerLog:log};}};
}
const bench=readFileSync(new URL('./snapshot/source/bench/compare/bench.mjs',import.meta.url),'utf8');
const producerSource=bench.slice(bench.indexOf('export async function runSemanticStartCheck('),bench.indexOf('// ─── сценарий S5:')).trim().replace(/^export /,'');
const producer=Function('evaluateStartSemanticEvidence',`return (${producerSource})`)(evaluateStartSemanticEvidence);
const cases=[
  [0,'healthy128',{},true], [0,'duration64',{durationMultiplier:.5},false], [0,'duration256',{durationMultiplier:2},false],
  [0,'last-target-quadratic',{quadraticLast:true},false],
  [0,'healthy128-wide32ms-lag40',{readCostMs:.32,rafLagMs:40},true],
  [0,'duration256-wide32ms-lag40',{durationMultiplier:2,readCostMs:.32,rafLagMs:40},false],
  [0,'instant-quarter-before-first-publication',{initialProgress:.25},false],
  [0,'quarter-at-first-publication',{firstPublicationJump:.25},false],
  [0,'document-clock-missing',{documentClock:'missing'},false],
  [0,'document-clock-unstable',{documentClock:'unstable'},false],
  [0,'document-clock-unrelated',{documentClock:'unrelated'},false],
  [0,'delayed-full128-path',{delayedStartMs:16},true],
  [0,'transient-early-wrong-curve-between-cuts',{wrongEarlyProgress:true},true],
  [1,'S3-healthy128',{},true], [1,'S3-duration64',{durationMultiplier:.5},false],
  [1,'S3-quarter-at-first-publication',{firstPublicationJump:.25},false]
];
const rows=[];
for (const [index,name,options,expected] of cases) {
  const scene=SERVER_PROFILE.browserScenes[index],sample=stage('aa',2).rows.find(row=>row.scene===scene.id).samples.right;
  const error=serverBrowserSemanticClockErrorMs(sample.monotonicHostUpperNs);
  const config={...scene,...SERVER_PROFILE.browserSemantics,semanticClockErrorMs:error,durationMs:128,toPx:300};
  const sut=virtualPage(options),evidence=await producer(sut.page,config,1);
  sample.semanticEvidence=compactServerSemanticEvidence(evidence);
  let accepted=true,message=null;try{validateServerBrowserSample(sample,scene);}catch(e){accepted=false;message=e.message;}
  const purported=structuredClone(sample);purported.semanticEvidence.valid=true;
  let consumerAccepted=true,consumerMessage=null;try{validateServerBrowserSample(purported,scene);}catch(e){consumerAccepted=false;consumerMessage=e.message;}
  assert.equal(sut.read().connected,0,'targets cleanup');
  rows.push({name,expected,synthetic:true,actualRegisteredTimingSamples:0,options,scene,semanticClockErrorMs:error,evidence,consumerInput:sample,producerValid:evidence.valid,accepted,message,consumerAccepted,consumerMessage,sut:sut.read()});
}
const inputs=['bench/compare/bench.mjs','bench/compare/methodology.mjs','bench/profile/server-profile-contract.mjs','bench/profile/server-profile-registration.mjs'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(new URL('./snapshot/source/'+path,import.meta.url))).digest('hex')}));
writeFileSync(new URL('./semantic-current-result.json',import.meta.url),JSON.stringify({protocolDigest:serverProfileDigest(SERVER_PROFILE),producerFunctionSha256:createHash('sha256').update(producerSource).digest('hex'),inputs,rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({name,expected,producerValid,accepted,consumerAccepted,consumerMessage,evidence})=>({name,expected,producerValid,accepted,consumerAccepted,consumerMessage,firstFrame:evidence.onset.firstFrame?.frameTimestampMs,checkpoints:evidence.checkpoints.map(c=>({documentMs:c.groups[0].documentFrame.beforeMs,wallBeginMs:c.groups[0].readStartedMs,wallEndMs:c.groups[0].readEndedMs,minPx:Math.min(...c.groups[0].positions),maxPx:Math.max(...c.groups[0].positions)}))})),null,2));
assert.equal(rows.filter(r=>r.consumerAccepted!==r.expected).length,0,'independent predicted healthy/fault classifications');
