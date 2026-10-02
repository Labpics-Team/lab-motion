import datetime,hashlib,json,subprocess,sys
from pathlib import Path
p=Path(__file__).parent
utc=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
ref=lambda path:{'path':str(path.relative_to(p)),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
start=utc();argv=['taskset','-c','2',sys.executable,str(p/'prepare-readset.py')]
with (p/'finalization.stdout.log').open('wb') as out,(p/'finalization.stderr.log').open('wb') as err:
 child=subprocess.Popen(argv,stdout=out,stderr=err);code=child.wait()
end=utc();assert code==0,(code,(p/'finalization.stderr.log').read_text())
terminal={'schema':'independent-ops939e-measurement-terminal-v1','sourceHead':'939e7f4a7ebef2dd494f9dec8690932fecebfd73','sourceTree':'deba4db1952029bdb7d2244b207f570007700b19','base':'fe092331360837fd7f63d71a4b7f867ba849ebd4','taskActualStartUtc':json.loads((p/'start.json').read_text())['actualStartUtc'],'actualStartUtc':start,'actualEndUtc':end,'argv':argv,'childPid':child.pid,'exitCode':code,'cpu':2,'action':'metadata readset/report/manifest finalization only; no new source confirmations or product execution','allEND':True,'allChildrenJoined':child.poll() is not None,'heavy':0,'queued':0,'SUTExecutions':0,'seriesLaunches':0,'nativeExecutions':0,'newConsumerExecutions':0,'stopOwnExecAfterSeal':True,'primaryNativeControlActualEndUtc':'2026-10-02T05:02:47.474210+00:00','primaryNativeControlActualExit':0,'currentGatesActualEndUtc':'2026-10-02T05:11:58.543358+00:00','currentGatesActualExit':0}
(p/'terminal.json').write_text(json.dumps(terminal,ensure_ascii=False,indent=2)+'\n')
with (p/'REPORT.md').open('a') as out:out.write('\nПоследняя own metadata операция: actual START '+start+' UTC → **actual END '+end+' UTC**, exit0, allchildrenjoined/allEND, heavy0/queued0. Терминал сохраняет argv и отдельно первичные native/current-gates END. После seal own exec STOP; нового consumer/SUT/контроля не было.\n')
files=[ref(x) for x in sorted(p.rglob('*')) if x.is_file() and x.name not in ['MANIFEST.json','FINAL-SEAL.json']]
manifest={'schema':'independent-ops939e-measurement-manifest-v1','axis':'ops correctness and measurement boundary for immutable five-file delta','verdict':'PASS within stated static/control scope','findings':[],'sourceHead':terminal['sourceHead'],'sourceTree':terminal['sourceTree'],'base':terminal['base'],'actualEndUtc':end,'exitCode':code,'allEND':True,'allChildrenJoined':True,'heavy':0,'queued':0,'SUTExecutions':0,'seriesLaunches':0,'nativeExecutions':0,'newConsumerExecutions':0,'files':files,'inputBindingsSha256':ref(p/'all-bindings.json')['sha256'],'reportSha256':ref(p/'REPORT.md')['sha256'],'readsetSha256':ref(p/'readset.json')['sha256'],'terminalSha256':ref(p/'terminal.json')['sha256']}
(p/'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
seal={'schema':'independent-ops939e-final-seal-v1','sourceHead':terminal['sourceHead'],'sourceTree':terminal['sourceTree'],'actualEndUtc':end,'sealedAtUtc':utc(),'exitCode':code,'allEND':True,'allChildrenJoined':True,'heavy':0,'queued':0,'SUTExecutions':0,'newConsumerExecutions':0,'stopOwnExecAfterSeal':True,'files':[ref(p/x) for x in ['REPORT.md','MANIFEST.json','all-bindings.json','readset.json','terminal.json','controls-existing-readback.json']]}
(p/'FINAL-SEAL.json').write_text(json.dumps(seal,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(seal,ensure_ascii=False,indent=2))
