import argparse
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
p = argparse.ArgumentParser()
p.add_argument('path')
p.add_argument('--start', type=int, default=1)
p.add_argument('--end', type=int)
p.add_argument('--category', default='source')
args = p.parse_args()
path = Path(args.path).resolve()
raw = path.read_bytes()
lines = raw.decode('utf-8-sig').splitlines()
end = min(args.end or len(lines), len(lines))
print(f'{path} [{args.start}-{end}/{len(lines)}] sha256={hashlib.sha256(raw).hexdigest()}')
for i in range(args.start - 1, end):
    print(f'{i + 1}: {lines[i]}')
record = {
    'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'path': str(path), 'category': args.category,
    'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
    'reviewedLines': [args.start, end], 'totalLines': len(lines),
}
with (ROOT / 'readset.ndjson').open('a') as out:
    out.write(json.dumps(record, ensure_ascii=False) + '\n')
