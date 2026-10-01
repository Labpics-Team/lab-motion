import pathlib,json,math,struct,itertools
from fractions import Fraction as F
root=pathlib.Path(__file__).parent
def bits(x):return struct.pack('>d',x).hex()
ranks=[]
for n in (4,143,144,512):
 for p,q in ((1,2),(19,20)):
  masses=[math.comb(n,k)*p**k*(q-p)**(n-k) for k in range(n+1)];denom=q**n
  low=0;high=None
  for rank in range(1,n+1):
   if sum(masses[:rank])*1600<=denom:low=rank
   if high is None and sum(masses[rank:])*1600<=denom:high=rank
  ranks.append({'n':n,'p':p/q,'lowRank':low,'highRank':high})
nextafter=[{'inputBits':bits(x),'upBits':bits(math.nextafter(x,math.inf)),'downBits':bits(math.nextafter(x,-math.inf))} for x in (0.,-0.,5e-324,-5e-324,1.,-1.,1e-300,-1e-300,1e300,-1e300,float('inf'),-float('inf'))]
clock=[]
# Each rounding/clamping endpoint chosen independently at interval edges;
# fractions retain ideal elapsed and actual binary64 values exactly.
for hostMs in (1000,10**6,10**9,2**32,2**42-2):
 for durationNs in (0,1,4999,5000,32000000):
  upperNs=hostMs*10**6+500000
  beginNs=hostMs*10**6-durationNs-30000
  endNs=beginNs+durationNs
  for e0,e1 in itertools.product((-5000,4999),repeat=2):
   observedBegin=float(F(beginNs+e0,10**6));observedEnd=float(F(endNs+e1,10**6))
   if observedEnd<observedBegin:continue
   clock.append({'hostNs':str(upperNs),'beginMs':observedBegin,'endMs':observedEnd,'idealNumerator':str(durationNs),'idealDenominator':'1000000'})
relations=[]
# D=C(F-O), P=C(N)-C(O): construction follows primary PageAnimator/Performance,
# independent synthetic choices cover clamp edges, origins, negative frame deltas.
for hostMs in (1000,10**6,10**9,2**32,2**42-2):
 for lagNs in (0,1000,40000000):
  nowNs=hostMs*10**6;frameNs=nowNs-lagNs;originNs=nowNs-100000000
  for frameErr,nowErr,originErr in itertools.product((-5000,4999),repeat=3):
   document=float(F(frameNs-originNs+frameErr,10**6))
   perf=float(F(nowNs+nowErr,10**6))-float(F(originNs+originErr,10**6))
   ideal=F(frameNs-nowNs,10**6)
   exactError=abs(F.from_float(document)-F.from_float(perf)-ideal)
   relations.append({'hostNs':str(nowNs+500000),'documentMs':document,'perfMs':perf,'physicalLagMs':lagNs/10**6,'errorNumerator':str(exactError.numerator),'errorDenominator':str(exactError.denominator)})
result={'exactRanks':ranks,'nextafter':nextafter,'costClockCases':clock,'semanticRelationCases':relations,'actualRegisteredTimingSamples':0}
(root/'numeric-current-reference.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'ranks':len(ranks),'nextafter':len(nextafter),'costClocks':len(clock),'semanticRelations':len(relations)}))
