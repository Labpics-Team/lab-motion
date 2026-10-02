import os,subprocess,json,datetime,hashlib,time,pathlib
root=pathlib.Path('/workspace/lab-motion');out=pathlib.Path('/tmp/motion-profile-current-gates-fe092331-20261002');node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node';pnpm='/tmp/motion-server-toolchain-20261001/bin/pnpm'
expected='fe092331360837fd7f63d71a4b7f867ba849ebd4';assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==expected;assert not subprocess.check_output(['git','status','--porcelain'],cwd=root)
env=dict(os.environ);env.pop('NODE_PATH',None);env.pop('NODE_OPTIONS',None);env['CI']='true';env['PATH']=str(pathlib.Path(pnpm).parent)+':'+str(pathlib.Path(node).parent)+':'+env['PATH']
record={'head':expected,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':{key:env.get(key) for key in ['PATH','NODE_PATH','NODE_OPTIONS','CI']},'commands':[]}
(out/'launch.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'startUtc':record['startedAt'],'out':str(out)}),flush=True)
commands=[('whole',[pnpm,'exec','vitest','run','--reporter=json',f'--outputFile={out}/whole.json']),('finiteness',[pnpm,'exec','vitest','run','--reporter=verbose',*sorted(str(p.relative_to(root)) for p in root.glob('test/*finiteness-fuzz.test.ts'))]),('actionlint',['/workspace/lab-motion/scratchpad/actionlint-ci-pinned/actionlint']),('static',[pnpm,'check:static']),('docs-facts',[node,'scripts/check-docs-facts.mjs']),('docs-drift',[node,'scripts/check-docs-drift.mjs']),('pnpm-pack',[pnpm,'--config.ignore-scripts=true','pack','--out',str(out/'candidate-pnpm.tgz')]),('npm-pack',['npm','pack','--ignore-scripts','--pack-destination',str(out)])]
for name,argv in commands:
 row={'name':name,'argv':argv,'cwd':str(root),'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()};start=time.monotonic();print(json.dumps({'stage':name,'startUtc':row['startedAt']}),flush=True)
 with (out/f'{name}.stdout').open('wb') as stdout,(out/f'{name}.stderr').open('wb') as stderr:
  process=subprocess.Popen(argv,cwd=root,env=env,stdout=stdout,stderr=stderr);code=process.wait()
 row.update(finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),wallSeconds=time.monotonic()-start,exit=code,files={f'{name}.{stream}':{'bytes':(out/f'{name}.{stream}').stat().st_size,'sha256':hashlib.sha256((out/f'{name}.{stream}').read_bytes()).hexdigest()} for stream in ['stdout','stderr']});record['commands'].append(row);(out/'receipt.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'stage':name,'endUtc':row['finishedAt'],'exit':code,'wallSeconds':row['wallSeconds']}),flush=True)
 if code:break
record['endedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();record['allChildrenJoined']=True;record['exit']=code;(out/'receipt.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'endUtc':record['endedAt'],'exit':code,'allChildrenJoined':True}),flush=True)
raise SystemExit(code)
