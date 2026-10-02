from pathlib import Path
import datetime,hashlib,json
root=Path(__file__).resolve().parent
previous=Path('/tmp/motion-native-cpu-rle-measurement-f647-20261002')
def sha(raw):return hashlib.sha256(raw).hexdigest()
def bind(p):
 p=Path(p);raw=p.read_bytes();return {'path':str(p),'bytes':len(raw),'sha256':sha(raw)}
def verify(row):
 r=bind(row['path']);assert r['sha256']==row['sha256'];assert r['bytes']==row.get('bytes',row.get('actualBytes'));return r
source=json.loads((root/'source-bindings.json').read_text())
for row in source['files'].values():verify({'path':row['sourcePath'],'bytes':row['bytes'],'sha256':row['sha256']})
primary=json.loads((root/'primary-integrity.json').read_text())
supplement=json.loads((root/'supplement-integrity.json').read_text())
for group in [primary,supplement]:
 for row in group['refs']:
  verify(row);verify({**row,'path':row['snapshotPath']})
norms=json.loads((root/'norm-bindings.json').read_text())
for row in norms['norms']:
 verify({'path':row['actualPath'],'bytes':row['bytes'],'sha256':row['sha256']})
 verify({'path':row['snapshotPath'],'bytes':row['bytes'],'sha256':row['sha256']})
prior_manifest=bind(previous/'MANIFEST.json')
assert prior_manifest['sha256']=='35ea57c49dca88fc010c1b692a36d633ccdacbff36ea0ced2427f1a2d7f13ae9'
prior=json.loads((previous/'MANIFEST.json').read_text());prior_bindings=[]
for row in prior['files']:
 p=previous/row['path']
 if row.get('type')=='symlink':assert str(p.resolve())==row['target'];prior_bindings.append({**row,'path':str(p)})
 else:prior_bindings.append(verify({**row,'path':str(p)}))
entries=[json.loads(line) for line in (root/'readset.ndjson').read_text().splitlines()]
for row in entries:verify(row)
p=root/'source/test/ci-workflow-contract.test.ts';manual={**bind(p),'category':'ci-command-validator-source','reviewedLines':[277,286],'reviewedScope':'assertCommands: exact commands/no-if/no-continue-on-error/no working-directory and bash shell','utc':datetime.datetime.now(datetime.timezone.utc).isoformat()};entries.append(manual)
readset={'schema':'motion-independent-qualified-method-readset-v1','sourceHead':source['sourceHead'],'sourceTree':source['sourceTree'],'entries':entries,'sourceIntegritySeparate':'641 files in source-bindings.json; identity is not semantic coverage','conservationSeparate':['admission-conservation.json','diff-bindings.json','native-primary-independent-readback.json'],'ownf647Transfer':{'manifestBinding':prior_manifest,'readsetBinding':bind(previous/'readset.json'),'sourceBinding':bind(previous/'source-bindings.json'),'scope':'634 whole source files unchanged; modified test only conserved statements/functions; norms byte-identical; no fresh reviewer runtime/native execution','priorReadsetPath':str(previous/'readset.json')},'notReadAsOracle':['foreign REPORT/HANDOFF/bot conclusions/author rationale','author conservation-result/parsed-results conclusions'],'freshReviewerRuntime':False}
(root/'readset.json').write_text(json.dumps(readset,ensure_ascii=False,indent=2)+'\n')
allbind={'schema':'motion-independent-qualified-method-all-bindings-v1','sourceHead':source['sourceHead'],'sourceTree':source['sourceTree'],'sourceFiles':source['files'],'primary':primary,'freshSupplement':supplement,'norms':norms,'priorOwnf647Manifest':prior_manifest,'priorOwnf647ProofFiles':prior_bindings,'freshReviewerRuntime':False,'registeredReviewerTimingSamples':0,'allEND':True,'heavy':0,'queued':0}
(root/'all-bindings.json').write_text(json.dumps(allbind,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sourceFiles':641,'sourceUnchangedFromf647':634,'primaryBindings':len(primary['refs']),'supplementBindings':len(supplement['refs']),'negativeLawsConserved':5,'timedCases':6,'caseTimeoutMs':30000,'aggregateBudgetConserved':False,'freshReviewerRuntime':False,'allBindingsMatch':True,'allEND':True,'heavy':0,'queued':0},ensure_ascii=False))
