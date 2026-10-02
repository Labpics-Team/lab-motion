from pathlib import Path
import datetime
import hashlib
import json
import re
import tarfile

ROOT = Path(__file__).resolve().parent
PREVIOUS = Path('/tmp/motion-native-cpu-rle-measurement-f647-20261002')
PACKET = Path('/tmp/motion-qualified-fe092331-20261002')
HEAD = 'fe092331360837fd7f63d71a4b7f867ba849ebd4'
TREE = '285e30e36db32f2fdc9ae442327f6b3396dcf254'

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def oid(kind, raw):
    return hashlib.sha1(kind.encode() + b' ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()

def save(name, value):
    (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

prior = json.loads((PREVIOUS / 'source-bindings.json').read_text())
files = {}
with tarfile.open(PACKET / 'source.tar') as archive:
    for member in archive.getmembers():
        if member.isdir():
            continue
        assert member.isfile()
        raw = archive.extractfile(member).read()
        assert raw == (ROOT / 'source' / member.name).read_bytes()
        mode = '100755' if member.mode & 0o111 else '100644'
        current = {'bytes': len(raw), 'sha256': sha(raw), 'gitOid': oid('blob', raw), 'mode': mode,
                   'sourcePath': str(ROOT / 'source' / member.name)}
        before = prior['files'].get(member.name)
        current['unchangedFromf647'] = bool(before and all(current[k] == before[k] for k in ['bytes', 'sha256', 'gitOid', 'mode']))
        current['addedSincef647'] = before is None
        files[member.name] = current
assert len(files) == 641
assert not set(prior['files']) - set(files)
assert sum(row['unchangedFromf647'] for row in files.values()) == 634
assert sum(row['addedSincef647'] for row in files.values()) == 2

node = {}
for relative, row in files.items():
    parts = relative.split('/')
    directory = node
    for part in parts[:-1]:
        directory = directory.setdefault(part, {})
    directory[parts[-1]] = row

def tree_bytes(directory):
    entries = []
    for name, child in directory.items():
        if 'gitOid' in child:
            entries.append((name.encode(), child['mode'], name, child['gitOid']))
        else:
            entries.append((name.encode() + b'/', '40000', name, oid('tree', tree_bytes(child))))
    return b''.join(mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(value)
                    for _, mode, name, value in sorted(entries))

derived = tree_bytes(node)
actual_tree = (PACKET / 'tree.raw').read_bytes()
commit = (PACKET / 'commit.raw').read_bytes()
headers = commit.split(b'\n\n', 1)[0].splitlines()
assert oid('commit', commit) == HEAD
assert derived == actual_tree and oid('tree', derived) == TREE
assert b'tree ' + TREE.encode() in headers
commit_parents = [line[7:].decode() for line in headers if line.startswith(b'parent ')]
save('source-bindings.json', {
    'sourceHead': HEAD, 'sourceTree': TREE, 'base': 'f6476ae990254f606faf97f80afe41965bec2fb2',
    'archiveSha256': sha((PACKET / 'source.tar').read_bytes()),
    'all641SourceBindingsMatch': True, 'reconstructedTreeByteIdentical': True,
    'commitObjectOidVerified': True, 'literalCommitParents': commit_parents, 'unchangedFromf647': 634,
    'changed': [path for path, row in files.items() if not row['unchangedFromf647']], 'files': files,
    'checkedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
})

# Apply the supplied diff entirely in memory to own sealed f647 bytes.
diff = (PACKET / 'source.diff').read_text()
applied = []
for section in diff.split('diff --git ')[1:]:
    first = section.splitlines()[0]
    relative = first.split(' b/', 1)[1]
    before_path = PREVIOUS / 'source' / relative
    before = before_path.read_text() if before_path.exists() else ''
    lines = before.splitlines(keepends=True)
    section_lines = section.splitlines(keepends=True)
    cursor = 0
    result = []
    index = 1
    while index < len(section_lines):
        header = section_lines[index]
        match = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', header)
        if not match:
            index += 1
            continue
        old_start, old_count, new_start, new_count = [int(x) if x is not None else 1 for x in match.groups()]
        start = old_start - 1 if old_start else 0
        assert cursor <= start
        result.extend(lines[cursor:start])
        cursor = start
        index += 1
        observed_old = observed_new = 0
        while index < len(section_lines) and not section_lines[index].startswith('@@ '):
            line = section_lines[index]
            if line.startswith('\\ No newline'):
                raise AssertionError('Unexpected non-newline source')
            assert line[0] in ' +-', (relative, line)
            if line[0] in ' -':
                assert lines[cursor] == line[1:], (relative, cursor)
                cursor += 1
                observed_old += 1
            if line[0] in ' +':
                result.append(line[1:])
                observed_new += 1
            index += 1
        assert (observed_old, observed_new) == (old_count, new_count)
    result.extend(lines[cursor:])
    body = ''.join(result).encode()
    assert body == (ROOT / 'source' / relative).read_bytes(), relative
    applied.append({'path': relative, 'resultSha256': sha(body), 'hunksExactlyApplyToOwnf647': True})
assert len(applied) == 7
save('diff-bindings.json', {'diffSha256': sha(diff.encode()), 'applied': applied})

before = (PREVIOUS / 'source/test/server-profile-contract.test.ts').read_text()
after = (ROOT / 'source/test/server-profile-contract.test.ts').read_text()
literal_before = (ROOT / 'PRIMARY/tmp/motion-admission-granularity-20261002/before.test.ts').read_bytes()
assert literal_before == before.encode()
first = before.index("  it('завершённый public admission отвергает четыре независимых reviewer counterexamples'")
last = before.index('  }, 30_000);', first) + len('  }, 30_000);')
old_body = before[first:last]
starts = ['const earlyCalibration', 'const alwaysLeft', 'const ignoredFailure', 'const wrongPositive', 'const wrongFinish']
guards = []
for index, start in enumerate(starts):
    begin = old_body.index('    ' + start)
    end = old_body.index('    ' + starts[index + 1]) if index + 1 < len(starts) else old_body.index('  }, 30_000);')
    body = old_body[begin:end].rstrip()
    assert after.count(body) == 1, start
    assert body.count('expect(') == 1 and '.toThrow(' in body
    guards.append({'guard': start, 'bytes': len(body.encode()), 'sha256': sha(body.encode()), 'exactStatementsConserved': True})
assert old_body.count('.toThrow(') == 5
healthy = [line.strip() for line in old_body.splitlines() if 'expect(validateServerArtifact' in line or 'expect(validateServerJournal(artifact, history.records))' in line]
assert len(healthy) == 2 and all(line in after for line in healthy)
new_first = after.index("  let healthyAdmissionTask: TestContext['task']")
new_last = after.index('  }, 30_000);', after.index("  it('полная история отвергает подмену финального raw digest'", new_first)) + len('  }, 30_000);')
new_body = after[new_first:new_last]
assert new_body.count('  it(') == 6 and new_body.count('}, 30_000);') == 6
assert "expect(healthyAdmissionTask?.result?.state).toBe('pass');" in new_body
assert new_body.count('acceptedAdmission()') == 5
assert "const history = admissionHistory(), { artifact } = history;" in new_body
assert '.skip' not in new_body and '.only' not in new_body and 'beforeAll' not in new_body
assert before[:first].replace("from 'vitest';", "from 'vitest';", 1)[len(before.splitlines(keepends=True)[0]):] == after[:new_first][len(after.splitlines(keepends=True)[0]):]
assert before[last:] == after[new_last:]

functions = []
for name in ['stage', 'healthyAdmission', 'admissionEvents', 'chain', 'admissionHistory']:
    def capture(text):
        start = re.search(r'^function ' + name + r'\(', text, re.M)
        assert start, name
        end = text.index('\n}', start.end()) + 2
        return text[start.start():end].encode()
    a = capture(before); b = capture(after)
    assert a == b, name
    functions.append({'name': name, 'sha256': sha(a), 'bytes': len(a), 'byteIdentical': True})
save('admission-conservation.json', {
    'oldSourceSha256': sha(before.encode()), 'newSourceSha256': sha(after.encode()),
    'literalBeforeMatchesOwnf647': True, 'oldNegativeLaws': 5, 'newNegativeLaws': 5,
    'oldHealthyAssertions': 2, 'newHealthyAssertions': 2, 'newTimedTests': 6,
    'eachCaseTimeoutMs': 30000, 'oldCombinedTimeoutMs': 30000,
    'oldAggregateBudgetConserved': False, 'newAggregateMaximumMs': 180000,
    'fullNSetupInsideHealthyTimedCase': True, 'requiresFrameworkPassIncludingTimeout': True,
    'noSkipOrHiddenSetup': True, 'guardStatements': guards, 'conservedFunctions': functions,
    'testFileOutsidePartitionByteIdenticalExceptTypeImport': True,
})

# Independently bind and interpret the existing actual native primary.
primary = ROOT / 'PRIMARY/tmp/motion-native-clock-permanent-controls-20261002'
raw = json.loads((primary / 'stdout.log').read_text())
frozen = json.loads((primary / 'frozen-inputs.json').read_text())
for row in frozen['inputs']:
    file = ROOT / 'source' / row['path']
    assert len(file.read_bytes()) == row['bytes'] and sha(file.read_bytes()) == row['sha256']
assert raw['sourceSha256'] == files['bench/profile/server-thread-cpu-clock.c']['sha256']
assert raw['hostSha256'] == files['test/fixtures/server-thread-cpu-clock-host.c']['sha256']
actual = raw['records'][0]
assert actual['mode'] == 'actual-api'
values = []
for endpoint in actual['acquired']:
    value = int(endpoint['seconds']) * 1000000000 + endpoint['nanoseconds']
    assert str(value) == endpoint['valueNs'] and 0 <= endpoint['nanoseconds'] < 1000000000
    assert endpoint['pid'] == endpoint['tid'] == actual['metadata']['pid'] == actual['metadata']['tid']
    values.append(value)
assert values[1] > values[0]
for relative, expected in actual['metadata']['nativeSources'].items():
    assert files[relative]['sha256'] == expected
assert actual['metadata']['nominalResolutionIsNotErrorCertificate'] is True

original = (ROOT / 'source/bench/profile/server-thread-cpu-clock.c').read_text()
replacements = [
    ['wrong-clock', 'CLOCK_THREAD_CPUTIME_ID', 'CLOCK_PROCESS_CPUTIME_ID', True],
    ['read-errno', 'if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value) != 0) return fail(env, "CLOCK_READ", strerror(errno));', '(void)clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value);', False],
    ['invalid-timespec', 'if (value.tv_sec < 0 || value.tv_nsec < 0 || value.tv_nsec >= 1000000000L)', 'if (0)', False],
    ['invalid-identity', 'if (pid <= 0 || tid <= 0)', 'if (0)', False],
    ['seconds-number-loss', '!string_field(env, result, "seconds", seconds)', '!integer_field(env, result, "seconds", (int64_t)value.tv_sec)', False],
    ['resolution-errno', 'if (clock_getres(CLOCK_THREAD_CPUTIME_ID, &resolution) != 0) return fail(env, "CLOCK_RESOLUTION", strerror(errno));', '(void)clock_getres(CLOCK_THREAD_CPUTIME_ID, &resolution);', False],
]
mutants = []
for name, needle, replacement, all_occurrences in replacements:
    body = original.replace(needle, replacement) if all_occurrences else original.replace(needle, replacement, 1)
    row = next(row for row in raw['records'] if row.get('name') == name)
    assert row['sourceSha256'] == sha(body.encode())
    assert row['exitCode'] == 1 and row['stderr'].startswith('AssertionError')
    assert '-Wl,--wrap=clock_gettime' in row['argv'] and '-Wl,--wrap=clock_getres' in row['argv']
    mutants.append({'name': name, 'sourceSha256': sha(body.encode()), 'actualExitCode': row['exitCode'],
                    'actualAssertionFirstLine': row['stderr'].splitlines()[0], 'compiledInputExactlyReconstructed': True})
healthy_native = next(row for row in raw['records'] if row.get('name') == 'healthy-native')
assert healthy_native['exitCode'] == 0 and json.loads(healthy_native['stdout'])['controls'] == 10
save('native-primary-independent-readback.json', {
    'frozenInputHeadLabel': frozen['head'], 'freshReviewerNativeExecution': False,
    'allSixFrozenInputFilesMatchFinalSource': True, 'allFiveNativeSourceHeadersMatch': True,
    'actualReportedRuntimeDeltaNs': values[1] - values[0], 'exactEndpointArithmeticMatches': True,
    'physicalErrorCertificate': False, 'registeredTimingSamples': raw['registeredTimingSamples'],
    'healthyWrappedAbiExit': healthy_native['exitCode'], 'faultModes': 8,
    'mutants': mutants, 'rawExecution': json.loads((primary / 'execution.json').read_text()),
})

norms = json.loads((PREVIOUS / 'norm-bindings.json').read_text())
for row in norms['norms']:
    current = Path(row['actualPath']).read_bytes()
    assert sha(current) == row['sha256'] and len(current) == row['bytes']
    destination = ROOT / 'norm' / row['relative']
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(current)
    row['snapshotPath'] = str(destination)
norms['checkedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
save('norm-bindings.json', norms)
print(json.dumps({'head': HEAD, 'tree': TREE, 'sourceFiles': 641, 'unchangedFromf647': 634,
                  'diffSectionsExactlyApply': 7, 'oldAndNewNegativeLaws': 5,
                  'timedCases': 6, 'caseTimeoutMs': 30000, 'aggregateBudgetConserved': False,
                  'nativeMutantBytesReconstructed': 6, 'freshReviewerRuntime': False}, ensure_ascii=False))
