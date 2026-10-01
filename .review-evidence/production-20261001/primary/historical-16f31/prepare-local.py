from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent
source=root/'snapshot/evidence/method-closure/new-synthetic-fixtures.mjs'
prefix=source.read_text().split('function syntheticBrowser(')[0]
prefix=prefix.replace('/workspace/lab-motion/',str(root/'snapshot/source')+'/')
(root/'fixture-local.mjs').write_text(prefix+'\nexport {stage,engineRaw,normalMotion};\n')
receipt={'syntheticOnly':True,'actualTimingSamples':0,'input':str(source),'inputSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'outputSha256':hashlib.sha256((root/'fixture-local.mjs').read_bytes()).hexdigest(),'transformation':'prefix before syntheticBrowser, snapshot imports, export primitive fixtures; no product logic mutation'}
(root/'prepare-local-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
