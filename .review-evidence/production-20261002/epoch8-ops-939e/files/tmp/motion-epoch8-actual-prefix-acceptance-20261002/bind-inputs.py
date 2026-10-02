import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
PRIOR = Path('/tmp/motion-qualified-measurement-fe092-20261002')
SOURCE = PRIOR / 'source'
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
sha = lambda b: hashlib.sha256(b).hexdigest()
def ref(path):
    path = Path(path); data = path.read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': sha(data)}
def record(path, scope, category):
    item = dict(utc=utc(), category=category, reviewedScope=scope, **ref(path))
    with (ROOT / 'readset.ndjson').open('a') as f: f.write(json.dumps(item, ensure_ascii=False) + '\n')

prior = json.loads((PRIOR / 'all-bindings.json').read_text())
assert ref(PRIOR / 'MANIFEST.json')['sha256'] == 'ae22831f4a79399d6fcff1607522cc5e9faf3635b90f20be544cbf7a65b6742d'
assert ref(PRIOR / 'all-bindings.json')['sha256'] == '3f557f476d586211dffab0582659930b6f99a39447cd803bafbb847c6f8ad8a8'
assert prior['sourceHead'] == 'fe092331360837fd7f63d71a4b7f867ba849ebd4' and prior['sourceTree'] == '285e30e36db32f2fdc9ae442327f6b3396dcf254'
proof = [ref(PRIOR / name) for name in ['MANIFEST.json', 'all-bindings.json', 'readset.json', 'source-bindings.json', 'norm-bindings.json', 'terminal.json', 'FINAL-SEAL.json', 'REPORT.md']]
source_refs = {}
for relative, bound in prior['sourceFiles'].items():
    item = ref(SOURCE / relative)
    assert (item['bytes'], item['sha256']) == (bound['bytes'], bound['sha256']), relative
    source_refs[relative] = dict(item, gitOid=bound['gitOid'], mode=bound['mode'], byteIdenticalOwnSealedFeSource=True)
assert len(source_refs) == 641
norm_refs = []
for bound in prior['norms']['norms']:
    item = ref(bound['actualPath']); assert (item['bytes'], item['sha256']) == (bound['bytes'], bound['sha256']), bound['relative']
    dest = ROOT / 'norm' / bound['relative'];dest.parent.mkdir(parents=True, exist_ok=True);dest.write_bytes(Path(item['path']).read_bytes())
    norm_refs.append(dict(item, relative=bound['relative'], ownedSnapshotPath=str(dest), byteIdenticalOwnSealedFeNorm=True))
    record(dest, 'Exact-byte norm transfer from own sealed fe proof; applicable current norm scope', 'norm-identity')

packet = Path('/tmp/motion-qualified-fe092331-20261002/PRIMARY-PACKET.json')
immutable = [ref(packet), ref(packet.parent / 'source.tar'), ref(packet.parent / 'source.diff')]
assert immutable[0]['sha256'] == '4184a52ea58d4f3b27e7cd4c571425c51efda578f1a283b2aab396dd0659e29e'
assert immutable[1]['sha256'] == 'a91db3d664b91a7e169a49de4794fa7150064f35fe281a6a2b6fec2fd6023709'
assert immutable[2]['sha256'] == '6700f7b29e449eaaace6e386be0a05e18cbfe6891f7b8192b762704fb0872deb'
for x in immutable: record(x['path'], 'Exact immutable source binding only; own sealed source proof transferred', 'source-identity')
assert ref(ROOT / 'PRIMARY-PACKET.json')['sha256'] == 'faa1eca3ff8b228ef2b57f6492e3c2ff3fad208ec8419e408dcf5ffee3313860'

raw = json.loads((ROOT / 'PRIMARY/server-profile.json').read_text())
tuple_ = json.loads((ROOT / 'PRIMARY/predata-tuple.json').read_text())
harness = []
for key, value in raw['registration']['harness'].items():
    if key.startswith('adapter:'):
        item = ref(ROOT / 'PRIMARY' / Path(value['path']).name)
        assert item['sha256'] == value['sha256']
        owner = Path(value['ownerEntry']).relative_to('/workspace/lab-motion').as_posix()
        assert source_refs[owner]['sha256'] == value['ownerEntrySha256']
        harness.append(dict(item, key=key, owner=owner, ownerSha256=value['ownerEntrySha256'], exactBinding=True))
    else:
        assert source_refs[key]['sha256'] == value['sha256']
        harness.append(dict(source_refs[key], key=key, exactBinding=True))
