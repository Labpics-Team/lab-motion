from pathlib import Path
import datetime
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parent
PREVIOUS = Path('/tmp/motion-native-cpu-rle-measurement-5a4c-20261002')
OLDER = Path('/tmp/motion-native-clock-measurement-088-20261002')

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def binding(path):
    path = Path(path)
    raw = path.read_bytes()
    return {'path': str(path), 'bytes': len(raw), 'sha256': sha(raw)}

def verify(row):
    actual = binding(row['path'])
    assert actual['bytes'] == row['bytes'] and actual['sha256'] == row['sha256'], row['path']
    return actual

source = json.loads((ROOT / 'source-bindings.json').read_text())
for row in source['files'].values():
    verify({'path': row['ownedSourcePath'], 'bytes': row['bytes'], 'sha256': row['sha256']})
assert len(source['files']) == 639

current_readset = json.loads((ROOT / 'readset.json').read_text())
current_readset['entries'] = [json.loads(line) for line in (PREVIOUS / 'readset.ndjson').read_text().splitlines()]
for row in current_readset['entries']:
    verify(row)
(ROOT / 'readset.json').write_text(json.dumps(current_readset, ensure_ascii=False, indent=2) + '\n')
(ROOT / 'readset.ndjson').write_bytes((PREVIOUS / 'readset.ndjson').read_bytes())

norms = json.loads((ROOT / 'norm-bindings.json').read_text())
for row in norms['norms']:
    verify({'path': row['actualPath'], 'bytes': row['bytes'], 'sha256': row['sha256']})
    old_snapshot = Path(row['snapshotPath'])
    verify({'path': str(old_snapshot), 'bytes': row['bytes'], 'sha256': row['sha256']})
    destination = ROOT / 'norm' / row['relative']
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(old_snapshot.read_bytes())
    row['snapshotPath'] = str(destination)
norms['finalCheckedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
(ROOT / 'norm-bindings.json').write_text(json.dumps(norms, ensure_ascii=False, indent=2) + '\n')

primary_groups = []
for path in [Path('/tmp/motion-profile-f647-final-20261002/PRIMARY-PACKET.json'),
             Path('/tmp/motion-native-cpu-rle-final-20261002/PRIMARY-PACKET.json')]:
    packet = json.loads(path.read_text())
    primary_groups.append({'packet': binding(path),
                           'references': [verify(row) for row in packet['references']]})
assert [len(group['references']) for group in primary_groups] == [16, 20]

witness = json.loads((ROOT / 'witness.execution.json').read_text())
for relative, row in witness['inputs'].items():
    verify({'path': str(PREVIOUS / relative), **row})
for name, key in [('witness.stdout.json', 'stdoutSha256'), ('witness.stderr.log', 'stderrSha256')]:
    assert sha((ROOT / name).read_bytes()) == witness[key]
assert witness['exitCode'] == 0 and witness['allEND'] and not witness['timedOut']
assert witness['registeredTimingSamples'] == 0
helper = (ROOT / 'captured-private-helper.txt').read_bytes()
runner = Path(source['files']['bench/profile/server-profile-runner.mjs']['ownedSourcePath']).read_bytes()
assert runner.count(helper) == 1
outcomes = json.loads((ROOT / 'witness.stdout.json').read_text())
assert outcomes['jsonByteIdentity']
assert [len(outcomes[key]) for key in ['sourceCases', 'consumerCases', 'encodedCases']] == [13, 10, 7]
assert all(outcomes['atomicFailure'][key] for key in
           ['healthyAllEncoded', 'originalArraysPreserved', 'originalJsonPreserved', 'rawIdentityPreserved'])

prior_manifest = json.loads((OLDER / 'MANIFEST.json').read_text())
prior_files = []
for row in prior_manifest['files']:
    prior_files.append(verify({**row, 'path': str(OLDER / row['path'])}))
assert len(prior_files) == 676

link = ROOT / 'source'
if not link.exists():
    link.symlink_to(PREVIOUS / 'source', target_is_directory=True)
assert link.resolve() == (PREVIOUS / 'source').resolve()

all_bindings = {
    'schema': 'motion-independent-measurement-all-bindings-v2',
    'axis': 'measurement-method-and-acquired-cpu-evidence-preservation',
    'verdict': 'PASS', 'sourceHead': source['sourceHead'], 'sourceTree': source['sourceTree'],
    'sourceArchiveHead': source['sourceArchiveHead'],
    'sourceArchiveBinding': binding(source['sourceArchive']),
    'sourceFiles': source['files'],
    'literalCommitBinding': binding(ROOT / 'commit.raw'),
    'literalTreeBinding': binding(ROOT / 'tree.raw'),
    'primaryGroups': primary_groups, 'norms': norms['norms'],
    'witnessExecutionBinding': binding(ROOT / 'witness.execution.json'),
    'witnessRuntimeHead': witness['sourceHead'], 'freshRuntimeAtFinalHead': False,
    'witnessInputBindings': witness['inputs'],
    'witnessTransfer': 'all639-byte/mode/blob-and-Git-tree-identity',
    'priorOwn088ManifestBinding': binding(OLDER / 'MANIFEST.json'),
    'priorOwn088ProofFiles': prior_files,
    'checkedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'allEND': True, 'heavy': 0, 'queued': 0,
}
(ROOT / 'all-bindings.json').write_text(json.dumps(all_bindings, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'allSourceFiles': 639, 'finalPrimaryRefs': 16, 'previousPrimaryRefs': 20,
                  'priorOwnProofFiles': 676, 'newReadsetEntries': len(current_readset['entries']),
                  'freshRuntimeAtFinalHead': False, 'registeredTimingSamples': 0,
                  'allBindingsMatch': True, 'allEND': True, 'heavy': 0, 'queued': 0}, ensure_ascii=False))
