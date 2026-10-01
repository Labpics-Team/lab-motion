import datetime,json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parent
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
label=sys.argv[1];command=sys.argv[2]
result=subprocess.run(command,shell=True,executable='/bin/bash',cwd=root,capture_output=True,text=True)
record={'label':label,'command':command,'cwd':str(root),'startedUtc':started,'finishedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':result.returncode,'stdout':result.stdout,'stderr':result.stderr}
with (root/'commands.jsonl').open('a') as stream:stream.write(json.dumps(record,ensure_ascii=False)+'\n')
print(result.stdout,end='')
if result.stderr:print(result.stderr,end='',file=sys.stderr)
print(f'\n[recorded {label}; exit={result.returncode}]',file=sys.stderr)
sys.exit(result.returncode)
