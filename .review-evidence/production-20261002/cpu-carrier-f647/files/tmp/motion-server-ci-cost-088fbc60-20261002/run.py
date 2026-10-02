import os,subprocess,datetime,json,hashlib,pathlib,time
root=pathlib.Path('/workspace/lab-motion');out=pathlib.Path('/tmp/motion-server-ci-cost-088fbc60-20261002')
node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
env=dict(os.environ);env.pop('NODE_PATH',None);env.pop('NODE_OPTIONS',None);env['CI']='true'
argv=['taskset','-c','0',node,'--cpu-prof',f'--cpu-prof-dir={out}','--cpu-prof-name=before.cpuprofile',str(out/'probe.mjs')]
start=datetime.datetime.now(datetime.timezone.utc).isoformat();record={'argv':argv,'cwd':str(root),'startUtc':start,'endUtc':None,'exitCode':None,'diagnosticTimeoutSeconds':60,'timedOut':False,'actualRegisteredPerformanceSamples':0,'environment':{'nodeExecutable':node,'nodeVersion':subprocess.check_output([node,'--version'],env=env,text=True).strip(),'nodeOptions':env.get('NODE_OPTIONS'),'nodePath':env.get('NODE_PATH'),'ci':env.get('CI')},'source':{name:hashlib.sha256((out/'before'/name).read_bytes()).hexdigest() for name in ['bench/profile/server-profile-contract.mjs', 'bench/profile/server-profile-registration.mjs', 'bench/compare/methodology.mjs', 'scripts/bench-transform-support.mjs', 'test/server-profile-contract.test.ts']} }
(out/'execution-start.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'startUtc':start,'argv':argv}),flush=True)
with (out/'probe.log').open('wb') as stream:
 p=subprocess.Popen(argv,cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
 try: code=p.wait(timeout=60)
 except subprocess.TimeoutExpired:
  import signal;os.killpg(p.pid,signal.SIGTERM)
  try:code=p.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);code=p.wait()
  record['timedOut']=True
record['endUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();record['exitCode']=code
record['files']={str(p.relative_to(out)):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in out.iterdir() if p.is_file() and p.name!='execution.json'}
(out/'execution.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'endUtc':record['endUtc'],'exitCode':code,'timedOut':record['timedOut'],'out':str(out)}),flush=True)
raise SystemExit(code if code>=0 else 1)
