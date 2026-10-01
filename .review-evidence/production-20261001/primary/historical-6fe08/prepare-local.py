from pathlib import Path
import json,hashlib
root=Path(__file__).resolve().parent
source=root/'snapshot/evidence/window-closure/window-synthetic-fixtures.mjs'
text=source.read_text();prefix=text.split('function syntheticBrowser(')[0]
prefix=prefix.replace('/workspace/lab-motion/',str(root/'snapshot/source')+'/')
(root/'fixture-local.mjs').write_text(prefix+'\nexport {stage,healthyAdmission,admissionEvents,chain};\n')
old=Path('/workspace/scratch/server-method-measurement-closure-16f31-20261001')
for name in ('semantic-replay.mjs','semantic-window-probe.mjs'):
 data=(old/name).read_bytes();(root/name).write_bytes(data)
receipt={'synthetic':True,'actualTimingSamples':0,'fixtureSource':str(source),'fixtureSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'fixtureLocalSha256':hashlib.sha256((root/'fixture-local.mjs').read_bytes()).hexdigest(),'ownPriorProbeSources':[{'path':str(old/name),'sha256':hashlib.sha256((old/name).read_bytes()).hexdigest()} for name in ('semantic-replay.mjs','semantic-window-probe.mjs')],'mutation':'rebase imported fixture to verified current snapshot; unchanged own independent SUT and exact producer extraction; no source packet mutation'}
(root/'prepare-local-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
