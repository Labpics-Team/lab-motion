import {readFileSync,writeFileSync,mkdirSync,openSync,writeSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {SERVER_PROFILE,serverProfileDigest} from './snapshot/source/bench/profile/server-profile-registration.mjs';
import {writeServerArtifact,serverCellPairs,serverFamilyIntervals} from './snapshot/source/bench/profile/server-profile-contract.mjs';
import {healthyAdmission,admissionEvents,chain} from './fixture-local.mjs';
const root=new URL('./',import.meta.url),sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const acquired=JSON.parse(readFileSync(new URL('onset-acquisition-result.json',root)));
assert.equal(acquired.protocolDigest,'f2ad05507ef5436accf5541dcdcbb01afa6ce5f6fdbe5e724166f53a7466afaf');
const healthy=acquired.receipts.find(row=>row.name==='healthy'),fault=acquired.receipts.find(row=>row.name==='initial-progress-quarter');
for(const row of[healthy,fault]){assert.equal(row.error,null);assert.equal(row.sut.closed,true);assert.equal(row.sut.connected,0);assert(row.sample);}
const clocks=sample=>sample.raw.map(row=>({startClock:row.startClock,cancelClock:row.cancelClock,startReadClock:row.startWitness.readClock,startMs:row.startMs,cancelMs:row.cancelMs}));
assert.deepEqual(clocks(healthy.sample),clocks(fault.sample));
const artifact=healthyAdmission(),runs=artifact.samplePlan.runs;assert.equal(runs,288);assert.equal(serverProfileDigest(SERVER_PROFILE),acquired.protocolDigest);
const out=new URL('fullN-onset/',root);mkdirSync(out);const receipts=[];
const consumer=fileURLToPath(new URL('snapshot/source/bench/profile/server-profile-contract.mjs',root));
for(const entry of[healthy,fault]){
  const row=artifact.ab.rows.find(row=>row.scene==='s2'&&row.run===0);row.samples.right=structuredClone(entry.sample);
  artifact.comparison=serverFamilyIntervals(serverCellPairs(artifact.ab,runs,'ab'));
  const rawPath=fileURLToPath(new URL(entry.name+'.json',out)),journalPath=fileURLToPath(new URL(entry.name+'.ndjson',out));
  const written=writeServerArtifact(rawPath,artifact),records=chain(admissionEvents(artifact));let bytes=0;
  const descriptor=openSync(journalPath,'wx');try{for(const record of records){const buffer=Buffer.from(JSON.stringify(record)+'\n');bytes+=buffer.length;let offset=0;while(offset<buffer.length)offset+=writeSync(descriptor,buffer,offset,buffer.length-offset);}}finally{closeSync(descriptor);}
  const rawDigest=sha(rawPath);assert.equal(rawDigest,written.sha256);
  const args=[consumer,'--raw',rawPath,'--digest',rawDigest,'--journal',journalPath];const startedUtc=new Date().toISOString();
  // Diagnostic watchdog for this synthetic replay only, not a registered timeout.
  const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  const receipt={name:entry.name,synthetic:true,actualTimingSamples:0,registeredRuns:runs,independentBlocks:runs/2,protocolDigest:serverProfileDigest(SERVER_PROFILE),clockModelDigest:serverProfileDigest(SERVER_PROFILE.clockError),sourceAcquisitionSha256:sha(new URL('onset-acquisition-result.json',root)),replacement:{stage:'ab',scene:'s2',run:0,participant:'right',source:'exact frozen producer acquired whole sample in independent deterministic DOM/SUT',initialProgress:entry.initialProgress,acquiredTimingClocksIdenticalToHealthy:true},command:[process.execPath,...args],startedUtc,finishedUtc:new Date().toISOString(),raw:{path:rawPath,sha256:rawDigest,bytes:written.bytes},journal:{path:journalPath,sha256:sha(journalPath),bytes,records:records.length},status:result.status,signal:result.signal,error:result.error?{name:result.error.name,message:result.error.message}:null,stdout:result.stdout,stderr:result.stderr};
  receipts.push(receipt);writeFileSync(new URL('fullN-onset-receipts.json',root),JSON.stringify(receipts,null,2)+'\n');console.log(JSON.stringify(receipt));
  if(entry===healthy&&result.status!==0)break;
}
assert.equal(receipts.length,2);assert.equal(receipts[0].status,0);assert.equal(JSON.parse(receipts[0].stdout).verdict,'PASS');assert.equal(receipts[1].status,0);assert.equal(JSON.parse(receipts[1].stdout).verdict,'PASS');
