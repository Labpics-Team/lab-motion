import datetime,gzip,hashlib,json,os,pathlib
root=pathlib.Path(__file__).resolve().parent
cli=json.loads((root/'fullN-onset-receipts.json').read_text())
assert len(cli)==2 and all(row['status']==0 for row in cli)
records=[]
def digest(path):
 h=hashlib.sha256();size=0
 with path.open('rb') as stream:
  while chunk:=stream.read(4*1024*1024):h.update(chunk);size+=len(chunk)
 return h.hexdigest(),size
def durable_json(path,value):
 tmp=path.with_suffix(path.suffix+'.tmp')
 with tmp.open('w') as stream:json.dump(value,stream,ensure_ascii=False,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
 os.replace(tmp,path)
for row in cli:
 for kind in ['raw','journal']:
  reference=row[kind];original=pathlib.Path(reference['path']);target=pathlib.Path(str(original)+'.gz');tmp=pathlib.Path(str(target)+'.tmp')
  assert original.is_file() and not target.exists() and not tmp.exists()
  original_sha,original_bytes=digest(original)
  assert (original_sha,original_bytes)==(reference['sha256'],reference['bytes'])
  with original.open('rb') as source,tmp.open('xb') as destination:
   with gzip.GzipFile(filename='',fileobj=destination,mode='wb',compresslevel=1,mtime=0) as compressed:
    while chunk:=source.read(4*1024*1024):compressed.write(chunk)
   destination.flush();os.fsync(destination.fileno())
  os.replace(tmp,target)
  h=hashlib.sha256();read_bytes=0
  with gzip.open(target,'rb') as stream:
   while chunk:=stream.read(4*1024*1024):h.update(chunk);read_bytes+=len(chunk)
  assert (h.hexdigest(),read_bytes)==(original_sha,original_bytes)
  compressed_sha,compressed_bytes=digest(target)
  records.append({'case':row['name'],'kind':kind,'originalPath':str(original),'uncompressedSha256':original_sha,'uncompressedBytes':original_bytes,'gzipPath':str(target),'gzipSha256':compressed_sha,'gzipBytes':compressed_bytes,'fullDecompressedReadbackSha256':h.hexdigest(),'fullDecompressedReadbackBytes':read_bytes,'lossless':True,'plaintextRemoved':False})
  durable_json(root/'compression-progress.json',{'records':records})
receipt={'compression':'gzip level1 mtime0; no content changes','actualTimingSamples':0,'cliReceiptSha256':digest(root/'fullN-onset-receipts.json')[0],'createdUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'records':records}
durable_json(root/'compression-readback-before-removal.json',receipt)
# Delete only these owned plaintext copies after every complete readback and a
# durable receipt; original immutable references retain exact byte/hash mappings.
for record in records:
 pathlib.Path(record['originalPath']).unlink();record['plaintextRemoved']=True
receipt['plaintextRemovalUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
durable_json(root/'compression-receipt.json',receipt)
print(json.dumps({'records':len(records),'lossless':all(row['lossless'] for row in records),'uncompressedBytes':sum(row['uncompressedBytes'] for row in records),'gzipBytes':sum(row['gzipBytes'] for row in records),'receiptSha256':digest(root/'compression-receipt.json')[0]}))
