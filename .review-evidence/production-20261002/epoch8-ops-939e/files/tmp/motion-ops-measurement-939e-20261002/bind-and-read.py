"""Source/raw metadata audit only. No import or execution of Motion/runner/tests."""
import collections
import datetime
import hashlib
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).parent
SOURCE = ROOT / 'source'
PRIOR = Path('/tmp/motion-qualified-measurement-fe092-20261002')
EPOCH = Path('/tmp/motion-epoch8-actual-prefix-acceptance-20261002')
sha = lambda x: hashlib.sha256(x).hexdigest()
def git(kind, data): return hashlib.sha1(kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data).hexdigest()
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
start = utc()
pack = json.loads((ROOT / 'PRIMARY-PACKET.json').read_text())
def ref(path):
    path = Path(path); b = path.read_bytes()
    return {'path': str(path), 'bytes': len(b), 'sha256': sha(b)}
def read_record(path, scope, category='source-primary-readback'):
    record = dict(utc=utc(), category=category, reviewedScope=scope, **ref(path))
    with (ROOT / 'readset.ndjson').open('a') as out: out.write(json.dumps(record, ensure_ascii=False) + '\n')

base_bind = json.loads((PRIOR / 'all-bindings.json').read_text())
assert ref(PRIOR / 'MANIFEST.json')['sha256'] == 'ae22831f4a79399d6fcff1607522cc5e9faf3635b90f20be544cbf7a65b6742d'
assert ref(PRIOR / 'all-bindings.json')['sha256'] == '3f557f476d586211dffab0582659930b6f99a39447cd803bafbb847c6f8ad8a8'
source_refs = {}
changed = []
tree_entries = {}
tree_file = ROOT / 'PRIMARY/primary/tmp/motion-profile-ops-939e7f4a-20261002/tree.txt'
for line in tree_file.read_text().splitlines():
    header, relative = line.split('\t'); mode, kind, oid = header.split()
    assert kind == 'blob'
    data = (SOURCE / relative).read_bytes()
    assert git('blob', data) == oid, relative
    before = base_bind['sourceFiles'][relative]
    prior_data = Path(before['sourcePath']).read_bytes()
    assert sha(prior_data) == before['sha256'] and len(prior_data) == before['bytes']
    same = data == prior_data and mode == before['mode']
    if not same: changed.append(relative)
    source_refs[relative] = dict(ref(SOURCE / relative), gitOid=oid, mode=mode, byteIdenticalOwnFeSource=same)
    cursor = tree_entries
    parts = relative.split('/')
    for part in parts[:-1]: cursor = cursor.setdefault(part, {})
    cursor[parts[-1]] = (mode, oid)
def tree_oid(entries):
    out = b''
    for name, entry in sorted(entries.items(), key=lambda pair: (pair[0] + ('/' if isinstance(pair[1], dict) else '')).encode()):
        if isinstance(entry, dict): mode, oid = '40000', tree_oid(entry)
        else: mode, oid = entry
        out += mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(oid)
    return git('tree', out)
assert len(source_refs) == 641 and tree_oid(tree_entries) == pack['tree'] == 'deba4db1952029bdb7d2244b207f570007700b19'
assert sorted(changed) == sorted(pack['changedPaths']) and len(changed) == 5
commit_file = ROOT / 'PRIMARY/primary/tmp/motion-profile-ops-939e7f4a-20261002/commit.txt'
commit_bytes = commit_file.read_bytes()
assert git('commit', commit_bytes) == pack['head'] == '939e7f4a7ebef2dd494f9dec8690932fecebfd73'
assert commit_bytes.splitlines()[0] == b'tree deba4db1952029bdb7d2244b207f570007700b19'
assert commit_bytes.splitlines()[1] == b'parent fe092331360837fd7f63d71a4b7f867ba849ebd4'

# Apply all exact immutable unified hunks to our own sealed base bytes in memory.
diff_file = ROOT / 'PRIMARY/primary/tmp/motion-profile-ops-939e7f4a-20261002/source.diff'
diff = diff_file.read_text().splitlines(keepends=True)
sections = []
for index, line in enumerate(diff):
    if line.startswith('diff --git '): sections.append(index)
