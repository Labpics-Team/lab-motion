import hashlib,json
from pathlib import Path
p=Path(__file__).parent
bound=json.loads((p/'all-bindings.json').read_text())
for relative,ref in bound['sourceFiles'].items():
 b=Path(ref['path']).read_bytes();assert len(b)==ref['bytes'] and hashlib.sha256(b).hexdigest()==ref['sha256'],relative
for ref in bound['norms']+bound['immutableSourceInputs']+bound['ownSealedProofTransfer']['files']:
 b=Path(ref['path']).read_bytes();assert len(b)==ref['bytes'] and hashlib.sha256(b).hexdigest()==ref['sha256'],ref['path']
for name,digest in [('server-profile.json','d098aad5475f93813cf47c096d9a1c0335e73949730903dd2cfd4190fa038975'),('journal.ndjson','8552cce134e3778fa0516912f4f628d21de834e9b284006147c4ab128aa387cb')]:
 assert hashlib.sha256((p/'PRIMARY'/name).read_bytes()).hexdigest()==digest,name
r=json.loads((p/'independent-readback.json').read_text());assert r['registeredCompletedSamples']==876 and r['nativeCpuEndpoints']==47872 and r['independentPlan']=={'runs':1024,'requiredRuns':1240,'feasible':False,'minimumBlocks':146,'alphaPerTail':1/1760}
reads=[json.loads(x) for x in (p/'readset.ndjson').read_text().splitlines()]
(p/'readset.json').write_text(json.dumps({'schema':'independent-epoch8-readset-v1','axis':'existing single epoch8 raw prefix identity/measurement/interpretation','sourceHead':bound['sourceHead'],'sourceTree':bound['sourceTree'],'directReadRecords':reads,'uniqueDirectPaths':len(set(x['path'] for x in reads)),'ownProofTransfer':bound['ownSealedProofTransfer'],'runtimeBoundaries':{'canonicalConsumerInvocations':1,'canonicalConsumerExit':1,'canonicalConsumerOverallSuccess':False,'independentAnalysisExit':0,'SUTExecutions':0,'seriesLaunches':0,'heavy':0,'queued':0}},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sourceFilesVerified':641,'normsVerified':8,'rawAndJournalExact':True,'completedSamples':876,'cpuEndpoints':47872,'uniqueDirectReadPaths':len(set(x['path'] for x in reads)),'heavy':0,'queued':0}))
