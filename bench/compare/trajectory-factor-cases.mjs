import assert from 'node:assert/strict';

export const nodeCases = [[100,64],[100,960],[1000,8]];
export const browserCases = [['keyframes',1,2],['keyframes',100,64],['keyframes',100,960],['keyframes',1000,8],['to',1000,2]];
export const nodeRounds = 8, browserRounds = 10, warmupRounds = 2;
const arms = ['baseline','candidate'];
const key = ({kind,n,k,name}) => JSON.stringify([kind??null,n,k,name]);

// Derive the expected observations from the same matrix the probes execute.
export function validateFactorRows(rows, browser) {
  const cases = browser ? browserCases.map(([kind,n,k])=>({kind,n,k})) : nodeCases.map(([n,k])=>({n,k}));
  const rounds = browser ? browserRounds : nodeRounds;
  const expected = new Map(cases.flatMap(c=>arms.map(name=>[key({...c,name}),{samples:new Map(),summary:undefined}])));
  for (const row of rows) {
    const group=expected.get(key(row));
    assert(group,'unexpected workload or arm');
    assert(Number.isFinite(row.startMs)&&row.startMs>=0&&Number.isFinite(row.retained),'invalid observation');
    if(row.summary===true){
      assert(!group.summary,'duplicate summary');
      group.summary=row;
    }else{
      assert(Number.isInteger(row.round)&&row.round>=0&&row.round<rounds&&!group.samples.has(row.round),'invalid or duplicate round');
      group.samples.set(row.round,row);
    }
  }
  for(const {samples,summary} of expected.values()){
    assert.equal(samples.size,rounds,'incomplete observations');
    assert(summary,'missing summary');
    for(const field of ['startMs','retained']){
      const values=[...samples.values()].map(x=>x[field]).sort((a,b)=>a-b);
      assert.equal(summary[field],values[Math.floor(rounds/2)],'summary does not match raw observations');
    }
  }
}
