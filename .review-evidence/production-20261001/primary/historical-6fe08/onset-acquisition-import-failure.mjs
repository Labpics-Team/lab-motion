// Independent deterministic DOM/SUT. This acquires synthetic raw through the exact
// frozen producer callbacks; no physical browser, timings or clock qualification.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import assert from 'node:assert/strict';
import {SERVER_PROFILE,serverProfileDigest} from './snapshot/source/bench/profile/server-profile-registration.mjs';
import {preserveRawNumbers,compactServerSemanticEvidence,serverBrowserClockBounds,validateServerBrowserSample} from './snapshot/source/bench/profile/server-profile-contract.mjs';
import {deriveRealmTimerStep,evaluateStartSemanticEvidence} from './snapshot/source/bench/compare/methodology.mjs';
const bench=readFileSync(new URL('./snapshot/source/bench/compare/bench.mjs',import.meta.url),'utf8');
const semanticSource=bench.slice(bench.indexOf('export async function runSemanticStartCheck('),bench.indexOf('// ─── сценарий S5:')).trim().replace(/^export /,'');
const runSemanticStartCheck=Function('evaluateStartSemanticEvidence',`return (${semanticSource})`)(evaluateStartSemanticEvidence);
const runner=readFileSync(new URL('./snapshot/source/bench/profile/server-profile-runner.mjs',import.meta.url),'utf8');
const timerSource=runner.slice(runner.indexOf('async function browserTimerProbe('),runner.indexOf('export async function measureServerBrowser('));
const browserSource=runner.slice(runner.indexOf('export async function measureServerBrowser('),runner.indexOf('async function measureBrowserRawControls(')).trim().replace(/^export /,'');
// Scheduling/physical timeout behaviour is outside this pure replay. The callback,
// raw acquisition, compaction and producer/consumer validation bytes are exact.
const measure=Function('withBrowserTimeout','SERVER_PROFILE','preserveRawNumbers','readFileSync','serverBrowserClockBounds','compactServerSemanticEvidence','runSemanticStartCheck','deriveRealmTimerStep','validateServerBrowserSample','process',`${timerSource}\nreturn (${browserSource});`)(
  async(task)=>await task,SERVER_PROFILE,preserveRawNumbers,readFileSync,serverBrowserClockBounds,compactServerSemanticEvidence,runSemanticStartCheck,deriveRealmTimerStep,validateServerBrowserSample,{hrtime:{bigint:()=>1000000000000n}});
function independentBrowser(initialProgress){
  let clock=100,starts=0,cancels=0,closed=false;const targets=[],observerLog=[];
  const position=el=>!el.motion?el.x:el.motion.to*Math.max(0,Math.min(1,(clock-el.motion.start-el.motion.index*el.motion.gap)/el.motion.duration+initialProgress));
  const start=(els,to,duration,gap=0)=>{starts++;const beginMs=clock,beforePx=els.map(position);els.forEach((el,index)=>{el.motion={start:beginMs,index,gap,to,duration};});observerLog.push({kind:'SUT-start',call:starts,beginMs,beforePx,afterPx:els.map(position),initialProgress});clock+=.025;return{cancel(){cancels++;const beginMs=clock;els.forEach(el=>{el.x=position(el);el.motion=null;});clock+=.015;observerLog.push({kind:'SUT-cancel',beginMs,endMs:clock,targets:els.length});}};};
  const sandbox={crossOriginIsolated:true,performance:{timeOrigin:1000,now(){clock+=.001;return Math.floor(clock/.005)*.005;}},document:{createElement(){const el={x:0,motion:null,connected:false,get isConnected(){return this.connected;},getAnimations(){return[];},remove(){this.connected=false;}};targets.push(el);return el;},body:{appendChild(el){el.connected=true;}}},getComputedStyle(el){const valuePx=position(el);observerLog.push({kind:'CSS',timestampMs:clock,target:targets.indexOf(el),valuePx});return{transform:String(valuePx)};},DOMMatrixReadOnly:class{constructor(text){this.e=Number(text);}},setTimeout(fn,ms){const beginMs=clock;clock+=ms;observerLog.push({kind:'timer',beginMs,requestedDelayMs:ms,endMs:clock});queueMicrotask(fn);},requestAnimationFrame(fn){clock+=16;observerLog.push({kind:'rAF',timestampMs:clock});queueMicrotask(()=>fn(clock));},__independentStart:start};
  sandbox.window=sandbox;const realm=createContext(sandbox);
  const page={async evaluate(fn,arg){return runInContext(`(${fn.toString()})`,realm)(arg);},async goto(){},async exposeFunction(name,fn){sandbox[name]=fn;}};
  const context={async newPage(){return page;},async close(){closed=true;}};
  return{browser:{async newContext(){return context;}},read(){return{starts,cancels,closed,connected:targets.filter(el=>el.connected).length,clock,observerLog};}};
}
writeFileSync(new URL('./onset-synthetic-adapter.js',import.meta.url),'window.__adapterModule = { start: window.__independentStart, startStagger: window.__independentStart };\n');
const receipts=[];
for(const [name,progress]of[['healthy',0],['initial-progress-quarter',.25]]){
  const fake=independentBrowser(progress),scene=SERVER_PROFILE.browserScenes[0];let sample=null,error=null;
  try{sample=await measure(fake.browser,{url:'synthetic://onset'},{path:new URL('./onset-synthetic-adapter.js',import.meta.url)},scene);}catch(cause){error={message:cause.message,causes:cause.errors?.map(x=>x.message),raw:cause.raw};}
  const sut=fake.read();receipts.push({name,initialProgress:progress,synthetic:true,actualTimingSamples:0,sample,error,sut});
  writeFileSync(new URL('./onset-acquisition-result.json',import.meta.url),JSON.stringify({protocolDigest:serverProfileDigest(SERVER_PROFILE),synthetic:true,actualTimingSamples:0,boundary:'exact frozen semantic and browser sample functions; Promise timeout wrapper and browser/process replaced by explicitly independent deterministic models, not physical timing qualification',semanticFunctionSha256:createHash('sha256').update(semanticSource).digest('hex'),browserFunctionSha256:createHash('sha256').update(browserSource).digest('hex'),timerFunctionSha256:createHash('sha256').update(timerSource).digest('hex'),receipts},null,2)+'\n');
  console.log(JSON.stringify({name,acquired:!!sample,error:error?.message,causes:error?.causes,starts:sut.starts,cancels:sut.cancels,closed:sut.closed,connected:sut.connected,operationCalls:sample?.raw.map(x=>x.calls),leadingWitness:sample?.raw[0].startWitness.leadingPositions,startMs:sample?.startMs,cancelMs:sample?.cancelMs}));
  assert.equal(sut.closed,true);assert.equal(sut.connected,0);assert.equal(error,null);assert(sample);
}
