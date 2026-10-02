import json
from pathlib import Path
p=Path(__file__).parent
b=json.loads((p/'all-bindings.json').read_text());reads=[json.loads(x) for x in (p/'readset.ndjson').read_text().splitlines()]
r={'schema':'independent-ops939e-readset-v1','sourceHead':b['sourceHead'],'sourceTree':b['sourceTree'],'axis':'five-path ops correctness/measurement boundary','records':reads,'uniqueDirectReadPaths':len(set(x['path'] for x in reads)),'sourceConservationScope':{'sourceFilesBound':641,'changedFiles':5,'unchangedFiles':636,'measuredAndSupportFunctions':b['conservedFunctions'],'unchangedMathProofTransferred':True},'ownFeProofFiles':b['ownFeProofFiles'],'separateFeEpoch8ProofFiles':b['separateFeEpoch8ProofFiles'],'runtimeBoundary':{'SUTExecutions':0,'runnerExecutions':0,'nativeExecutions':0,'newConsumerExecutions':0,'seriesLaunches':0,'browserBuildProbes':0,'rawMetadataAnalysesOnly':True,'heavy':0,'queued':0}}
(p/'readset.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'readRecords':len(reads),'uniquePaths':r['uniqueDirectReadPaths'],'metadataOnly':True,'heavy':0,'queued':0}))
