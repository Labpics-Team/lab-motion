import hashlib,json,math,pathlib
root=pathlib.Path(__file__).resolve().parent
source=root/'onset-acquisition-result.json';value=json.loads(source.read_text());rows=[]
for receipt in value['receipts']:
 sample=receipt['sample'];evidence=sample['semanticEvidence'];low=-math.inf;high=math.inf
 # Independent non-rounded central phase enclosure with the original CSS .5px
 # tolerance. Its full width is much smaller than the 32ms lead; this is not a
 # reimplementation of the JS resolving-pair admission.
 for checkpoint in evidence['checkpoints']:
  group=checkpoint['groups'][0];positions=group['positions']
  if positions['encoding']=='repeat':coordinates=[positions['value']]*positions['count']
  else:coordinates=[x for count,x in positions['runs'] for _ in range(count)]
  for x in coordinates:
   if x<298:low=max(low,checkpoint['frameTimestampMs']-(x+.5)/(300/128))
   if x>=.5:high=min(high,group['readEndedMs']-(x-(.5 if x<298 else 2))/(300/128))
 starts=[event for event in receipt['sut']['observerLog'] if event['kind']=='SUT-start']
 assert len(starts)==290 and all(len(event['beforePx'])==100 for event in starts)
 assert all(x==0 for event in starts for x in event['beforePx'])
 expected=receipt['initialProgress']*300
 assert all(x==expected for event in starts for x in event['afterPx'])
 clocks=[{'startClock':r['startClock'],'cancelClock':r['cancelClock'],'readClock':r['startWitness']['readClock']} for r in sample['raw']]
 rows.append({'name':receipt['name'],'actualTimingSamples':0,'starts':len(starts),'allFreshBeforePx':0,'allImmediateAfterPx':expected,'centralCompatiblePhaseMs':[low,high],'acquiredRawClockDigest':hashlib.sha256(json.dumps(clocks,sort_keys=True).encode()).hexdigest(),'sampleStartMs':sample['startMs'],'sampleCancelMs':sample['cancelMs'],'timedCalls':[r['calls'] for r in sample['raw']],'closed':receipt['sut']['closed'],'connected':receipt['sut']['connected']})
assert rows[0]['acquiredRawClockDigest']==rows[1]['acquiredRawClockDigest']
assert rows[1]['centralCompatiblePhaseMs'][1]<-31
result={'inputSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'actualTimingSamples':0,'scope':'independent acquisition arithmetic/primitive facts; central phase only, not clock-error certificate or new admission oracle','rows':rows}
(root/'onset-acquisition-independent-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