sections.append(len(diff))
for begin, end in zip(sections, sections[1:]):
    segment = diff[begin:end]
    relative = segment[0].strip().split(' b/', 1)[1]
    before = (PRIOR / 'source' / relative).read_text().splitlines(keepends=True)
    out = []; cursor = 0; i = 0
    while i < len(segment):
        line = segment[i]
        if not line.startswith('@@ '): i += 1; continue
        match = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', line)
        at = int(match[1]) - 1
        assert at >= cursor
        out.extend(before[cursor:at]); cursor = at; old_count = new_count = 0; i += 1
        while i < len(segment) and not segment[i].startswith('@@ '):
            part = segment[i]
            if part.startswith(' '): assert before[cursor] == part[1:]; out.append(part[1:]); cursor += 1; old_count += 1; new_count += 1
            elif part.startswith('-'): assert before[cursor] == part[1:]; cursor += 1; old_count += 1
            elif part.startswith('+'): out.append(part[1:]); new_count += 1
            else: assert part.startswith('\\ No newline')
            i += 1
        assert old_count == int(match[2] or 1) and new_count == int(match[4] or 1), relative
    out.extend(before[cursor:])
    assert ''.join(out).encode() == (SOURCE / relative).read_bytes(), relative

def function_region(text, name):
    starts = list(re.finditer(r'^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\(', text, re.M))
    for index, match in enumerate(starts):
        if match[1] == name: return text[match.start():starts[index + 1].start() if index + 1 < len(starts) else len(text)]
    raise ValueError(name)
old_runner = (PRIOR / 'source/bench/profile/server-profile-runner.mjs').read_text()
runner = (SOURCE / 'bench/profile/server-profile-runner.mjs').read_text()
conserved_functions = {}
for name in ['errorRecord', 'withBrowserTimeout', 'createServerJournal', 'measureServerEngine', 'measureServerStockC', 'browserTimerProbe', 'measureServerBrowser', 'measureBrowserRawControls', 'makeRetention']:
    a, b = function_region(old_runner, name), function_region(runner, name)
    assert a == b, name
    conserved_functions[name] = {'bytes': len(b.encode()), 'sha256': sha(b.encode()), 'byteIdentical': True, 'rangeRule': 'top-level declaration through next top-level declaration'}
registration = (SOURCE / 'bench/profile/server-profile-registration.mjs').read_text()
old_registration = (PRIOR / 'source/bench/profile/server-profile-registration.mjs').read_text()
assert registration.split('export function serverProfileDigest', 1)[1] == old_registration.split('export function serverProfileDigest', 1)[1]
new_stop = re.search(r"stoppingRule: '([^']*)'", registration)[1]
old_stop = re.search(r"stoppingRule: '([^']*)'", old_registration)[1]
assert old_registration.replace(old_stop, new_stop) == registration
preserved_owners = [path for path in base_bind['sourceFiles'] if path not in changed]

norms = []
for bound in base_bind['norms']['norms']:
    item = ref(bound['actualPath']);assert item['sha256'] == bound['sha256'] and item['bytes'] == bound['bytes']
    dest = ROOT / 'norm' / bound['relative'];dest.parent.mkdir(parents=True, exist_ok=True);dest.write_bytes(Path(item['path']).read_bytes())
    norms.append(dict(item, ownedSnapshotPath=str(dest), relative=bound['relative'], byteIdenticalOwnFeNorm=True))
    read_record(dest, 'Exact current norm bytes transferred from own sealed fe proof', 'norm-binding')

# Read literal embedded native/signal evidence, not author verdict fields.
native_file = ROOT / 'PRIMARY/primary/tmp/motion-profile-ops-native-v3-20261002/stdout.log'
native_text = native_file.read_text()
native = json.loads(native_text)
assert native['sourceSha256'] == source_refs['bench/profile/server-thread-cpu-clock.c']['sha256']
assert native['hostSha256'] == source_refs['test/fixtures/server-thread-cpu-clock-host.c']['sha256']
assert native['node'] == 'v24.19.0' and native['registeredTimingSamples'] == 0
dec = json.JSONDecoder()
def field_spans(text, field):
    marker = '"' + field + '":'; out = []; pos = 0
    while True:
        index = text.find(marker, pos)
        if index == -1: return out
        begin = index + len(marker)
        while text[begin].isspace(): begin += 1
        value, end = dec.raw_decode(text, begin)
        out.append((value, text[begin:end]));pos = end