for owner, digest in tuple_['ownerHashes'].items(): assert source_refs[owner]['sha256'] == digest
clock = raw['registration']['engineClock']; preclock = tuple_['clockRegistration']['engineClock']
for key in ['nativeSourceDigest', 'nativeSources', 'node', 'napiVersion', 'libc', 'nominalResolutionNs', 'nominalResolutionIsNotErrorCertificate']:
    assert clock[key] == preclock[key], key
for relative, digest in clock['nativeSources'].items(): assert source_refs[relative]['sha256'] == digest
assert clock['nativeBinary']['sha256'] == preclock['nativeBinary']['sha256'] == ref(ROOT / 'PRIMARY/actual-thread-cpu-clock.node')['sha256']
assert clock['compiler']['binarySha256'] == preclock['compiler']['binarySha256']

packages = []
for role in ['baseline', 'candidate']:
    value = raw['registration']['packages'][role]; original = ref(value['tarball'])
    assert original['sha256'] == value['tarballSha256']
    target = ROOT / 'PRIMARY' / (role + '-actual-consumer.tgz'); target.write_bytes(Path(original['path']).read_bytes())
    packages.append(dict(original, role=role, ownedCopy=str(target), recordedTreeSha256=value['treeSha256'], recordedFileCount=value['files'], measurementClaim=role == 'baseline'))

result = {'schema': 'independent-epoch8-all-input-bindings-v1', 'checkedUtc': utc(),
          'sourceHead': prior['sourceHead'], 'sourceTree': prior['sourceTree'], 'effectiveBase': 'f6476ae990254f606faf97f80afe41965bec2fb2',
          'immutableSourceInputs': immutable, 'sourceFiles': source_refs, 'all641SourceBytesUnchanged': True,
          'ownSealedProofTransfer': {'files': proof, 'scope': 'unchanged measurement law, CPU ABI/codec and statistical/provenance prerequisites; no new timing/calibration/NI claim'},
          'norms': norm_refs, 'authorPacket': ref(ROOT / 'PRIMARY-PACKET.json'),
          'primary28': json.loads((ROOT / 'primary-integrity.json').read_text()),
          'additionalPredataBindings': json.loads((ROOT / 'predatapacket-integrity.json').read_text()),
          'actualNativeBinary': json.loads((ROOT / 'native-clock-actual-binding.json').read_text()),
          'currentNativeVsPredata': {'modelBytesAndSourcePinsMatched': True, 'binaryBytesMatched': True, 'pidChangedForActualProcess': [preclock['pid'], clock['pid']], 'reviewerNativeExecution': False},
          'actualHarnessBindings': harness, 'actualPackageTarballBindings': packages,
          'readerOperation': json.loads((ROOT / 'canonical-reader.END.json').read_text()),
          'independentLiteralReadback': ref(ROOT / 'independent-readback.json'),
          'semanticOracleExclusions': ['foreign reports/verdicts/author rationale', 'RAW-SUMMARY.json and FINAL-SMALL-CHECK.json parsed classifications/counts', 'ROOT-QUIET-GRANT CI/review assessment fields', 'mutable/future product source'],
          'registeredReviewerSutSamples': 0, 'registeredReviewerSeriesLaunches': 0, 'allEND': True, 'heavy': 0, 'queued': 0}
(ROOT / 'all-bindings.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
record(PRIOR / 'all-bindings.json', 'Own sealed fe proof source/norm identity and transfer scope; no foreign oracle', 'own-proof-transfer')
record(PRIOR / 'MANIFEST.json', 'Own sealed manifest digest/axis and source identity', 'own-proof-transfer')
record(ROOT / 'PRIMARY/predata-tuple.json', 'Predata identity, owners/clock pins, scope/chronology; qualitative author assertions not used as oracle', 'primary-predata')
record(ROOT / 'PRIMARY/server-profile.json', 'Current frozen provenance: all 31 harness/adapters, native source/binary identities and actual tarball SHA', 'primary-provenance')
print(json.dumps({'sourceFiles': len(source_refs), 'norms': len(norm_refs), 'harness': len(harness), 'nativeSourcePins': len(clock['nativeSources']), 'packages': len(packages), 'sourceArchiveSha256': immutable[1]['sha256'], 'allEND': True, 'heavy': 0, 'queued': 0}, indent=2))
