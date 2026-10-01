import datetime
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import tarfile
import time

OUT = Path(__file__).resolve().parent
OUT.mkdir(parents=True, exist_ok=True)
BASE = Path('/tmp/motion-server-baseline-0b6f537e')
FINAL = Path('/workspace/lab-motion')
SHIM = '/tmp/motion-server-toolchain-20261001/bin'
env = dict(os.environ, PATH=SHIM + ':' + os.environ['PATH'])

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(content):
    return hashlib.sha256(content).hexdigest()

def run(cwd, args):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()

def file_record(path):
    data = Path(path).read_bytes()
    return {'path': str(path), 'bytes': len(data), 'sha256': sha(data)}

def dist(root):
    return {p.relative_to(root).as_posix(): sha(p.read_bytes())
            for p in sorted((root / 'dist').rglob('*')) if p.is_file()}

def host():
    cgroup = {}
    for name in ['cpu.max', 'cpu.stat', 'cpuset.cpus.effective', 'memory.current', 'memory.max']:
        p = Path('/sys/fs/cgroup') / name
        if p.exists():
            cgroup[name] = p.read_text()
    return {'at': now(), 'uname': list(os.uname()), 'affinity': sorted(os.sched_getaffinity(0)),
            'loadavg': list(os.getloadavg()), 'cgroup': cgroup,
            'procStat': Path('/proc/stat').read_text(),
            'node': run(FINAL, ['node', '--version']),
            'pnpm': run(FINAL, ['pnpm', '--version']),
            'nodePath': shutil.which('node', path=env['PATH']),
            'pnpmPath': shutil.which('pnpm', path=env['PATH'])}

def save(name, body):
    (OUT / name).write_text(json.dumps(body, ensure_ascii=False, indent=2) + '\n')

def tar_dist(path):
    with tarfile.open(path, 'r:gz') as tar:
        return {m.name.removeprefix('package/'): sha(tar.extractfile(m).read())
                for m in tar.getmembers() if m.isfile() and m.name.startswith('package/dist/')}

script_base = file_record(BASE / 'scripts/bench.mjs')
script_final = file_record(FINAL / 'scripts/bench.mjs')
if script_base['sha256'] != script_final['sha256']:
    raise RuntimeError('Stock benchmark script changed between baseline and final')
preflight = {'startedAt': now(), 'host': host(), 'stockScript': [script_base, script_final],
             'scope': 'Полный неизменённый scripts/bench.mjs, справочные wall-clock числа. Семь медианных сэмплов не являются независимой NI/CI приёмкой.'}
save('preflight.json', preflight)
print('DEFAULT COST HEAVY START ' + preflight['startedAt'], flush=True)
subjects = [
    ('baseline', BASE, '0b6f537e148b7dadadfb9e3ce7c446d014975958',
     [('/tmp/motion-server-baseline-prepared-20261001-independent/baseline.tgz',
       '3787bfcc0b9b4302d826984cefc29a0a5ff7142d60a52d721c8d2f1397125470')]),
    ('final', FINAL, '8fb55ca0a116e5381a43351ab28834d17a4a9299',
     [('/workspace/lab-motion/scratchpad/runtime-upstream-final-cut-20261001T124549Z/actual-package.tgz',
       '46c9067832760159d35ccd2166b28e6486a57602b1e96d6d23e1c4c06804a402'),
      ('/workspace/lab-motion/scratchpad/runtime-upstream-final-cut-20261001T124549Z/primary/current-browser-actual-package/labpics-motion-0.3.0.tgz',
       '364f9ff8b505191965040eb17059a034e2cb39be5dd0b1468855ca7e9c61c524')]),
]
results = []
for label, root, revision, archives in subjects:
    head_before = run(root, ['git', 'rev-parse', 'HEAD'])
    status_before = run(root, ['git', 'status', '--porcelain=v1', '--untracked-files=all'])
    if head_before != revision or status_before:
        raise RuntimeError(f'{label}: checkout identity/cleanliness mismatch')
    before = dist(root)
    before_host = host()
    child_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = now()
    begin = time.perf_counter_ns()
    with (OUT / (label + '.stdout.log')).open('wb') as log:
        cp = subprocess.run(['node', 'scripts/bench.mjs'], cwd=root, env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    elapsed = time.perf_counter_ns() - begin
    ended = now()
    child_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    (OUT / (label + '.exit')).write_text(str(cp.returncode) + '\n')
    after = dist(root)
    archive_bindings = []
    for archive, expected in archives:
        actual = file_record(archive)
        packed = tar_dist(archive)
        mismatch = [p for p in sorted(set(after) | set(packed)) if after.get(p) != packed.get(p)]
        archive_bindings.append({'actualArchive': actual, 'expectedSha256': expected,
                                 'archiveIdentityMatches': actual['sha256'] == expected,
                                 'distMembers': len(packed), 'mismatches': mismatch})
    result = {'label': label, 'root': str(root), 'headBefore': head_before,
              'headAfter': run(root, ['git', 'rev-parse', 'HEAD']),
              'statusBefore': status_before,
              'statusAfter': run(root, ['git', 'status', '--porcelain=v1', '--untracked-files=all']),
              'command': ['node', 'scripts/bench.mjs'], 'startedAt': started, 'endedAt': ended,
              'exitCode': cp.returncode, 'wallNs': elapsed,
              'subtreeUserCpuSeconds': child_after.ru_utime - child_before.ru_utime,
              'subtreeSystemCpuSeconds': child_after.ru_stime - child_before.ru_stime,
              'hostBefore': before_host, 'hostAfter': host(),
              'distBefore': before, 'distAfter': after,
              'distBeforeAfterMatches': before == after,
              'packedDistBindings': archive_bindings,
              'stdout': file_record(OUT / (label + '.stdout.log'))}
    save(label + '.execution.json', result)
    results.append(result)
    print(label + ' END ' + ended + ' exit=' + str(cp.returncode), flush=True)
    if cp.returncode != 0 or result['headAfter'] != revision or result['statusAfter']:
        raise RuntimeError(f'{label}: stock benchmark or immutable source failed')
    if not before == after or any(not b['archiveIdentityMatches'] or b['mismatches'] for b in archive_bindings):
        raise RuntimeError(f'{label}: rebuilt measured dist differs from frozen actual package')
save('receipt.json', {'endedAt': now(), 'results': results,
                     'registeredPerformanceSamples': 0, 'gateInference': False})
print('DEFAULT COST HEAVY END ' + now(), flush=True)
