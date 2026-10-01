import pathlib,sys,hashlib,json,datetime
root=pathlib.Path(__file__).resolve().parent
for argument in sys.argv[1:]:
 parts=argument.rsplit(':',2)
 if len(parts)==3 and parts[1].isdigit() and parts[2].isdigit():path=pathlib.Path(parts[0]);first,last=int(parts[1]),int(parts[2])
 else:path=pathlib.Path(argument);first,last=1,None
 if not path.is_absolute():path=root/'snapshot'/path
 assert path.name.lower() not in ('handoff.md','report.md','review.md'),path
 data=path.read_bytes();lines=data.decode().splitlines();last=min(len(lines),last or len(lines))
 record={'path':str(path),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'linesRequested':[first,last],'utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 with (root/'readset.jsonl').open('a') as stream:stream.write(json.dumps(record,ensure_ascii=False)+'\n')
 print(json.dumps(record));print('\n'.join(f'{number}: {lines[number-1]}' for number in range(first,last+1)))
