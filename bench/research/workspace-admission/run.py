"""Fixed ABBA/BAAB process blocks; no retries or observation filtering."""
import hashlib, json, os, shutil, subprocess, sys, time
from pathlib import Path
root = Path(__file__).resolve().parent
workspace = root.parent
node = workspace / 'tools/node'
phase, blocks = sys.argv[1], int(sys.argv[2])
cpu = min(os.sched_getaffinity(0))
paths = {'A': workspace / 'baseline-package/package', 'B': workspace / 'borrowed-package/package'}
cells = [dict(motion=m, count=n) for m in ['tween', 'spring'] for n in [1, 100, 1000]]
if phase == 'positive':
    cells = [dict(motion='tween', count=1)]
data = {'phase': phase, 'blocks': blocks, 'cpu': cpu,
        'nodeSha256': hashlib.sha256(node.read_bytes()).hexdigest(),
        'artifactSha256': {k: hashlib.sha256((v / 'dist/animate/index.js').read_bytes()).hexdigest() for k, v in paths.items()},
        'rows': []}
for block in range(blocks):
    order = 'ABBA' if block % 2 == 0 else 'BAAB'
    for i in range(len(cells)):
        cell = cells[(i + block) % len(cells)]
        samples = []
        for label in order:
            source = paths['A' if phase in ['AA', 'positive'] else label]
            shutil.rmtree(root / 'consumer', ignore_errors=True)
            shutil.copytree(source, root / 'consumer')
            config = {**cell, 'penaltyNs': 1000000 if phase == 'positive' and label == 'B' else 0}
            start = time.monotonic()
            p = subprocess.run(['taskset', '-c', str(cpu), str(node), '--random-seed=' + str(9337 + block), 'worker.mjs'],
                               input=json.dumps(config), cwd=root, text=True, capture_output=True, timeout=60)
            if p.returncode:
                raise RuntimeError(p.stderr)
            samples.append({'label': label, 'elapsedSeconds': time.monotonic() - start, **json.loads(p.stdout)})
        if len({s['semanticSha256'] for s in samples}) != 1:
            raise RuntimeError('baseline/candidate semantic mismatch')
        data['rows'].append({'block': block, 'cell': f"{cell['motion']}-{cell['count']}", 'order': order, 'samples': samples})
        (workspace / 'evidence' / f'single-{phase}.json').write_text(json.dumps(data))
        print(phase, block + 1, cell, flush=True)
assert len(data['rows']) == blocks * len(cells)
for key, source in paths.items():
    assert hashlib.sha256((source / 'dist/animate/index.js').read_bytes()).hexdigest() == data['artifactSha256'][key]
