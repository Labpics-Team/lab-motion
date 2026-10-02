import os,pathlib,json,subprocess,datetime,hashlib,time
root=pathlib.Path('/workspace/lab-motion');out=pathlib.Path('/tmp/motion-recipes-current-browser-fe092331-20261002');pnpm='/tmp/motion-server-toolchain-20261001/bin/pnpm';node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node';head='fe092331360837fd7f63d71a4b7f867ba849ebd4'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==head
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root)
env=dict(os.environ);env.pop('NODE_PATH',None);env.pop('NODE_OPTIONS',None);env['PATH']=str(pathlib.Path(pnpm).parent)+':'+str(pathlib.Path(node).parent)+':'+env['PATH'];env['CI']='true';env['LD_LIBRARY_PATH']='/workspace/lab-motion/scratchpad/browser-deps/root/usr/lib/x86_64-linux-gnu';env['PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS']='1';env['PLAYWRIGHT_JSON_OUTPUT_FILE']=str(out/'result.json')
argv=[pnpm,'exec','playwright','test','browser/compositor-recipes.spec.ts','--fail-on-flaky-tests','--reporter=json',f'--output={out}/artifacts']
row={'sourceHead':head,'argv':argv,'cwd':str(root),'startUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':{key:env.get(key) for key in ['PATH','NODE_PATH','NODE_OPTIONS','CI','LD_LIBRARY_PATH','PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS','PLAYWRIGHT_JSON_OUTPUT_FILE']},'qualification':'Existing stale-ldconfig validation bypass with actual required libraries and all three real engines, original dependency failures retained in immutable prior packets. No executable override/test skip/timeout change. Conformance Playwright1.63, not registered timing Chromium149. Config-owned CI worker1/retries2; flaky tests fail.'}
(out/'start.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps({'startUtc':row['startUtc'],'out':str(out),'argv':argv}),flush=True)
with (out/'stdout.log').open('wb') as stdout,(out/'stderr.log').open('wb') as stderr:
 child=subprocess.Popen(argv,cwd=root,env=env,stdout=stdout,stderr=stderr);code=child.wait()
row.update(endUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),exitCode=code,allChildrenJoined=True,cleanAfter=not bool(subprocess.check_output(['git','status','--porcelain'],cwd=root)))
row['files']={str(file):{'path':str(file),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()} for file in [out/'result.json',out/'stdout.log',out/'stderr.log',root/'browser/.artifacts/scope-recipes.js',root/'browser/.artifacts/scope-recipes.package.json'] if file.exists() and file.is_file()}
(out/'execution.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps({'endUtc':row['endUtc'],'exitCode':code,'allChildrenJoined':True}),flush=True)
raise SystemExit(code)
