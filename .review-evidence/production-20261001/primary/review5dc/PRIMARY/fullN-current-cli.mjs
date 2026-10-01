import {createReadStream,createWriteStream,readFileSync,writeFileSync} from 'node:fs';
import {Readable,Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {healthyAdmission,admissionEvents} from './fixture-local.mjs';
import {serverArtifactChunks,serverArtifactDigest} from './snapshot/source/bench/profile/server-profile-contract.mjs';
import {SERVER_PROFILE,serverProfileDigest} from './snapshot/source/bench/profile/server-profile-registration.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));const semantic=JSON.parse(readFileSync(new URL('./semantic-current-result.json',import.meta.url)));
const failures=JSON.parse(readFileSync(new URL('./semantic-failures-result.json',import.meta.url)));
const healthy=healthyAdmission();healthy.synthetic='Independent predata pipeline replay; fabricated provenance/counters; actual registered performance samples ZERO.';
function changedSemantic(name){const rows=[...healthy.ab.rows],index=rows.findIndex(r=>r.kind==='browser'&&r.scene==='s2'),row=rows[index],sample=structuredClone(row.samples.right),trace=semantic.rows.find(r=>r.name===name);sample.semanticEvidence=structuredClone(trace.consumerInput.semanticEvidence);sample.semanticEvidence.valid=true;rows[index]={...row,samples:{...row.samples,right:sample}};return{...healthy,ab:{...healthy.ab,rows}};}
async function compressed(file,generator){const hash=createHash('sha256');let bytes=0;const tap=new Transform({transform(chunk,encoding,done){hash.update(chunk);bytes+=chunk.length;done(null,chunk);}});await pipeline(Readable.from(generator),tap,createGzip({level:1}),createWriteStream(file,{flags:'wx'}));const compressedHash=createHash('sha256');let compressedBytes=0;for await(const chunk of createReadStream(file)){compressedHash.update(chunk);compressedBytes+=chunk.length;}return{gzipPath:file,sha256:hash.digest('hex'),bytes,compressedSha256:compressedHash.digest('hex'),compressedBytes,encoding:'lossless gzip level1; no plaintext file emitted'};}
function* journalBytes(events){let previous='0'.repeat(64);for(const event of events){const payload={sequenceDigest:previous,...event};previous=serverProfileDigest(payload);yield JSON.stringify({...payload,digest:previous})+'\n';}}
const cases=[{name:'current-fullN-own-healthy',artifact:changedSemantic('healthy128'),expected:'PASS'},
 {name:'current-fullN-own-first-quarter',artifact:changedSemantic('quarter-at-first-publication'),expected:'REJECT'}];
const events=admissionEvents(healthy),firstAb=events.findIndex(e=>e.type==='sample'&&e.value.stage==='ab');
const failed=failures.rows.find(r=>r.name==='first-publication-prefix');
const error={name:'AggregateError',message:'independently acquired first-publication CSS prefix failure',raw:failed.compact};
const partial={...healthy,verdict:'UNPROVEN',failures:[{stage:'ab',error}],ab:{...healthy.ab,rows:[{...healthy.ab.rows[0],samples:{[events[firstAb].value.participant]:events[firstAb].value.value}}],blocks:[]}};
delete partial.comparison;delete partial.comparators;delete partial.retention;
const partialEvents=[...events.slice(0,firstAb+1),{type:'failed-sample',value:{...events[firstAb+1].value,value:undefined,error}}, {type:'failure',value:partial.failures[0]}, {type:'finished',value:{verdict:partial.verdict,digest:serverArtifactDigest(partial)}}];
cases.push({name:'current-fullN-retained-own-failure',artifact:partial,events:partialEvents,expected:'UNPROVEN'});
const receipts=[];
for(const c of cases){
 const inputEvents=c.events??admissionEvents(c.artifact),raw=await compressed(root+c.name+'.json.gz',serverArtifactChunks(c.artifact)),journal=await compressed(root+c.name+'.ndjson.gz',journalBytes(inputEvents));
 const receipt={name:c.name,synthetic:true,actualRegisteredTimingSamples:0,protocolDigest:serverProfileDigest(SERVER_PROFILE),clockModelDigest:serverProfileDigest(SERVER_PROFILE.clockError),registeredRuns:c.artifact.samplePlan.runs,independentBlocks:c.artifact.samplePlan.runs/2,expected:c.expected,raw,journal,sourceSemanticSha256:createHash('sha256').update(readFileSync(new URL('./semantic-current-result.json',import.meta.url))).digest('hex'),sourceFailureSha256:createHash('sha256').update(readFileSync(new URL('./semantic-failures-result.json',import.meta.url))).digest('hex')};
 const prepared=root+c.name+'-prepared.json',result=root+c.name+'-cli.json';writeFileSync(prepared,JSON.stringify(receipt,null,2)+'\n');
 const args=[root+'cli-gzip-fifo.py',prepared,result],executed=spawnSync('python3',args,{encoding:'utf8',maxBuffer:1024*1024});
 receipt.orchestrationCommand=['python3',...args];receipt.orchestration={status:executed.status,signal:executed.signal,error:executed.error?.message??null,stdout:executed.stdout,stderr:executed.stderr};
 if(executed.status===0){receipt.cli=JSON.parse(readFileSync(result));receipt.matched=c.expected==='REJECT'?receipt.cli.exit!==0:receipt.cli.exit===0&&JSON.parse(receipt.cli.stdout).verdict===c.expected;}else receipt.matched=false;
 receipts.push(receipt);writeFileSync(root+'fullN-current-cli-results.json',JSON.stringify(receipts,null,2)+'\n');console.log(JSON.stringify({name:c.name,expected:c.expected,matched:receipt.matched,rawBytes:raw.bytes,journalBytes:journal.bytes,cli:receipt.cli&&{exit:receipt.cli.exit,stdout:receipt.cli.stdout,stderr:receipt.cli.stderr}}));
 assert.equal(receipt.matched,true,c.name);
}
