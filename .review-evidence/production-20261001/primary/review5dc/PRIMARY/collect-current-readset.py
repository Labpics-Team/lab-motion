import pathlib,re,json,hashlib,shutil,subprocess,datetime
root=pathlib.Path(__file__).parent
def identity(p):
 b=p.read_bytes();return {'path':str(p),'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)}
roots=[root/'snapshot/source/bench/profile/server-profile-contract.mjs',root/'snapshot/source/bench/profile/server-profile-registration.mjs',root/'snapshot/source/scripts/bench-transform-support.mjs']
seen=set();rows=[];pending=roots[:];pattern=re.compile(r'''from\s+['"]([.][^'"]+)['"]''')
while pending:
 p=pending.pop().resolve()
 if p in seen:continue
 seen.add(p);b=p.read_bytes();rows.append({**identity(p),'readKind':'executed ESM import closure / static inspected primary'})
 pending.extend((p.parent/q).resolve() for q in pattern.findall(b.decode()) if (p.parent/q).is_file())
(root/'source-import-readset.json').write_text(json.dumps(rows,indent=2)+'\n')
data=json.loads((root/'extraction.json').read_text());artifacts=[x for x in data['entries'] if x['path'].startswith('artifact-context/') and x['path'].endswith('.tgz')]
norms=root/'norm-fragments';norms.mkdir()
readset=[json.loads(line) for line in (root/'readset.jsonl').read_text().splitlines()]
normRows=[]
for item in readset:
 p=pathlib.Path(item['path'])
 if not str(p).startswith('/workspace/agents-config/'):continue
 first,last=item['linesRequested'];lines=p.read_text().splitlines()
 current=identity(p);fragment='\n'.join(lines[first-1:last])+'\n'
 target=norms/(str(p.relative_to('/workspace/agents-config')).replace('/','__')+f'.{first}-{last}.txt')
 target.write_text(fragment)
 normRows.append({'originalRead':item,'currentIdentity':current,'fullHashMatchesOriginalRead':current['sha256']==item['sha256'],'fragment':identity(target),'scope':'only these normative lines; prepared r12 does not activate. No appended author evidence is read.'})
(root/'norm-fragments.json').write_text(json.dumps(normRows,indent=2)+'\n')
node=pathlib.Path(shutil.which('node')).resolve();clockPins=[identity(p) for p in sorted((root/'snapshot/primary-clock-sources').glob('*')) if p.is_file() and p.suffix in ('.cc','.c','.h')]
registration=(root/'snapshot/source/bench/profile/server-profile-registration.mjs').read_text()
assert len(clockPins)==17
for row in clockPins:assert row['sha256'] in registration
retained=data['retained'];mismatches=[]
for item in retained:
 p=root/'snapshot'/item['path']
 if identity(p)['sha256']!=item['sha256']:mismatches.append(item['path'])
assert not mismatches
result={'utc':datetime.datetime.now(datetime.UTC).isoformat(),'sourceImportClosure':rows,'clockPins':clockPins,'node':{**identity(node),'version':subprocess.check_output([str(node),'--version'],text=True).strip()},'artifactContextTarIdentities':artifacts,'snapshotRetainedFiles':len(retained),'snapshotReadbackMismatches':mismatches,'normFragments':len(normRows),'actualRegisteredTimingSamples':0}
(root/'current-readset-receipt.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ('clockPins','sourceImportClosure')}))
