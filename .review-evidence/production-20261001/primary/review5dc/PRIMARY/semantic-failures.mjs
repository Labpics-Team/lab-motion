import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{createContext,runInContext}from'node:vm';import assert from'node:assert/strict';
import{SERVER_PROFILE}from'./snapshot/source/bench/profile/server-profile-registration.mjs';
import{compactServerSemanticEvidence,serverBrowserSemanticClockErrorMs}from'./snapshot/source/bench/profile/server-profile-contract.mjs';
import{evaluateStartSemanticEvidence}from'./snapshot/source/bench/compare/methodology.mjs';
const own=readFileSync(new URL('./semantic-current.mjs',import.meta.url),'utf8');
let vmSource=own.slice(own.indexOf('function virtualPage('),own.indexOf('const bench='));
vmSource=vmSource.replace('getComputedStyle(el){const begin=wall,value=position(el);',`getComputedStyle(el){if(options.failureCss&&targets.indexOf(el)===17&&starts===options.failureCss.starts&&frameNumber===options.failureCss.frame) throw new Error('own synthetic acquired CSS failure'); const begin=wall,value=position(el);`)
 .replace("log.push({kind:'SUT-cancel',wallMs:wall,group:cancels});", "log.push({kind:'SUT-cancel',wallMs:wall,group:cancels});if(options.failureCancel)throw undefined;");
const vm=Function('createContext','runInContext',`return (${vmSource})`)(createContext,runInContext);
const bench=readFileSync(new URL('./snapshot/source/bench/compare/bench.mjs',import.meta.url),'utf8');
const producerSource=bench.slice(bench.indexOf('export async function runSemanticStartCheck('),bench.indexOf('// ─── сценарий S5:')).trim().replace(/^export /,'');
const producer=Function('evaluateStartSemanticEvidence',`return (${producerSource})`)(evaluateStartSemanticEvidence);
const rows=[];
for(const[name,options]of[['before-prefix',{failureCss:{starts:0,frame:0}}],['after-prefix',{failureCss:{starts:1,frame:0}}],['first-publication-prefix',{failureCss:{starts:1,frame:1}}],['checkpoint-prefix',{failureCss:{starts:1,frame:2}}],['cancel-undefined',{failureCancel:true}]]){
 const scene=SERVER_PROFILE.browserScenes[0],config={...scene,...SERVER_PROFILE.browserSemantics,semanticClockErrorMs:serverBrowserSemanticClockErrorMs('1000000000000'),durationMs:128,toPx:300},sut=vm(options),evidence=await producer(sut.page,config,1),compact=compactServerSemanticEvidence(evidence);
 assert.equal(evidence.valid,false);assert.equal(evidence.failures.length,1);assert.equal(sut.read().connected,0);
 function expand(v){if(v?.encoding==='rle')return v.runs.flatMap(([n,x])=>Array(n).fill(x));if(Array.isArray(v))return v.map(expand);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x)]));return v;}
 assert.equal(JSON.stringify(expand(compact)),JSON.stringify(evidence));
 const groups=[...(evidence.onset?.before??[]),...(evidence.onset?.after??[]),...(evidence.onset?.firstFrame?.groups??[]),...evidence.checkpoints.flatMap(c=>c.groups)];
 assert(name==='cancel-undefined'||groups.some(g=>g.positions.length===17));
 rows.push({name,options,evidence,compact,synthetic:true,actualRegisteredTimingSamples:0,sut:sut.read(),rawRoundtrip:true});
}
writeFileSync(new URL('./semantic-failures-result.json',import.meta.url),JSON.stringify({producerFunctionSha256:createHash('sha256').update(producerSource).digest('hex'),independentVmSource:vmSource,rows},null,2)+'\n');console.log(JSON.stringify(rows.map(({name,evidence,sut,rawRoundtrip})=>({name,failures:evidence.failures,acquiredOwners:evidence.acquiredOwners,starts:sut.starts,cancels:sut.cancels,connected:sut.connected,rawRoundtrip}))));
