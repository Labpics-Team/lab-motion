import pathlib,sys,json,hashlib,gzip,subprocess,threading,datetime,os
root=pathlib.Path(__file__).parent
prepared=json.loads(pathlib.Path(sys.argv[1]).read_text());name=prepared['name'];pipes=[root/(name+'.raw.fifo'),root/(name+'.journal.fifo')]
commands=[str(pathlib.Path('/proc/self/exe').resolve())] # This Python executable is metadata only.
entry=root/'snapshot/source/bench/profile/server-profile-contract.mjs'
argv=['node',str(entry),'--raw',str(pipes[0]),'--digest',prepared['raw']['sha256'],'--journal',str(pipes[1])]
streams=[];threads=[]
def provide(path,compressed,expected):
 h=hashlib.sha256();count=0;failure=None
 try:
  with gzip.open(compressed,'rb') as source,path.open('wb',buffering=0) as out:
   while True:
    data=source.read(65536)
    if not data:break
    h.update(data);count+=len(data);out.write(data)
 except BaseException as error:failure=repr(error)
 streams.append({'fifo':str(path),'gzip':compressed,'uncompressedSha256':h.hexdigest(),'uncompressedBytes':count,'expected':expected,'error':failure,'matched':failure is None and h.hexdigest()==expected['sha256'] and count==expected['bytes']})
for pipe,key in zip(pipes,['raw','journal']):
 os.mkfifo(pipe,0o600)
 thread=threading.Thread(target=provide,args=(pipe,prepared[key]['gzipPath'],prepared[key]));thread.start();threads.append(thread)
start=datetime.datetime.now(datetime.UTC).isoformat();result=subprocess.run(argv,capture_output=True,text=True)
for thread in threads:thread.join()
end=datetime.datetime.now(datetime.UTC).isoformat()
for pipe in pipes:pipe.unlink()
receipt={'command':argv,'startUtc':start,'endUtc':end,'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'streams':streams,'fifosRemoved':True,'actualRegisteredTimingSamples':0}
pathlib.Path(sys.argv[2]).write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if not all(s['matched'] for s in streams):sys.exit(2)
# A subject rejection is a successfully completed experiment, recorded verbatim.
