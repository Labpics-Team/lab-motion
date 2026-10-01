import json,re,pathlib,hashlib
from fractions import Fraction as Q
root=pathlib.Path(__file__).resolve().parent
data=json.loads((root/'engine-replay-result.json').read_text());rows=[]
initial=list(map(Q,[0,0,1,1,0,0,0]));previous=list(map(Q,[64,32,2,3,32,8,16]));destination=list(map(Q,[256,160,4,5,96,24,40]));offsets=[0,16,32,48,64,80]
for case in data['rows']:
 if case['output'] is None:continue
 scene=case['scene'];checks=[]
 for raw in case['output']['raw']:
  from_values=initial if scene['lifecycle']=='fresh' else [a+(b-a)*Q(32,128) for a,b in zip(initial,previous)]
  to_values=destination if scene['channels']==7 else [destination[0],*from_values[1:]]
  cursor=0
  for run in raw['raw']['targetTraces']['runs']:
   assert run['from']==cursor and run['count']>0;cursor+=run['count']
   trace=run['trace']
   for frame,offset in enumerate(offsets):
    decoded=[Q(value) for value in re.findall(r'-?\d+(?:\.\d+)?(?:e[+-]?\d+)?',trace['values'][frame],re.I)]
    expected=[a+(b-a)*Q(offset,128) for a,b in zip(from_values,to_values)]
    assert decoded==expected,(case['name'],frame,decoded,expected)
    events=[event for event in trace['events'] if event['phase']=='frames' and event['index']==frame]
    assert len(events)==1 and events[0]['value']==trace['values'][frame]
   digest=hashlib.sha256(json.dumps(trace['values'],separators=(',',':')).encode()).hexdigest()
   hashes=raw['semantic']['targetTraceHashes'];assert hashes['encoding']=='repeat' and hashes['count']==scene['count'] and hashes['value']==digest
  assert cursor==scene['count'];cpu=raw['raw']['cpuReads'];values=[(read['userUs']+read['systemUs'])*1000 for read in cpu]
  assert all(read['valueNs']==str(value) for read,value in zip(raw['raw']['clockReads'],values))
  intervals=[values[i+1]-values[i] for i in range(0,16,2)]
  assert intervals==[raw['operationNs'],*raw['frameNs'],raw['cancelDrainNs']]
  checks.append({'targetCoverage':cursor,'frames':6,'cssRationalLinearLawMatched':True,'hashMatchesRetainedCss':True,'intervals':intervals})
 rows.append({'case':case['name'],'repetitions':len(checks),'checks':checks})
result={'synthetic':True,'actualTimingSamples':0,'oracle':'Python rational endpoint interpolation and integer field sums; no lifecycle validator imported','rows':rows}
(root/'engine-independent-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'cases':len(rows),'repetitionsPerCase':[row['repetitions'] for row in rows],'allIndependentArithmeticMatched':True}))
