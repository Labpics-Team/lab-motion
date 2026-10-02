import pathlib, json, hashlib, datetime, subprocess, os, shutil

root = pathlib.Path('/tmp/motion-native-clock-so-088-20261002')
src = root / 'source'
observations = []

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def run(name, argv, env=None):
    start = utc()
    result = subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True, timeout=10)
    end = utc()
    (root / (name + '.stdout')).write_text(result.stdout)
    (root / (name + '.stderr')).write_text(result.stderr)
    observations.append({'name': name, 'argv': argv, 'startUtc': start, 'endUtc': end,
                         'exitCode': result.returncode, 'envPATH': env.get('PATH') if env else None,
                         'stdoutSha256': hashlib.sha256(result.stdout.encode()).hexdigest(),
                         'stderrSha256': hashlib.sha256(result.stderr.encode()).hexdigest()})
    assert result.returncode == 0, (name, result.returncode, result.stderr)
    print(name, result.stdout.strip()[:700])

node = shutil.which('node')
env = dict(os.environ)
env['PATH'] = ''
run('pure-boundaries', [node, str(root / 'pure-boundaries.mjs')], env)
run('native-linkage', ['/usr/bin/readelf', '-d', '/tmp/motion-native-clock-api-smoke-green-20261002/native-clock/thread-cpu-clock.node'])

source_manifest = json.loads(pathlib.Path('/tmp/motion-native-clock-successor-088fbc60-20261002/source-manifest.json').read_text())
mismatches = [name for name, info in source_manifest['files'].items()
              if hashlib.sha256((src / name).read_bytes()).hexdigest() != info['sha256']]
assert not mismatches
package = json.loads((src / 'package.json').read_text())
assert not any(value.startswith('bench/') or 'server-profile' in value or 'native-clock' in value for value in package['files'])
assert not any('server-profile' in value or 'server-thread-cpu' in value or 'native-clock' in value for value in package['scripts'].values())
changes = [line.split(' b/', 1)[1] for line in pathlib.Path('/tmp/motion-native-clock-successor-088fbc60-20261002/diff.patch').read_text().splitlines()
           if line.startswith('diff --git ')]
assert not any(name.startswith('src/') or name in ('package.json', 'pnpm-lock.yaml', 'tsup.config.ts') for name in changes)
assert not any('server-thread-cpu' in file.read_text() or 'native-clock' in file.read_text() for file in (src / 'src').rglob('*.ts'))
(root / 'source-identity-check.json').write_text(json.dumps({'head': source_manifest['head'], 'tree': source_manifest['tree'],
    'filesChecked': len(source_manifest['files']), 'mismatches': mismatches, 'changedPaths': changes,
    'noChangedRuntimePackageBoundary': True}, indent=2) + '\n')

# Size model only: identical numerical endpoint, representative six-digit PID.
# These constructed objects are never submitted as measured observations.
old = {'sequence': 0, 'userUs': 1123456, 'systemUs': 0, 'valueNs': '1123456000'}
new = {'sequence': 0, 'clock': 'CLOCK_THREAD_CPUTIME_ID', 'pid': 642590, 'tid': 642590,
       'seconds': '1', 'nanoseconds': 123456000, 'valueNs': '1123456000'}
clock = {'clock': 'CLOCK_THREAD_CPUTIME_ID', 'pid': 642590, 'tid': 642590}
compact_size = lambda value: len(json.dumps(value, separators=(',', ':')).encode())
delta = compact_size(new) - compact_size(old)
rows = []
for count in (292, 1024):
    runs = 4 + 8 + 3 * count
    endpoints = 2 * 8 * (16 + 16 + 2) * runs
    samples = 2 * 3 * runs
    extra = delta * endpoints + samples * (len(',"cpuClock":') + compact_size(clock))
    rows.append({'N': count, 'totalRunsAcrossStages': runs, 'cpuEndpoints': endpoints, 'engineSamples': samples,
                 'extraBytesOneCarrierIllustrative': extra,
                 'extraMiBRawAndJournalIllustrative': round(extra * 2 / 1024 ** 2, 2)})
footprint = {'scope': 'Serialization model from source field counts; no observed max-N run. Same numeric endpoint and six-digit PID example. Metadata overhead omitted.',
    'oldEndpointBytes': compact_size(old), 'newEndpointBytes': compact_size(new), 'perEndpointByteDelta': delta,
    'rawAndJournalCopies': 2, 'seriesCounts': rows,
    'nativeSourceBytes': sum(file.stat().st_size for file in (src / 'bench/profile/native-clock').rglob('*') if file.is_file())
                         + (src / 'bench/profile/server-thread-cpu-clock.c').stat().st_size
                         + (src / 'bench/profile/server-thread-cpu-clock.mjs').stat().st_size,
    'primaryNativeBinaryBytes': pathlib.Path('/tmp/motion-native-clock-api-smoke-green-20261002/native-clock/thread-cpu-clock.node').stat().st_size}
(root / 'footprint-model.json').write_text(json.dumps(footprint, indent=2) + '\n')
print('source', len(source_manifest['files']), 'match')
print('footprint', json.dumps(footprint))
(root / 'PROBES.json').write_text(json.dumps({'actualEndUtc': utc(), 'affinity': sorted(os.sched_getaffinity(0)),
    'probes': observations, 'allCompleted': True, 'heavy': 0, 'queued': 0,
    'priorHarnessRun': {'exitCode': 1, 'cause': 'Review-only overbroad string assertion matched shipped docs/benchmark.md. Corrected to bench/ prefix; no product finding.'}}, indent=2) + '\n')
