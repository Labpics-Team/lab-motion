// Приобретение через existing full browser owner; clock/SUT вымышлены VM.
import {readFileSync,writeFileSync} from 'node:fs';import{createHash}from'node:crypto';import assert from'node:assert/strict';
import{syntheticBrowser}from'./current-fixtures.mjs';
import{measureServerBrowser}from'/workspace/lab-motion/bench/profile/server-profile-runner.mjs';
import{SERVER_PROFILE,serverProfileDigest}from'/workspace/lab-motion/bench/profile/server-profile-registration.mjs';
const receipts=[];
for(const[name,progress,initialProgressAt]of[['healthy',0,1],['initial-progress-quarter',.25,1],['timed-initial-progress-quarter',.25,9]]){
 const fake=syntheticBrowser({initialProgress:progress,initialProgressAt}),scene=SERVER_PROFILE.browserScenes[0];let sample=null,error=null,closed=false;
 const get=fake.browser.newContext;fake.browser.newContext=async()=>{const context=await get();const close=context.close;context.close=async()=>{await close();closed=true;};return context;};
 try{try{sample=await measureServerBrowser(fake.browser,{url:'synthetic://first-publication'},fake.adapter,scene);}catch(cause){error={name:cause.name,message:cause.message,causes:cause.errors?.map(value=>value?.message??String(value)),raw:cause.raw};}
  const sut={...fake.read(),closed};assert(closed);assert.equal(sut.connected,0);if(progress===0){assert(sample);assert.equal(error,null);}else{assert(error);assert.equal(sample,null);if(initialProgressAt>1){assert.equal(error.raw.semanticEvidence.valid,true);assert.equal(error.raw.raw.length,SERVER_PROFILE.repetitions);assert.equal(error.raw.warmup.length,1);}}
  receipts.push({name,initialProgress:progress,initialProgressAt,synthetic:true,actualTimingSamples:0,sample,error,sut});
 }finally{fake.dispose();}
}
const root='/workspace/lab-motion',source=['bench/compare/bench.mjs','bench/compare/methodology.mjs','bench/profile/server-profile-contract.mjs','bench/profile/server-profile-runner.mjs','bench/profile/server-profile-registration.mjs','test/server-profile-contract.test.ts'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(root+'/'+path)).digest('hex')}));
writeFileSync(new URL('./current-whole-first-publication-result.json',import.meta.url),JSON.stringify({protocolDigest:serverProfileDigest(SERVER_PROFILE),synthetic:true,actualTimingSamples:0,source,receipts},null,2)+'\n');
console.log(JSON.stringify(receipts.map(({name,sample,error,sut})=>({name,acquired:!!sample,error:error?.message,raw:error?.raw?.raw?.length,normal:error?.raw?.semanticEvidence?.valid,sut}))));
