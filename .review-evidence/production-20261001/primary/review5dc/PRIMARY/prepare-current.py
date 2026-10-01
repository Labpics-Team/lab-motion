import pathlib,hashlib,json,re
root=pathlib.Path(__file__).parent
source=root/'snapshot/evidence/frame-first-publication-closure/current-fixtures.mjs'
data=source.read_text().split('function syntheticBrowser(')[0]
data=data.replace('/workspace/lab-motion/', './snapshot/source/')
data+='\nexport {stage, healthyAdmission, admissionEvents, chain};\n'
target=root/'fixture-local.mjs';target.write_text(data)
receipt={'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'target':str(target),'targetSha256':hashlib.sha256(target.read_bytes()).hexdigest(),'transformation':'primary fixture prefix only; imports rebound to verified immutable source; appended exports; no author synthetic browser used','actualRegisteredTimingSamples':0}
(root/'fixture-preparation.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
