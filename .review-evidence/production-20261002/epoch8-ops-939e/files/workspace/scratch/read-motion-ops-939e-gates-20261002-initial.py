"""Связывает результаты восьми текущих проверок с исходником939e."""
from pathlib import Path
import datetime, hashlib, json, subprocess, tarfile

folder = Path('/tmp/motion-profile-ops-current-gates-939e7f4a-20261002')
out = Path('/workspace/scratch/motion-ops-939e-current-gates-root-readback-20261002.json')
def sha(b):
    return hashlib.sha256(b).hexdigest()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
r = json.loads((folder / 'receipt.json').read_bytes())
assert r['head'] == '939e7f4a7ebef2dd494f9dec8690932fecebfd73'
assert r['exit'] == 0 and r['allChildrenJoined'] and len(r['commands']) == 8
bindings = []
for c in r['commands']:
    assert c['exit'] == 0
    for name, metadata in c['files'].items():
        b = (folder / name).read_bytes()
        assert len(b) == metadata['bytes'] and sha(b) == metadata['sha256']
        bindings.append({'path': str(folder / name), **metadata, 'match': True})
whole_bytes = (folder / 'whole.json').read_bytes()
j = json.loads(whole_bytes)
assert j['success'] and j['numFailedTests'] == 0
assert all(t['status'] == 'passed' for suite in j['testResults'] for t in suite['assertionResults'])
assert all(s['status'] == 'passed' for s in j['testResults'])
totals = {k: j[k] for k in ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTotalTests']}
bindings.append({'path': str(folder / 'whole.json'), 'bytes': len(whole_bytes), 'sha256': sha(whole_bytes), 'match': True})
packs = []
for name in ['candidate-pnpm.tgz', 'labpics-motion-0.3.0.tgz']:
    p = folder / name
    old = Path('/tmp/motion-profile-current-gates-fe092331-20261002') / name
    def members(p):
        with tarfile.open(p) as tf:
            return {m.name: tf.extractfile(m).read() for m in tf if m.isfile()}
    a, b = members(old), members(p)
    assert a.keys() == b.keys()
    changed = [k for k in b if b[k] != a[k]]
    assert changed == ['package/docs/server-profile.md'], changed
    expected = subprocess.check_output(['git', 'show', r['head'] + ':docs/server-profile.md'], cwd='/workspace/lab-motion')
    assert b[changed[0]] == expected
    raw = p.read_bytes()
    packs.append({'path': str(p), 'bytes': len(raw), 'sha256': sha(raw), 'memberCount': len(b),
                  'changedMembersVersusFe092': changed, 'allOtherMembersByteIdentical': True})
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd='/workspace/lab-motion')
result = {'startedAtUtc': started, 'endedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'head': r['head'], 'receiptSha256': sha((folder / 'receipt.json').read_bytes()), 'allEightPassed': True,
          'bindings': bindings, 'wholeTotals': totals, 'wholeFiles': len(j['testResults']), 'packages': packs,
          'allChildrenJoined': True, 'newSutExecutions': 0,
          'scope': 'Проверка текущих raw результатов и упаковки; не performance, remote CI или product GO.'}
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'output': str(out), 'sha256': sha(out.read_bytes()), 'totals': totals, 'packages': packs}, ensure_ascii=False))
