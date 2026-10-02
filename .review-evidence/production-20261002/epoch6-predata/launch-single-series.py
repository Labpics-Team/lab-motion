from pathlib import Path
import subprocess, os, json, datetime, hashlib

predata = Path('/tmp/motion-server-predata-185f02c2-7016c19a-20261001-epoch6')
output = Path('/tmp/motion-server-series-185f02c2-7016c19a-20261001-epoch6')
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
          'sourceHead': '185f02c2a85972a531627e14b7e0207e27855f95',
          'protocolDigest': '7016c19aa7a763fee68687327ef489abb119acd2a43d397b8485ca56e4cea15f',
          'clockModelDigest': '7e45adab88a2c97af4e9074543318ae115e42b5c9669c4746b6e149d42bfbc4f',
          'predataTupleSha256': 'e9687480c8ce7d2028a55275e84a77f9ce195cdbae783170573bf63035c52f31',
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