signal_records = [x for x in native['records'] if x.get('mode') == 'operator-signal']
artifacts = field_spans(native_text, 'artifact')
journals = field_spans(native_text, 'journal')
assert len(signal_records) == len(artifacts) == len(journals) == 2
old_protocol = json.loads((EPOCH / 'PRIMARY/predata-tuple.json').read_text())['protocol']
expected_protocol = dict(old_protocol, stoppingRule=new_stop)
signal_readback = []
for record, (artifact, artifact_literal), (journal, journal_literal) in zip(signal_records, artifacts, journals):
    assert record['artifact'] == artifact and record['journal'] == journal
    assert artifact['protocol'] == expected_protocol
    assert artifact['registration'] is None and artifact['registrationDigest'] is None and artifact['verdict'] == 'UNPROVEN' and artifact['stages'] == []
    assert record['aborts'] == 1 and record['signal'] in ['SIGINT', 'SIGTERM'] and len(artifact['failures']) == 1
    error = artifact['failures'][0]['error']
    assert error['code'] == 'OPERATOR_INTERRUPTION' and error['name'] == 'AbortError' and error['raw']['signal'] == record['signal']
    artifact_sha = sha((artifact_literal + '\n').encode())
    assert [x['type'] for x in journal] == ['failure', 'finished']
    assert journal[0]['value'] == artifact['failures'][0] and journal[1]['value'] == {'verdict': 'UNPROVEN', 'digest': artifact_sha}
    pos = 1; previous = '0' * 64; hashed = 0
    while pos < len(journal_literal):
        while journal_literal[pos].isspace(): pos += 1
        if journal_literal[pos] == ']': break
        begin = pos; row, pos = dec.raw_decode(journal_literal, pos); literal = journal_literal[begin:pos]
        payload, suffix = literal.rsplit(',"digest":', 1)
        assert row['sequenceDigest'] == previous and sha((payload + '}').encode()) == row['digest']
        previous = row['digest'];hashed += 1
        if journal_literal[pos] == ',':pos += 1
    assert hashed == 2
    protocol_literal = field_spans(artifact_literal, 'protocol')[0][1]
    clock_literal = field_spans(protocol_literal, 'clockError')[0][1]
    signal_readback.append({'signal': record['signal'], 'aborts': record['aborts'], 'registeredPerformanceSamples': 0,
                            'receivedAt': error['raw']['receivedAt'], 'failureAt': artifact['failures'][0]['at'],
                            'artifactReconstructedExactBytes': len((artifact_literal + '\n').encode()), 'artifactSha256': artifact_sha,
                            'journalFinalDigest': previous, 'protocolDigest': sha(protocol_literal.encode()), 'clockModelDigest': sha(clock_literal.encode()),
                            'scope': 'real Node OS signal before preparation; registration-null refusal/finally only'})
assert {x['signal'] for x in signal_readback} == {'SIGINT', 'SIGTERM'}
assert signal_readback[0]['protocolDigest'] == signal_readback[1]['protocolDigest']
assert signal_readback[0]['clockModelDigest'] == '04d863513d53b248b1be3e0905240f3bd6f4d06124582ce3093c2cbfe5320852'
assert signal_readback[0]['protocolDigest'] != 'ce535cf6d6f0b0f140d44403627b63d936ef2461883a52680e7bbcad3ee49e5a'

native_c = (SOURCE / 'bench/profile/server-thread-cpu-clock.c').read_text()
mutations = [
    ('wrong-clock','CLOCK_THREAD_CPUTIME_ID','CLOCK_PROCESS_CPUTIME_ID',True),
    ('read-errno','if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value) != 0) return fail(env, "CLOCK_READ", strerror(errno));','(void)clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value);',False),
    ('invalid-timespec','if (value.tv_sec < 0 || value.tv_nsec < 0 || value.tv_nsec >= 1000000000L)','if (0)',False),
    ('invalid-identity','if (pid <= 0 || tid <= 0)','if (0)',False),
    ('seconds-number-loss','!string_field(env, result, "seconds", seconds)','!integer_field(env, result, "seconds", (int64_t)value.tv_sec)',False),
    ('resolution-errno','if (clock_getres(CLOCK_THREAD_CPUTIME_ID, &resolution) != 0) return fail(env, "CLOCK_RESOLUTION", strerror(errno));','(void)clock_getres(CLOCK_THREAD_CPUTIME_ID, &resolution);',False),
]
mutation_refs = []
for name, before, after, all_ in mutations:
    record = next(x for x in native['records'] if x.get('name') == name)
    changed_c = native_c.replace(before, after) if all_ else native_c.replace(before, after, 1)
    assert sha(changed_c.encode()) == record['sourceSha256'] and record['exitCode'] == 1 and 'AssertionError' in record['stderr']
    mutation_refs.append({'name':name, 'sourceSha256':record['sourceSha256'], 'actualExit':record['exitCode'], 'assertionFailurePresent':True})
healthy = next(x for x in native['records'] if x.get('name') == 'healthy-native')
assert healthy['exitCode'] == 0 and healthy['sourceSha256'] == sha(native_c.encode())
api = next(x for x in native['records'] if x.get('mode') == 'actual-api')
for read in api['acquired']:
    assert read['pid'] == read['tid'] == api['metadata']['pid']
    assert int(read['valueNs']) == int(read['seconds']) * 10**9 + read['nanoseconds']
assert int(api['acquired'][1]['valueNs']) > int(api['acquired'][0]['valueNs'])

