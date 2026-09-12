import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const seed=resolve(process.env.SEED_DIR),out=resolve(process.env.EVIDENCE_DIR);
await mkdir(out,{recursive:true});
const hash=s=>createHash('sha256').update(s).digest('hex');
const fixed=await readFile(join(seed,'surface-fixed-worker.mjs'),'utf8');
assert.equal(hash(fixed),'c4613385e7f97f2b191db2e80d1ae4d66197b555cc7a0759983b3e066479b6a7');
const anchor='    const detail = timed(side === 0 ? opA : opB);';
function turn(source){
 assert.equal(source.split(anchor).length,2);
 return "import { setImmediate as taskTurn } from 'node:timers/promises';\n"+source.replace(anchor,'    await taskTurn();\n'+anchor);
}
const worker=turn(fixed);
await writeFile(join(out,'surface-turn-worker.mjs'),worker);
const diagnostic=turn(await readFile(join(seed,'surface-fixed-diagnostic.mjs'),'utf8')).replace(
 "import { setImmediate as taskTurn } from 'node:timers/promises';",
 `import {setImmediate as hostTurn} from 'node:timers/promises';
async function taskTurn(){
 await hostTurn();
 const state=globalThis.__phaseProbe;
 state.turnPhases ??= [];
 state.turnPhases.push(state.phase);
}`);
const probe=join(out,'turn-probe.mjs'),mutant=join(out,'turn-absent-mutant.mjs');
await writeFile(probe,diagnostic);
await writeFile(mutant,diagnostic.replace('    await taskTurn();\n',''));
const receipts=[];
for(const [scenario,calls,positiveControl] of [['ordinary-warm',32,false],['ordinary-miss',32,false],['reject',8,false],['batch',8,false],['ordinary-warm',32,true]]){
 for(const cluster of [0,1]) for(const [kind,file] of [['turn',probe],['absent',mutant]]){
  const result=join(out,`turn-probe-${kind}-${scenario}-${positiveControl}-${cluster}.json`);
  const data={cluster,scenario,calls,positiveControl,sideAPath:join(seed,'phase-probe-plugin.mjs'),sideBPath:join(seed,'phase-probe-plugin.mjs'),acornPath:join(seed,'phase-probe-acorn.mjs')};
  const child=spawnSync(process.execPath,[file],{env:{...process.env,PHASE_DATA:JSON.stringify(data),PHASE_RESULT:result},encoding:'utf8',timeout:30000});
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr);
  const row=JSON.parse(await readFile(result,'utf8'));
  for(const side of ['A','B']){
   const repeats=side==='B'&&positiveControl?2:1;
   assert.equal(row.probe.counts[side+':warm'],128*calls*repeats);
   assert.equal(row.probe.counts[side+':measured'],2*calls*repeats);
  }
  const measured=Object.entries(row.probe.paths).filter(([key])=>key.includes(':measured:'));
  assert.equal(measured.length,2);
  assert(measured.every(([key,count])=>row.probe.paths[key.replace(':measured:',':warm:')]===64*count));
  const expected=[...Array(256).fill('warm'),...Array(4).fill('measured')];
  const admitted=JSON.stringify(row.probe.turnPhases)===JSON.stringify(expected);
  assert.equal(admitted,kind==='turn');
  assert.deepEqual(row.details.map(x=>x.side),cluster%2?[1,0,0,1]:[0,1,1,0]);
  receipts.push({kind,scenario,calls,positiveControl,cluster,admitted,counts:row.probe.counts});
 }
}
await writeFile(join(out,'turn-characterization.json'),JSON.stringify({workerSha256:hash(worker),receipts},null,2));
console.log('TURN_CONTRACT_PASS:10 complete-path positives and10 missing-turn mutants; unchanged workload,cache sequence,order and samples');
