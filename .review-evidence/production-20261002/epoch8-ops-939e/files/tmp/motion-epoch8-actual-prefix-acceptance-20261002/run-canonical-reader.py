import datetime,hashlib,json,subprocess,time
from pathlib import Path
p=Path(__file__).parent
utc=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
script=p/'canonical-readback.mjs'
inputs=[p/'PRIMARY/server-profile.json',p/'PRIMARY/journal.ndjson',script]
refs=[{'path':str(x),'bytes':x.stat().st_size,'sha256':hashlib.sha256(x.read_bytes()).hexdigest()} for x in inputs]
argv=['taskset','-c','2','/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node',str(script)]
start=utc();beg=time.monotonic(); receipt={'operation':'one canonical consumer/readback of existing epoch8 bytes, no SUT','actualStartUtc':start,'argv':argv,'inputs':refs,'timeoutSeconds':30,'timedOut':False,'sourceHead':'fe092331360837fd7f63d71a4b7f867ba849ebd4','heavy':0,'queued':0}
(p/'canonical-reader.START.json').write_text(json.dumps(receipt,indent=2)+'\n')
with (p/'canonical-reader.stdout.json').open('wb') as out,(p/'canonical-reader.stderr.log').open('wb') as err:
 child=subprocess.Popen(argv,stdout=out,stderr=err,start_new_session=True)
 receipt['childPid']=child.pid
 try: receipt['exit']=child.wait(timeout=30)
 except subprocess.TimeoutExpired:
  receipt['timedOut']=True
  child.kill(); receipt['exit']=child.wait()
receipt.update(actualEndUtc=utc(),wallSeconds=time.monotonic()-beg,allChildrenJoined=child.poll() is not None,allEND=True,heavy=0,queued=0)
(p/'canonical-reader.END.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
print((p/'canonical-reader.stdout.json').read_text())
print((p/'canonical-reader.stderr.log').read_text())
raise SystemExit(receipt['exit'])
