import datetime,hashlib,json,pathlib
root=pathlib.Path(__file__).resolve().parent
def entry(path):
 p=root/path;return {'relative':path,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
initial=json.loads((root/'primary-onset-packet.json').read_text())
compression=json.loads((root/'compression-receipt.json').read_text())
for record in compression['records']:
 assert record['lossless'] and record['plaintextRemoved'] and record['uncompressedSha256']==record['fullDecompressedReadbackSha256']
files=[row['relative'] for row in initial['files']]
files+=['primary-onset-packet.json','onset-acquisition.mjs','onset-synthetic-adapter.js','onset-acquisition-result.json','onset-acquisition-independent.py','onset-acquisition-independent-result.json','onset-acquisition-import-failure.mjs','onset-acquisition-binding-failure.mjs','onset-acquisition-result-binding-failure.json','fullN-onset-cli.mjs','fullN-onset-receipts.json','compress-onset-primary.py','restore-onset-primary.py','compression-receipt.json','compression-readback-before-removal.json','primary-onset-fullN-packet.py']
files += [str(pathlib.Path(row['gzipPath']).relative_to(root)) for row in compression['records']]
files=list(dict.fromkeys(files));entries=[entry(path) for path in files]
commands=[json.loads(line) for line in (root/'commands.jsonl').read_text().splitlines()]
labels=['syntax-acquisition','acquire-onset-ordinary-sample','acquisition-import-boundary','acquire-onset-ordinary-sample-corrected','preserve-acquisition-binding-failure','acquire-onset-ordinary-sample-complete','fullN-onset-preflight','fullN-onset-public-cli','compress-onset-lossless-primary','onset-acquisition-independent']
receipts=json.loads((root/'fullN-onset-receipts.json').read_text())
replay=[]
for row in receipts:
 destination=f'/fresh-owned-replay/{row["name"]}'
 replay.append({'case':row['name'],'restoreCommand':['python3',str(root/'restore-onset-primary.py'),row['name'],destination],'cliCommand':[row['command'][0],row['command'][1],'--raw',f'{destination}/{pathlib.Path(row["raw"]["path"]).name}','--digest',row['raw']['sha256'],'--journal',f'{destination}/{pathlib.Path(row["journal"]["path"]).name}']})
packet={'scope':'PRIMARY-only current6fe08 onset acquisition/full-N public CLI witness; no REPORT or author/foreign review reasoning','immutableArtifact':initial['immutableArtifact'],'sourceBasisContext':initial['sourceBasisContext'],'protocolDigest':initial['protocolDigest'],'clockModelDigest':receipts[0]['clockModelDigest'],'actualRegisteredTimingSamples':0,'syntheticIndependentRuns':288,'syntheticIndependentBlocks':144,'initialPacketSha256':hashlib.sha256((root/'primary-onset-packet.json').read_bytes()).hexdigest(),'initialRawSha256':hashlib.sha256((root/'semantic-closure-initial-result.json').read_bytes()).hexdigest(),'fullNReceipts':receipts,'reconstruction':replay,'compression':compression,'files':entries,'executionReceipts':[row for row in commands if row['label'] in labels],'createdUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
out=root/'primary-onset-fullN-packet.json';out.write_text(json.dumps(packet,ensure_ascii=False,indent=2)+'\n')
for path in files:
 if not path.startswith('snapshot/'): (root/path).chmod(0o444)
out.chmod(0o444)
print(json.dumps({'files':len(entries),'packetSha256':hashlib.sha256(out.read_bytes()).hexdigest(),'cliReceiptSha256':hashlib.sha256((root/'fullN-onset-receipts.json').read_bytes()).hexdigest(),'compressionReceiptSha256':hashlib.sha256((root/'compression-receipt.json').read_bytes()).hexdigest()}))
