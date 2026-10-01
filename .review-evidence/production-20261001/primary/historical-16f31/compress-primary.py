from pathlib import Path
import gzip,hashlib,json,datetime,os
root=Path(__file__).resolve().parent
full=json.loads((root/'fullN-window-receipts.json').read_text());rows=[]
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
for receipt in full:
 for kind in ('raw','journal'):
  original=Path(receipt[kind]['path']);compressed=original.with_name(original.name+'.gz');h=hashlib.sha256();size=0
  with original.open('rb') as inp,compressed.open('xb') as out:
   with gzip.GzipFile(filename='',fileobj=out,mode='wb',compresslevel=1,mtime=0) as carrier:
    for chunk in iter(lambda:inp.read(1024*1024),b''):h.update(chunk);size+=len(chunk);carrier.write(chunk)
   out.flush();os.fsync(out.fileno())
  assert h.hexdigest()==receipt[kind]['sha256'] and size==receipt[kind]['bytes']
  replay=hashlib.sha256();readback_bytes=0
  with gzip.open(compressed,'rb') as inp:
   for chunk in iter(lambda:inp.read(1024*1024),b''):replay.update(chunk);readback_bytes+=len(chunk)
  assert replay.hexdigest()==h.hexdigest() and readback_bytes==size
  rows.append({'case':receipt['name'],'kind':kind,'originalPath':str(original),'originalSha256':h.hexdigest(),'originalBytes':size,'gzipPath':str(compressed),'gzipSha256':sha(compressed),'gzipBytes':compressed.stat().st_size,'fullReadbackSha256':replay.hexdigest(),'fullReadbackBytes':readback_bytes,'byteIdenticalReadback':True,'plaintextDisposition':'replaced after durable compression receipt under explicit root instruction','level':1,'mtime':0})
  packet={'scope':'owned synthetic primary carrier conversion only','actualTimingSamples':0,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rows':rows}
  temporary=root/'compression-receipt.tmp';temporary.write_text(json.dumps(packet,indent=2)+'\n')
  with temporary.open('rb') as stream:os.fsync(stream.fileno())
  os.replace(temporary,root/'compression-receipt.json');original.unlink();compressed.chmod(0o444)
  print(json.dumps(rows[-1]),flush=True)
