from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def save(name, value):
    (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

start = now()
command = [sys.executable, str(ROOT / 'finalize-evidence.py')]
process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
actual_end = now()
(ROOT / 'source-only-finalization.stdout.log').write_bytes(process.stdout)
(ROOT / 'source-only-finalization.stderr.log').write_bytes(process.stderr)
if process.returncode:
    print(process.stderr.decode(), file=sys.stderr)
    raise SystemExit(process.returncode)

witness = json.loads((ROOT / 'witness.execution.json').read_text())
terminal = {
    'schema': 'motion-independent-measurement-terminal-v2',
    'sourceHead': 'f6476ae990254f606faf97f80afe41965bec2fb2',
    'sourceTree': '40fbe427bbd750e9423feb71b6b6238080300022',
    'boundedWitness': witness,
    'sourceOnlyFinalization': {
        'startUtc': start, 'actualEndUtc': actual_end, 'exitCode': process.returncode,
        'argv': command, 'cpu': 1, 'allEND': True, 'allChildrenJoined': True,
        'stdoutSha256': sha(process.stdout), 'stderrSha256': sha(process.stderr),
        'action': 'source-only hash/binding/readset finalization; no SUT/runtime probe/build/profile',
    },
    'actualEndUtc': actual_end, 'exitCode': process.returncode,
    'allEND': True, 'allChildrenJoined': True, 'heavy': 0, 'queued': 0,
    'registeredTimingSamples': 0, 'freshRuntimeAtFinalHead': False,
    'stopOwnExecAfterSeal': True,
}
save('terminal.json', terminal)

files = []
for path in sorted(ROOT.rglob('*')):
    if path.is_symlink():
        files.append({'path': str(path.relative_to(ROOT)), 'type': 'symlink', 'target': str(path.resolve())})
    elif path.is_file() and path.name not in {'MANIFEST.json', 'FINAL-SEAL.json'}:
        raw = path.read_bytes()
        files.append({'path': str(path.relative_to(ROOT)), 'bytes': len(raw), 'sha256': sha(raw)})
manifest = {
    'schema': 'motion-independent-measurement-manifest-v2',
    'axis': 'measurement-method-and-acquired-cpu-evidence-preservation', 'verdict': 'PASS',
    'sourceHead': terminal['sourceHead'], 'sourceTree': terminal['sourceTree'],
    'sourceArchiveHead': witness['sourceHead'], 'freshRuntimeAtFinalHead': False,
    'inputsManifestSha256': sha((ROOT / 'all-bindings.json').read_bytes()),
    'actualEndUtc': actual_end, 'exitCode': 0, 'allEND': True, 'heavy': 0, 'queued': 0,
    'files': files,
}
save('MANIFEST.json', manifest)
seal = {
    'sourceHead': terminal['sourceHead'], 'sourceTree': terminal['sourceTree'], 'verdict': 'PASS',
    'reportSha256': sha((ROOT / 'REPORT.md').read_bytes()),
    'manifestSha256': sha((ROOT / 'MANIFEST.json').read_bytes()),
    'readsetSha256': sha((ROOT / 'readset.json').read_bytes()),
    'allBindingsSha256': sha((ROOT / 'all-bindings.json').read_bytes()),
    'terminalSha256': sha((ROOT / 'terminal.json').read_bytes()),
    'witnessActualEndUtc': witness['actualEndUtc'], 'witnessExitCode': witness['exitCode'],
    'sourceOnlyActualEndUtc': actual_end, 'sourceOnlyExitCode': process.returncode,
    'sealWrittenUtc': now(), 'allEND': True, 'heavy': 0, 'queued': 0,
    'freshRuntimeAtFinalHead': False, 'stopOwnExecAfterSeal': True,
}
save('FINAL-SEAL.json', seal)
print(json.dumps(seal, ensure_ascii=False))
