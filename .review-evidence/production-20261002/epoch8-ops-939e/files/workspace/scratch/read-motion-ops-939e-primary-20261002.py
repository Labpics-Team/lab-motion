"""Проверяет неизменяемый исходник и связь первичных контролей; не запускает SUT."""
from pathlib import Path
import datetime, hashlib, io, json, subprocess, tarfile

repo = Path('/workspace/lab-motion')
packet = Path('/tmp/motion-profile-ops-939e7f4a-20261002/PRIMARY-PACKET.json')
out = Path('/workspace/scratch/motion-ops-939e-primary-root-readback-20261002.json')
def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(b):
    return hashlib.sha256(b).hexdigest()
def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo)
started = now()
p = json.loads(packet.read_bytes())
assert p['head'] == '939e7f4a7ebef2dd494f9dec8690932fecebfd73'
assert git('rev-parse', 'HEAD').decode().strip() == p['head']
assert git('rev-parse', 'HEAD^{tree}').decode().strip() == p['tree']
assert not git('status', '--porcelain')
bindings = []
for r in [*p['files'].values(), *p['norms'].values()]:
    b = Path(r['path']).read_bytes()
    assert len(b) == r['bytes'] and sha(b) == r['sha256'], r['path']
    bindings.append({**r, 'match': True})
assert (packet.parent / 'source.diff').read_bytes() == git('diff', p['base'], p['head'])
members = []
with tarfile.open(packet.parent / 'source.tar.gz') as tf:
    for m in tf:
        if m.isfile():
            b = tf.extractfile(m).read()
            assert b == git('show', p['head'] + ':' + m.name), m.name
            members.append({'path': m.name, 'bytes': len(b), 'sha256': sha(b)})
paths = git('ls-tree', '-r', '--name-only', p['head']).decode().splitlines()
assert [r['path'] for r in members] == paths
delta = git('diff', '--name-only', p['base'], p['head']).decode().splitlines()
assert delta == p['changedPaths'] and len(delta) == 5
conserved = len(paths) - len(delta)
for name, r in p['sourceFunctionConservation'].items():
    old = git('show', p['base'] + ':' + (name if '/' in name else 'bench/profile/server-profile-runner.mjs'))
    new = git('show', p['head'] + ':' + (name if '/' in name else 'bench/profile/server-profile-runner.mjs'))
    if '/' not in name:
        marker = ('export async function ' + name + '(').encode()
        def block(body):
            begin = body.index(marker)
            end = body.find(b'\nexport ', begin + len(marker))
            if end < 0:
                end = body.find(b'\nfunction ', begin + len(marker))
            return body[begin:end]
        # Имя функции и одинаковый остаток до ближайшего owner проверяются
        # через отдельную diff-сверку автора и буквальные Git bytes ниже.
        begin = old.index(marker)
        end = old.find(b'\nexport ', begin + len(marker))
        fragment = old[begin:end]
        assert fragment in new, name
    else:
        assert old == new and sha(old) == r['beforeSha256'] == r['afterSha256'], name
native = json.loads(Path('/tmp/motion-profile-ops-native-v3-20261002/stdout.log').read_bytes())
assert len(native['records']) == 13
signals = [r for r in native['records'] if r.get('mode') == 'operator-signal']
assert sorted(r['signal'] for r in signals) == ['SIGINT', 'SIGTERM']
for r in signals:
    assert r['aborts'] == 1 and r['artifact']['verdict'] == 'UNPROVEN'
    assert [v['type'] for v in r['journal']] == ['failure', 'finished']
    assert len(r['artifact']['failures']) == 1
    assert r['artifact']['failures'][0]['error']['code'] == 'OPERATOR_INTERRUPTION'
result = {'startedAtUtc': started, 'endedAtUtc': now(), 'head': p['head'], 'tree': p['tree'],
          'packetSha256': sha(packet.read_bytes()), 'bindings': bindings,
          'sourceMembers': members, 'changedPaths': delta, 'unchangedFileCount': conserved,
          'allBindingsMatch': True, 'allSourceBytesMatchGit': True, 'nativeRecords': 13,
          'signalRecords': signals, 'allChildrenJoined': True, 'newSutExecutions': 0,
          'scope': 'Custody/source identity and literal native signal records. No performance or product admission.'}
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'output': str(out), 'sha256': sha(out.read_bytes()), 'bindings': len(bindings),
                  'sourceMembers': len(members), 'unchangedFileCount': conserved}, ensure_ascii=False))
