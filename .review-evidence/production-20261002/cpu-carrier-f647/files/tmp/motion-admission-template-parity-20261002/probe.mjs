import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root='/workspace/lab-motion',out='/tmp/motion-admission-template-parity-20261002';
const begin=new Date().toISOString(), esbuild=createRequire(`${root}/package.json`)('esbuild');
const {compactServerCpuEvidence,serverOrders}=await import(`${root}/bench/profile/server-profile-contract.mjs`);
const {SERVER_PROFILE}=await import(`${root}/bench/profile/server-profile-registration.mjs`);
function load(name,extra='') {
 const source=readFileSync(`${out}/${name}-test.ts`,'utf8');
 const prefix=source.slice(0,source.indexOf("describe('серверный PROFILE: потеря полей при CPU RLE запрещена'"))
  .replace(/import \{[^\n]+\} from 'vitest';\n/,'').replaceAll("'../bench/",`'${root}/bench/`);
 writeFileSync(`${out}/${name}-fixture.mjs`,esbuild.transformSync(`${prefix}\nexport {stage,admissionEvents${extra}};`,{loader:'ts',format:'esm',target:'es2022'}).code,{flag:'wx'});
 return import(pathToFileURL(`${out}/${name}-fixture.mjs`).href);
}
const old=await load('old'), candidate=await load('new',',preparedAdmissionStage');
const hash=x=>createHash('sha256').update(x).digest('hex');
const rows=[];
for(const name of ['warmup','pilot','aa','positive','ab']) for(const runs of [2,4,6]) {
 const expected=old.stage(name,runs);
 for(const row of expected.rows) if(row.kind==='engine') for(const sample of Object.values(row.samples)) for(const measured of sample.raw) measured.raw.cpuReads=compactServerCpuEvidence(measured.raw.cpuReads);
 const actual=candidate.preparedAdmissionStage(name,runs);
 assert.deepEqual(actual,expected);
 const expectedJson=JSON.stringify(expected),actualJson=JSON.stringify(actual);assert.equal(actualJson,expectedJson);
 const scenes=SERVER_PROFILE.engineScenes.length+SERVER_PROFILE.browserScenes.length;
 assert.equal(actual.rows.length,runs*scenes);assert.equal(actual.blocks.length,runs/2);
 const first=actual.rows[0],next=actual.rows[scenes];assert.notEqual(first.samples.left,next.samples.left);assert.notEqual(first.samples.left.raw[0],next.samples.left.raw[0]);assert.notEqual(first.order,actual.rows[1].order);
 const nextJson=JSON.stringify(next), otherOrder=JSON.stringify(actual.rows[1].order);
 first.samples.left.raw[0].raw.clockReads[0].valueNs='fault-owned';first.order[0]='fault-owned';
 assert.equal(JSON.stringify(next),nextJson);assert.equal(JSON.stringify(actual.rows[1].order),otherOrder);
 rows.push({name,runs,rowCount:runs*scenes,expectedSha256:hash(expectedJson),actualSha256:hash(actualJson),bytes:Buffer.byteLength(actualJson),independentRows:true});
}
const orders=serverOrders(SERVER_PROFILE.minRuns);
assert.equal(orders.length,292);
for(let run=0;run<orders.length;run+=2)assert.deepEqual(orders[run],orders[run+1].toReversed());
const indices=[0,Math.floor(orders.length/2),orders.length-1].map(run=>({run,order:orders[run],rowIndex:run*(SERVER_PROFILE.engineScenes.length+SERVER_PROFILE.browserScenes.length),block:Math.floor(run/2),beforeUsageUsec:10+Math.floor(run/2)*10,afterUsageUsec:20+Math.floor(run/2)*10}));
const record={startUtc:begin,endUtc:new Date().toISOString(),node:process.version,rows,registeredRuns:SERVER_PROFILE.minRuns,registeredIndexLaw:indices,source:{oldSha256:hash(readFileSync(`${out}/old-test.ts`)),newSha256:hash(readFileSync(`${out}/new-test.ts`))},failures:0,scope:'Small independent old/new complete ordered JSON and detached-row controls. N292 construction law is the identical run/order and block formula; all samples still encoded, cloned, hashed and validated inside the unchanged callback. No performance series.'};
writeFileSync(`${out}/result.json`,JSON.stringify(record,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({startUtc:begin,endUtc:record.endUtc,cases:rows.length,failures:0}));
