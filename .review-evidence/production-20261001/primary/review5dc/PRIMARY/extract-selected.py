import hashlib,json,pathlib,tarfile
root=pathlib.Path(__file__).resolve().parent;packet=pathlib.Path('/workspace/scratch/motion-server-method-final-20261001T144242Z')
manifest_bytes=(packet/'manifest.json').read_bytes();manifest=json.loads(manifest_bytes);entries=manifest['files'];snapshot=root/'snapshot';snapshot.mkdir()
excluded=[];verified=[];retained=[]
def forbidden(path):
 return pathlib.PurePosixPath(path).name.upper() in ['HANDOFF.MD','RUN-PLAN.MD','CLOCK-CERTIFICATE.MD','REPORT.MD','REPORT-RU.MD','VERDICT.JSON']
def keep(path,size):
 if path.startswith(('source/','primary-clock-sources/','artifact-context/')):return True
 if path in ['SOURCE-FREEZE.json','current-dependency-trees.json','owner.patch']:return True
 parts=pathlib.PurePosixPath(path).parts
 if len(parts)==3 and parts[:2]==('evidence','frame-first-publication-closure') and not path.endswith('.gz'):return True
 return len(parts)==3 and path.startswith('evidence/') and path.endswith(('.mjs','.py','.json','.log')) and size<2*1024*1024
with tarfile.open(packet/'method.tar.gz','r|gz') as archive:
 for member in archive:
  path=member.name.removeprefix('./');parts=pathlib.PurePosixPath(path).parts
  assert path and not path.startswith('/') and '..' not in parts,path
  if member.isdir():continue
  assert member.isfile(),('nonregular',path)
  if forbidden(path):excluded.append({'path':path,'declared':entries.get(path),'readContent':False});continue
  stream=archive.extractfile(member);h=hashlib.sha256();size=0;target=None
  if keep(path,member.size):
   target=snapshot/path;target.parent.mkdir(parents=True,exist_ok=True);out=target.open('xb')
  else:out=None
  try:
   while chunk:=stream.read(4*1024*1024):
    h.update(chunk);size+=len(chunk)
    if out:out.write(chunk)
  finally:
   if out:out.close()
  if path=='manifest.json':assert h.hexdigest()==hashlib.sha256(manifest_bytes).hexdigest()
  else:assert entries[path]['sha256']==h.hexdigest() and entries[path]['bytes']==size,path
  row={'path':path,'sha256':h.hexdigest(),'bytes':size,'retained':bool(target)};verified.append(row)
  if target:target.chmod(0o444);retained.append(row)
(snapshot/'manifest.json').write_bytes(manifest_bytes);(snapshot/'manifest.json').chmod(0o444)
for p in sorted(snapshot.rglob('*'),key=lambda p:len(p.parts),reverse=True):
 if p.is_dir():p.chmod(0o555)
snapshot.chmod(0o555)
receipt={'archiveSha256':'5dc04987eace1aaf736da05192948897d50262be5a24ff9192b79744f47ab525','manifestSha256':hashlib.sha256(manifest_bytes).hexdigest(),'entries':verified,'retained':retained,'excludedWithoutContentRead':excluded,'scope':'all permitted members stream-rehashed; selected immutable primary source/raw retained; unretained bytes stay in immutable archive','protocolDigest':manifest['protocolDigest'],'clockModelDigest':manifest['clockModelDigest'],'sourceBasisHead':manifest['sourceBasisHead'],'sourceBasisClean':manifest['sourceBasisClean'],'actualRegisteredTimingSamples':0}
(root/'extraction.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'streamVerified':len(verified),'retained':len(retained),'retainedBytes':sum(x['bytes'] for x in retained),'excludedWithoutContentRead':len(excluded),'protocolDigest':manifest['protocolDigest'],'clockModelDigest':manifest['clockModelDigest']}))
