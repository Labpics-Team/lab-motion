import{readFileSync,writeFileSync,mkdirSync,openSync,writeSync,closeSync}from'node:fs';import{spawnSync}from'node:child_process';import{createHash}from'node:crypto';import assert from'node:assert/strict';import{fileURLToPath}from'node:url';
import{SERVER_PROFILE,serverProfileDigest}from'./snapshot/source/bench/profile/server-profile-registration.mjs';
import{writeServerArtifact}from'./snapshot/source/bench/profile/server-profile-contract.mjs';
const root=new URL('./',import.meta.url),source=readFileSync(new URL('snapshot/evidence/method-closure/new-synthetic-fixtures.mjs',root),'utf8');
const local=source.split('function syntheticBrowser(')[0].replaceAll('/workspace/lab-motion/',fileURLToPath(new URL('snapshot/source/',root)));
writeFileSync(new URL('./fixture-admission-local.mjs',root),local+'\nexport {healthyAdmission,admissionEvents,chain};\n');
const{healthyAdmission,admissionEvents,chain}=await import('./fixture-admission-local.mjs');
const window=JSON.parse(readFileSync(new URL('semantic-window-probe-result.json',root))),fault=window.rows.find(row=>row.actualSyntheticDurationMs===256);assert.equal(fault.accepted,true);
const out=new URL('fullN-window/',root);mkdirSync(out);const receipts=[];const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const artifact=healthyAdmission();assert.equal(artifact.samplePlan.runs,288);assert.equal(serverProfileDigest(SERVER_PROFILE),'f3259d5a6bc59ffbc4e41ebab28e182b36e1c5904e8c7434d78877d1b334b5a0');
const consumer=fileURLToPath(new URL('snapshot/source/bench/profile/server-profile-contract.mjs',root));
for(const name of['healthy','duration256-wide-window']){
 if(name==='duration256-wide-window'){const row=artifact.ab.rows.find(row=>row.scene==='s2'&&row.run===0);row.samples.right.semanticEvidence=structuredClone(fault.consumerInput.semanticEvidence);}
 const rawPath=fileURLToPath(new URL(name+'.json',out)),journalPath=fileURLToPath(new URL(name+'.ndjson',out));
 const written=writeServerArtifact(rawPath,artifact),records=chain(admissionEvents(artifact));let bytes=0;const descriptor=openSync(journalPath,'wx');try{for(const record of records){const buffer=Buffer.from(JSON.stringify(record)+'\n');bytes+=buffer.length;let offset=0;while(offset<buffer.length)offset+=writeSync(descriptor,buffer,offset,buffer.length-offset);}}finally{closeSync(descriptor);}
 const rawDigest=sha(rawPath);assert.equal(rawDigest,written.sha256);const args=[consumer,'--raw',rawPath,'--digest',rawDigest,'--journal',journalPath];
 const start=new Date().toISOString();const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 const receipt={name,synthetic:true,actualTimingSamples:0,registeredRuns:artifact.samplePlan.runs,independentBlocks:artifact.samplePlan.runs/2,protocolDigest:serverProfileDigest(SERVER_PROFILE),mutation:name==='healthy'?null:{stage:'ab',scene:'s2',run:0,participant:'right',field:'semanticEvidence',sourceResultSha256:sha(new URL('semantic-window-probe-result.json',root)),sourceRowDurationMs:256,rawClocksUnchanged:true},command:[process.execPath,...args],startUtc:start,endUtc:new Date().toISOString(),raw:{path:rawPath,sha256:rawDigest,bytes:written.bytes},journal:{path:journalPath,sha256:sha(journalPath),bytes,records:records.length},status:result.status,signal:result.signal,error:result.error?{name:result.error.name,message:result.error.message}:null,stdout:result.stdout,stderr:result.stderr};
 receipts.push(receipt);writeFileSync(new URL('fullN-window-receipts.json',root),JSON.stringify(receipts,null,2)+'\n');console.log(JSON.stringify(receipt));
 if(result.status!==0)break;
}
assert.equal(receipts.length,2);assert.equal(receipts[0].status,0);assert.equal(receipts[1].status,0);assert.equal(JSON.parse(receipts[1].stdout).verdict,'PASS');
