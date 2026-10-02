from pathlib import Path
import subprocess,os,signal,json,datetime,hashlib,time
out=Path('/tmp/motion-native-clock-permanent-controls-20261002')
argv=['taskset','-c','0','/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node','test/fixtures/server-thread-cpu-clock-check.mjs']
env=dict(os.environ);env.pop('NODE_PATH',None);env.pop('NODE_OPTIONS',None)
start=datetime.datetime.now(datetime.timezone.utc).isoformat();begin=time.monotonic()
(out/'execution-start.json').write_text(json.dumps({'startUtc':start,'argv':argv,'cwd':'/workspace/lab-motion','env':{'NODE_PATH':env.get('NODE_PATH'),'NODE_OPTIONS':env.get('NODE_OPTIONS')},'registeredTimingSamples':0},indent=2)+'\n')
with (out/'stdout.log').open('x') as stdout,(out/'stderr.log').open('x') as stderr:
 child=subprocess.Popen(argv,cwd='/workspace/lab-motion',env=env,stdout=stdout,stderr=stderr,start_new_session=True)
 print('NATIVE FIRST ACTUAL START '+start+' PID '+str(child.pid),flush=True)
 timedOut=False
 try: code=child.wait(timeout=30)
 except subprocess.TimeoutExpired:
  timedOut=True;os.killpg(child.pid,signal.SIGKILL);code=child.wait()
end=datetime.datetime.now(datetime.timezone.utc).isoformat()
r={'startUtc':start,'endUtc':end,'wallSeconds':time.monotonic()-begin,'exitCode':code,'timedOut':timedOut,'allChildrenJoined':True,'argv':argv,'registeredTimingSamples':0,'files':{name:{'bytes':(out/name).stat().st_size,'sha256':hashlib.sha256((out/name).read_bytes()).hexdigest()}for name in ['execution-start.json','stdout.log','stderr.log','frozen-inputs.json']}}
(out/'execution.json').write_text(json.dumps(r,indent=2)+'\n')
print('NATIVE FIRST ACTUAL END '+end+' EXIT '+str(code),flush=True)
if code:print((out/'stderr.log').read_text()[-3500:],flush=True)
else:
 data=json.loads((out/'stdout.log').read_text());print(json.dumps({'records':len(data['records']),'mutants':sum(x.get('killed',False)for x in data['records']),'node':data['node'],'kernel':data['kernel']}),flush=True)
