from pathlib import Path
import subprocess, os, json, datetime, hashlib

predata = Path('/tmp/motion-server-predata-fe092331-ce535cf6-20261002-epoch8')
output = Path('/tmp/motion-server-series-fe092331-ce535cf6-20261002-epoch8')
node = '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
argv = ['taskset', '-c', '0', node, 'bench/profile/server-profile-runner.mjs',
        '--baseline', '/tmp/motion-server-baseline-0b6f537e', '--candidate', '/workspace/lab-motion',
        '--browser', 'chromium', '--out', str(output)]
if output.exists():
    raise SystemExit('single registered output already exists; no automatic replay')
if (predata / 'actual-launch.json').exists():
    raise SystemExit('launch already recorded; no automatic replay')
env = dict(os.environ)
env['PATH'] = '/tmp/motion-server-toolchain-20261001/bin:' + str(Path(node).parent) + ':' + env['PATH']
env['CI'] = 'true'
env.pop('NODE_PATH', None)
env.pop('NODE_OPTIONS', None)
start = datetime.datetime.now(datetime.timezone.utc).isoformat()
launch = {'startUtc': start, 'argv': argv, 'cwd': '/workspace/lab-motion',
          'sourceHead': 'fe092331360837fd7f63d71a4b7f867ba849ebd4',
          'protocolDigest': 'ce535cf6d6f0b0f140d44403627b63d936ef2461883a52680e7bbcad3ee49e5a',
          'clockModelDigest': '04d863513d53b248b1be3e0905240f3bd6f4d06124582ce3093c2cbfe5320852',
          'predataTupleSha256': '5bcaa87d3349231591f4c8718e44e41c851f50d17bd3d52ae1c32d4eaca77ec5',
          'environment': {key: env.get(key) for key in ['PATH', 'CI', 'NODE_PATH', 'NODE_OPTIONS']},
          'singleLaunch': True, 'outputAbsentBeforeLaunch': True}
with (predata / 'actual-launch.json').open('x') as file:
    file.write(json.dumps(launch, ensure_ascii=False, indent=2) + '\n')
print('ACTUAL SERIES START ' + start, flush=True)
with (predata / 'actual.stdout.log').open('x') as stdout, (predata / 'actual.stderr.log').open('x') as stderr:
    child = subprocess.Popen(argv, cwd='/workspace/lab-motion', env=env, stdout=stdout, stderr=stderr)
    (predata / 'actual-child-pid.txt').write_text(str(child.pid) + '\n')
    code = child.wait()
end = datetime.datetime.now(datetime.timezone.utc).isoformat()
receipt = {'startUtc': start, 'endUtc': end, 'exitCode': code, 'childPid': child.pid,
           'argv': argv, 'output': str(output), 'singleLaunch': True,
           'files': {name: {'path': str(predata / name), 'bytes': (predata / name).stat().st_size,
                            'sha256': hashlib.sha256((predata / name).read_bytes()).hexdigest()}
                     for name in ['actual-launch.json', 'actual.stdout.log', 'actual.stderr.log']}}
with (predata / 'actual-execution.json').open('x') as file:
    file.write(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
print('ACTUAL SERIES END ' + end + ' exit' + str(code), flush=True)
print((predata / 'actual.stdout.log').read_text()[-6000:], flush=True)
if code:
    print((predata / 'actual.stderr.log').read_text()[-3000:], flush=True)