factors = [1,1,100,100,2,2,3,3]
contrasts = [(-math.log(factors[2*i])-math.log(factors[2*i+1]))/2 for i in range(4)]
mean = sum(contrasts)/4;sd = math.sqrt(sum((x-mean)**2 for x in contrasts)/3)
synthetic_required = 2*math.ceil(((3.052065201864885+0.8416212335729143)*sd/math.log(1.05))**2)
assert synthetic_required > 1024

gate_dir = ROOT / 'PRIMARY/supplement/tmp/motion-profile-ops-current-gates-939e7f4a-20261002'
receipt = json.loads((gate_dir/'receipt.json').read_text())
assert receipt['head'] == pack['head'] and receipt['exit'] == 0 and receipt['allChildrenJoined'] is True
for command in receipt['commands']:
    assert command['exit'] == 0
    for name, bound in command['files'].items():
        data = (gate_dir/name).read_bytes();assert len(data)==bound['bytes'] and sha(data)==bound['sha256']
pnpm = ref(gate_dir/'candidate-pnpm.tgz');npm = ref(gate_dir/'labpics-motion-0.3.0.tgz')
assert pnpm['sha256']=='b41708c31e122da9ae46a558f0c5f447195f36ca19c9b0fe6c19954887d790e4'
assert npm['sha256']=='54482b3da5ae3e530e9f25f29b91471b1ff95cf2d8212735a0eeb71002d6fba7'

result = {'schema':'independent-ops939e-code-primary-binding-v1','actualStartUtc':start,'actualEndUtc':utc(),
          'sourceHead':pack['head'],'sourceTree':pack['tree'],'base':pack['base'],'sourceFiles':source_refs,
          'commitOidVerified':True,'reconstructedTreeOidVerified':True,'exactDiffAllFiveFilesAppliedInMemory':True,
          'changedPaths':changed,'unchangedFiles':len(preserved_owners),'conservedFunctions':conserved_functions,
          'registrationChangeOnlyStoppingRule':True,'unchangedTailNMathFunctions':True,'norms':norms,
          'primaryRefs':json.loads((ROOT/'primary-integrity.json').read_text()),
          'ownFeProofFiles':[ref(PRIOR/name) for name in ['MANIFEST.json','all-bindings.json','readset.json','terminal.json']],
          'separateFeEpoch8ProofFiles':[ref(EPOCH/name) for name in ['MANIFEST.json','REPORT.md','terminal.json']],
          'proofTransferScope':'unchanged functions/owners/norm/prerequisites only; stopping/protocol identity changes; epoch8 is fe negative evidence, not 939e performance PASS',
          'nativePrimaryCAndHostPinsMatched':True,'nativeRecordCount':len(native['records']),'nativeMutants':mutation_refs,
          'operatorSignalEmbeddedPrimaryReadback':signal_readback,'syntheticPowerControlRequiredRuns':synthetic_required,
          'freshGateReceiptBound':True,'freshGateEndUtc':receipt['endedAt'],'freshRequiredCommands':[{'name':x['name'],'actualExit':x['exit'],'actualEndUtc':x['finishedAt']} for x in receipt['commands']],
          'packageByteConservation':{'pnpm':pnpm,'npm':npm,'byteIdenticalOwnFePackageSha':True},
          'nativeFixtureExecutionSourceLimit':'v3 receipt has argv and exact native C/host plus embedded protocol outputs, but no complete runner/fixture input hash in its execution receipt; do not claim fresh OS-signal CI execution of immutable HEAD939e',
          'registeredReviewerSamples':0,'SUTExecutions':0,'nativeReviewerExecutions':0,'heavy':0,'queued':0}
(ROOT/'all-bindings.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
for path,scope in [(diff_file,'Every exact immutable diff hunk, applied against own fe source in memory'),(tree_file,'All 641 mode/blob bindings and full tree reconstruction'),(commit_file,'Literal commit OID/tree/parent binding only; commit message hashed, not semantic oracle'),(native_file,'Full literal native records; exact C/host/mutants and both embedded signal artifact/journal SHA reconstructions'),(gate_dir/'receipt.json','Full current-head required command identity/start/end/exit/stdout stderr SHA bindings')]:read_record(path,scope)
print(json.dumps({'sourceFiles':641,'changedFiles':len(changed),'unchangedFiles':len(preserved_owners),'conservedFunctions':list(conserved_functions),'signalArtifacts':signal_readback,'nativeRecords':len(native['records']),'syntheticPowerRequired':synthetic_required,'freshGatesEnd':receipt['endedAt'],'actualEndUtc':result['actualEndUtc'],'heavy':0,'queued':0},ensure_ascii=False,indent=2))
