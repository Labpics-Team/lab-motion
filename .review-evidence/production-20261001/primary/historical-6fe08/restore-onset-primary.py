import gzip,hashlib,json,pathlib,sys
root=pathlib.Path(__file__).resolve().parent
case=sys.argv[1];destination=pathlib.Path(sys.argv[2]);destination.mkdir(exist_ok=False,parents=True)
receipt=json.loads((root/'compression-receipt.json').read_text())
for record in receipt['records']:
 if record['case']!=case:continue
 source=pathlib.Path(record['gzipPath']);out=destination/pathlib.Path(record['originalPath']).name
 assert hashlib.sha256(source.read_bytes()).hexdigest()==record['gzipSha256']
 h=hashlib.sha256();size=0
 with gzip.open(source,'rb') as original,out.open('xb') as target:
  while chunk:=original.read(4*1024*1024):h.update(chunk);size+=len(chunk);target.write(chunk)
 assert (h.hexdigest(),size)==(record['uncompressedSha256'],record['uncompressedBytes'])
 print(json.dumps({'restored':str(out),'sha256':h.hexdigest(),'bytes':size}))
