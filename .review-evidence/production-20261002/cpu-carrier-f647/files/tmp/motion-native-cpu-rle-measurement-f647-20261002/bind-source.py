from pathlib import Path
import datetime
import hashlib
import json
import tarfile

ROOT = Path(__file__).resolve().parent
PREVIOUS = Path('/tmp/motion-native-cpu-rle-measurement-5a4c-20261002')
OLDER = Path('/tmp/motion-native-clock-measurement-088-20261002')
PACKET = Path('/tmp/motion-profile-f647-final-20261002')
ARCHIVE = Path('/tmp/motion-native-cpu-rle-final-20261002/source.tar')
HEAD = 'f6476ae990254f606faf97f80afe41965bec2fb2'
TREE = '40fbe427bbd750e9423feb71b6b6238080300022'

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def git_oid(kind, raw):
    return hashlib.sha1(kind.encode() + b' ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()

def save(name, value):
    (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

rows = {}
previous = json.loads((PREVIOUS / 'source-bindings.json').read_text())
with tarfile.open(ARCHIVE) as archive:
    for member in archive.getmembers():
        if member.isdir():
            continue
        assert member.isfile(), member.name
        assert member.name not in rows
        raw = archive.extractfile(member).read()
        source = PREVIOUS / 'source' / member.name
        owned_raw = source.read_bytes()
        mode = '100755' if member.mode & 0o111 else '100644'
        row = {
            'bytes': len(raw), 'sha256': sha(raw), 'gitOid': git_oid('blob', raw),
            'mode': mode, 'ownedSourcePath': str(source),
            'byteIdenticalOwned5a4Source': raw == owned_raw,
            'byteIdentical5a4Binding': all(previous['files'][member.name][k] == v for k, v in {
                'bytes': len(raw), 'sha256': sha(raw), 'gitOid': git_oid('blob', raw), 'mode': mode
            }.items()),
            'unchangedFrom088': previous['files'][member.name]['unchangedFrom088'],
        }
        assert row['byteIdenticalOwned5a4Source'] and row['byteIdentical5a4Binding'], member.name
        rows[member.name] = row
assert len(rows) == 639 and set(rows) == set(previous['files'])

directories = {}
for relative, row in rows.items():
    parts = relative.split('/')
    current = directories
    for part in parts[:-1]:
        current = current.setdefault(part, {})
    current[parts[-1]] = row

def build_tree(node):
    entries = []
    for name, child in node.items():
        if 'gitOid' in child:
            entries.append((name.encode(), child['mode'], name, child['gitOid']))
        else:
            tree_raw = build_tree(child)
            entries.append((name.encode() + b'/', '40000', name, git_oid('tree', tree_raw)))
    entries.sort(key=lambda item: item[0])
    return b''.join(mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(oid)
                    for _, mode, name, oid in entries)

derived_tree_raw = build_tree(directories)
provided_tree_raw = (PACKET / 'tree.raw').read_bytes()
commit_raw = (PACKET / 'commit.raw').read_bytes()
commit_headers = commit_raw.split(b'\n\n', 1)[0].splitlines()
commit_tree = next(x[5:].decode() for x in commit_headers if x.startswith(b'tree '))
commit_parents = [x[7:].decode() for x in commit_headers if x.startswith(b'parent ')]
assert git_oid('commit', commit_raw) == HEAD
assert derived_tree_raw == provided_tree_raw
assert git_oid('tree', derived_tree_raw) == TREE == commit_tree == previous['tree']
(ROOT / 'commit.raw').write_bytes(commit_raw)
(ROOT / 'tree.raw').write_bytes(provided_tree_raw)

save('source-bindings.json', {
    'sourceHead': HEAD, 'sourceTree': TREE,
    'sourceArchiveHead': previous['head'], 'sourceArchive': str(ARCHIVE),
    'sourceArchiveSha256': sha(ARCHIVE.read_bytes()),
    'commitParents': commit_parents, 'commitRawSha256': sha(commit_raw),
    'providedTreeRawSha256': sha(provided_tree_raw),
    'derivedTreeRawSha256': sha(derived_tree_raw),
    'all639BindingsMatchArchiveAndOwned5a4Source': True,
    'unchangedFrom088Count': sum(x['unchangedFrom088'] for x in rows.values()),
    'checkedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'files': rows,
})

old_readset = json.loads((OLDER / 'readset.json').read_text())
integrity_cache = {}
transferred_entries = []
for entry in old_readset['entries']:
    p = Path(entry['path'])
    if str(p) not in integrity_cache:
        raw = p.read_bytes()
        integrity_cache[str(p)] = {'bytes': len(raw), 'sha256': sha(raw)}
    actual = integrity_cache[str(p)]
    assert actual['sha256'] == entry['sha256'], str(p)
    assert actual['bytes'] == entry['bytes'], str(p)
    transferred = dict(entry)
    transferred['originSourceHead'] = '088fbc605c95fd6a6a7620301a450d6388386997'
    transferred['originalArtifactStillByteIdentical'] = True
    if str(p).startswith(str(OLDER / 'source') + '/'):
        relative = p.relative_to(OLDER / 'source').as_posix()
        transferred['finalSourceRelativePath'] = relative
        transferred['transfer'] = ('whole-file-byte-identity' if rows[relative]['unchangedFrom088']
                                  else 'only-conserved-function-fragments-plus-reviewed-new-delta')
    elif str(p).startswith(str(OLDER / 'norm') + '/'):
        transferred['transfer'] = 'norm-byte-identity-confirmed-again'
    else:
        transferred['transfer'] = 'own-prior-primary-proof-retained; historical-not-fresh-runtime'
    transferred_entries.append(transferred)

local_entries = [json.loads(line) for line in (PREVIOUS / 'readset.ndjson').read_text().splitlines()]
for entry in local_entries:
    raw = Path(entry['path']).read_bytes()
    assert sha(raw) == entry['sha256'] and len(raw) == entry['bytes']
save('readset.json', {
    'schema': 'motion-independent-measurement-readset-v2',
    'sourceHead': HEAD, 'sourceTree': TREE, 'entries': local_entries,
    'transferredOwn088Entries': transferred_entries,
    'sourceIntegritySeparate': 'source-bindings.json: 639 files; identity is not semantic coverage',
    'fragmentTransferSeparate': 'function-transfer-bindings.json; primary-fragment-bindings.json',
    'finalPrimaryRead': {
        'path': str(PACKET / 'PRIMARY-PACKET.json'),
        'sha256': sha((PACKET / 'PRIMARY-PACKET.json').read_bytes()),
        'scope': 'source/head/tree/base/reference metadata only; all 16 refs bytes/hash',
        'commitRaw': 'full hash; only commit header tree/parent for meaning; commit message unused',
        'treeRaw': 'full binary reconstructed from archive mode/name/blob identity',
    },
    'skillsRead': old_readset['skillsRead'],
    'notRead': ['foreign REPORT/HANDOFF/root verdicts', 'author rationale',
                'author cost interpretation/profile-top content', 'abandoned6502 source semantics'],
    'witnessRuntimeHead': previous['head'],
    'witnessTransfer': 'exact whole SOURCE tree and all 639 source byte/mode/blob bindings',
    'freshRuntimeAtFinalHead': False,
})
save('previous-proof-integrity.json', integrity_cache)
for name in ['norm-bindings.json', 'initial-primary-integrity.json', 'function-transfer-bindings.json',
             'primary-fragment-bindings.json', 'witness.mjs', 'witness.stdout.json',
             'witness.stderr.log', 'witness.execution.json', 'captured-private-helper.txt', 'start.json']:
    (ROOT / name).write_bytes((PREVIOUS / name).read_bytes())
(ROOT / 'readset.ndjson').write_bytes((PREVIOUS / 'readset.ndjson').read_bytes())
print(json.dumps({'sourceHead': HEAD, 'sourceTree': TREE,
                  'sourceFiles': len(rows), 'allSourceBindingsMatch': True,
                  'transferredOwn088Entries': len(transferred_entries),
                  'newSourceReads': len(local_entries), 'freshRuntimeAtFinalHead': False}, ensure_ascii=False))
