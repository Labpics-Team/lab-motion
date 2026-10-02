import datetime,hashlib,json,subprocess,time
from pathlib import Path
p=Path(__file__).parent
utc=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
script=p/'independent-readback.py';start=utc();beg=time.monotonic()
argv=['taskset','-c','2','/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3',str(script)]
r={'operation':'independent literal-byte JSON/journal/clock/N analysis; no SUT','actualStartUtc':start,'argv':argv,'scriptSha256':hashlib.sha256(script.read_bytes()).hexdigest(),'timeoutSeconds':30,'timedOut':False,'heavy':0,'queued':0}
(p/'independent-reader.START.json').write_text(json.dumps(r,indent=2)+'\n')
with (p/'independent-reader.stdout.json').open('wb') as out,(p/'independent-reader.stderr.log').open('wb') as err:
 child=subprocess.Popen(argv,stdout=out,stderr=err,start_new_session=True);r['childPid']=child.pid
 try:r['exit']=child.wait(timeout=30)
 except subprocess.TimeoutExpired:r['timedOut']=True;child.kill();r['exit']=child.wait()
r.update(actualEndUtc=utc(),wallSeconds=time.monotonic()-beg,allChildrenJoined=child.poll() is not None,allEND=True)
(p/'independent-reader.END.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r,indent=2));print((p/'independent-reader.stdout.json').read_text());print((p/'independent-reader.stderr.log').read_text())
raise SystemExit(r['exit'])
