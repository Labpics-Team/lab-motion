import pathlib,json,hashlib,shutil
root=pathlib.Path(__file__).parent;original=pathlib.Path('/workspace/scratch/motion-server-method-final-20261001T144242Z')
manifest=json.loads((root/'extraction.json').read_text());binding={r['path']:r for r in manifest['entries']}
prefix='evidence/frame-first-publication-closure/real-healthy-first-publication/'
files=['semantic-only.mjs','semantic-only-result.json','semantic-only.log','candidate.iife.js','consumer/package/package.json']
out=root/'real-primary';out.mkdir();rows=[]
for name in files:
 path=prefix+name;source=original/path;data=source.read_bytes();digest=hashlib.sha256(data).hexdigest()
 assert digest==binding[path]['sha256'],path
 target=out/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);target.chmod(0o444)
 rows.append({'primaryPath':str(source),'manifestPath':path,'sha256':digest,'bytes':len(data),'retainedPath':str(target)})
(root/'real-primary-copy.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows))
