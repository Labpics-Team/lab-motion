"""Independent literal-byte audit. Reads existing epoch8 only; runs no SUT."""
import collections
import datetime
import hashlib
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).parent
DATA = ROOT / 'PRIMARY'
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
start = utc()
raw_bytes = (DATA / 'server-profile.json').read_bytes()
raw_text = raw_bytes.decode()
raw = json.loads(raw_text)
journal_bytes = (DATA / 'journal.ndjson').read_bytes()
lines = journal_bytes.splitlines()
journal = [json.loads(x) for x in lines]
digest = lambda x: hashlib.sha256(x).hexdigest()
raw_sha = digest(raw_bytes)
assert raw_sha == 'd098aad5475f93813cf47c096d9a1c0335e73949730903dd2cfd4190fa038975'
assert digest(journal_bytes) == '8552cce134e3778fa0516912f4f628d21de834e9b284006147c4ab128aa387cb'

# Keep original serialized number/text spelling for JSON identity digests.
dec = json.JSONDecoder()
fragments = {}
pos = 1
while pos < len(raw_text):
    while raw_text[pos].isspace(): pos += 1
    if raw_text[pos] == '}': break
    key, pos = dec.raw_decode(raw_text, pos)
    while raw_text[pos].isspace(): pos += 1
    assert raw_text[pos] == ':'
    pos += 1
    while raw_text[pos].isspace(): pos += 1
    begin = pos
    value, pos = dec.raw_decode(raw_text, pos)
    assert value == raw[key] and key not in fragments
    fragments[key] = raw_text[begin:pos].encode()
    while raw_text[pos].isspace(): pos += 1
    if raw_text[pos] == ',': pos += 1
    else: assert raw_text[pos] == '}'

assert digest(fragments['registration']) == raw['registrationDigest']
frozen_payload = b'{"registrationDigest":' + fragments['registrationDigest'] + b',"samplePlan":' + fragments['samplePlan'] + b'}'
assert digest(frozen_payload) == raw['frozenPlanDigest']
previous = '0' * 64
for index, (line, record) in enumerate(zip(lines, journal)):
    assert list(record) == ['sequenceDigest', 'type', 'value', 'digest'], index
    payload, suffix = line.rsplit(b',"digest":', 1)
    assert json.loads(suffix[:-1]) == record['digest']
    assert record['sequenceDigest'] == previous
    assert digest(payload + b'}') == record['digest'], index
    previous = record['digest']
assert journal[-1]['type'] == 'finished' and journal[-1]['value']['digest'] == raw_sha
assert journal[-1]['value']['verdict'] == raw['verdict'] == 'UNPROVEN'

scenes = [('engine', x) for x in raw['protocol']['engineScenes']] + [('browser', x) for x in raw['protocol']['browserScenes']]
scene_by_id = {scene['id']: (kind, scene) for kind, scene in scenes}
def order(run):
    base = ['left', 'right']
    seed = (raw['protocol']['seed'] + (run // 2) * 0x9e3779b9) & 0xffffffff
    state = (seed * 1664525 + 1013904223) & 0xffffffff
    j = math.floor((state / 2**32) * 2)
    base[1], base[j] = base[j], base[1]
    return base[run % 2:] + base[:run % 2]

def expected_tuple(stage, ordinal):
    run, remainder = divmod(ordinal, len(scenes) * 2)
    scene_index, role = divmod(remainder, 2)
    kind, scene = scenes[scene_index]
    participant = order(run)[role]
    return dict(stage=stage, kind=kind, scene=scene['id'], run=run, participant=participant,
                build='candidate' if stage == 'ab' and participant == 'right' else 'baseline')

counts = collections.Counter()
stage_samples = collections.Counter()
resource_count = collections.Counter()
seen = {}
frozen_index = None
failed = []
failure_union = []
stopped = False
phases = ['warmup', 'pilot', 'aa', 'positive', 'ab']
planned_runs = {'warmup': 4, 'pilot': 8, 'aa': raw['samplePlan']['runs'], 'positive': raw['samplePlan']['runs'], 'ab': raw['samplePlan']['runs']}
for index, record in enumerate(journal):
    kind, v = record['type'], record['value']
    counts[kind] += 1
    if kind in ['sample', 'failed-sample']:
        assert not stopped
        stage = v['stage']
        expected = expected_tuple(stage, stage_samples[stage])
        assert all(v.get(key) == value for key, value in expected.items()), (index, expected)
        for earlier in phases[:phases.index(stage)]:
            assert stage_samples[earlier] == planned_runs[earlier] * 10
            assert resource_count[earlier] == planned_runs[earlier] // 2
        if stage in ['aa', 'positive', 'ab']: assert frozen_index is not None and frozen_index < index
        key = (stage, v['scene'], v['run'], v['participant'])
        assert key not in seen
        if kind == 'failed-sample':
            failed.append(dict(index=index, **{k: v[k] for k in expected}, partial=v['partial'], timerEvidence=v['timerEvidence'], error=v['error']))
            stopped = True
        else:
            seen[key] = v['value']
            stage_samples[stage] += 1
    elif kind == 'resources-block':
        stage, block = v['stage'], v['block']
        assert block == resource_count[stage]
        assert stage_samples[stage] == (block + 1) * 20
        assert {k: value for k, value in v.items() if k != 'stage'} == raw[stage]['blocks'][block]
        resource_count[stage] += 1
    elif kind == 'N-frozen-before-calibration-and-AB':
        assert frozen_index is None and stage_samples['warmup'] == 40 and stage_samples['pilot'] == 80
        assert resource_count['warmup'] == 2 and resource_count['pilot'] == 4
        assert v['samplePlan'] == raw['samplePlan'] and v['digest'] == raw['frozenPlanDigest']
        frozen_index = index
    elif kind == 'failure': failure_union.append(v); stopped = True
assert failure_union == raw['failures'] and len(failure_union) == len(failed) == 1
assert failed[0]['error'] == failure_union[0]['error'] and failed[0]['stage'] == failure_union[0]['stage']
assert journal[0]['type'] == 'registration-before-any-sample' and journal[0]['value']['registration'] == raw['registration']
assert journal[1]['type'] == 'raw-controls-baseline' and journal[1]['value'] == raw['rawControls']['baseline']

stage_structure = {}
for stage in ['warmup', 'pilot', 'aa']:
    completed = collections.Counter()
    empty = []
    for row in raw[stage]['rows']:
        assert row['order'] == order(row['run'])
        assert row['kind'] == scene_by_id[row['scene']][0]
        if len(row['samples']) != 2: empty.append({k: row[k] for k in ['kind', 'scene', 'run', 'order', 'samples']})
        for role, sample in row['samples'].items():
            key = (stage, row['scene'], row['run'], role)
            assert key in seen and sample == seen[key]
            completed[row['run']] += 1
    stage_structure[stage] = {'rows': len(raw[stage]['rows']), 'samples': stage_samples[stage],
                              'fullRuns': sum(v == 10 for v in completed.values()),
                              'lastRun': max(completed), 'lastRunSamples': completed[max(completed)],
                              'pairedBlockReceipts': resource_count[stage], 'incompleteRows': empty}
assert sum(len(row['samples']) for name in ['warmup', 'pilot', 'aa'] for row in raw[name]['rows']) == len(seen)
assert not any(name in raw for name in ['positive', 'calibration', 'ab', 'comparators', 'retention'])
assert set(raw['rawControls']) == {'baseline'}
assert all(x['value']['build'] == 'baseline' for x in journal if x['type'] in ['sample', 'failed-sample'])

# Reconstruct every acquired native endpoint ourselves, without production RLE decoder.
cpu_count = 0
cpu_samples = 0
browser_samples = 0
stock_completed = 0
stock_warmup_completed = 0
previous_cpu = -1
clock = raw['registration']['engineClock']
derived = {}
metric_max_abs_error = 0.0
def sequential_sum(values):
    out = 0.0
    for x in values: out += x
    return out

for record in journal:
    if record['type'] != 'sample': continue
    v, sample = record['value'], record['value']['value']
    kind, scene = scene_by_id[v['scene']]
    assert sample['semantic'] is True and sample['workMultiplier'] == 1 and sample['repetitions'] == 8
    assert sample['denominator'] == raw['protocol']['denominator'] and len(sample['raw']) == 8
    values = collections.defaultdict(list)
    if kind == 'engine':
        cpu_samples += 1
        assert {k: sample['cpuClock'][k] for k in ['clock', 'pid', 'tid']} == {k: clock[k] for k in ['clock', 'pid', 'tid']}
        for batch in sample['raw']:
            reads = batch['raw']['clockReads']
            carrier = batch['raw']['cpuReads']
            assert set(carrier) == {'encoding', 'count', 'runs'} and carrier['encoding'] == 'native-cpu-rle-v1'
            assert carrier['count'] == len(reads) == (2 if scene.get('workload') == 'stock-c' else 16)
            reconstructed = []
            prior_meta = None
            for run in carrier['runs']:
                assert set(run) == {'from', 'count', 'clock', 'pid', 'tid', 'values'}
                assert run['from'] == len(reconstructed) and run['count'] > 0 and run['count'] == len(run['values'])
                meta = (run['clock'], run['pid'], run['tid'])
                assert meta == (clock['clock'], clock['pid'], clock['tid']) and meta != prior_meta
                for seconds, ns in run['values']:
                    assert re.fullmatch(r'0|[1-9][0-9]*', seconds) and len(seconds) <= 19 and int(seconds) <= 2**63 - 1
                    assert type(ns) is int and 0 <= ns < 10**9
                    reconstructed.append(int(seconds) * 10**9 + ns)
                prior_meta = meta
            assert len(reconstructed) == len(reads)
            for index, (actual, read) in enumerate(zip(reconstructed, reads)):
                assert read['sequence'] == index and str(actual) == read['valueNs'] and actual >= previous_cpu
                previous_cpu = actual
                cpu_count += 1
            if scene.get('workload') == 'stock-c':
                duration = reconstructed[1] - reconstructed[0]
                assert duration <= 2**53 - 1 and batch['operationNs'] == duration / 2000
                assert batch['raw']['calls'] == batch['raw']['completed'] == batch['raw']['denominator'] == 2000
                assert batch['raw']['outcomes']['count'] == 2000
                offset = 0
                for run in batch['raw']['outcomes']['runs']:
                    assert run['from'] == offset and run['count'] > 0 and run['value'] == 100 and run['frames'] == 47
                    offset += run['count']
                assert offset == 2000
                stock_completed += offset
                values['operationNs'].append(duration / 2000)
            else:
                deltas = [reconstructed[i + 1] - reconstructed[i] for i in range(0, 16, 2)]
                assert batch['operationNs'] == deltas[0] and batch['cancelDrainNs'] == deltas[-1] and batch['frameNs'] == deltas[1:-1]
                assert all(0 <= x <= 2**53 - 1 for x in deltas)
                values['operationNs'].append(deltas[0])
                values['meanFrameNs'].append(sequential_sum(deltas[1:-1]) / 6)
                values['cancelDrainNs'].append(deltas[-1])
        if scene.get('workload') == 'stock-c':
            assert len(sample['warmup']) == 2
            for batch in sample['warmup']:
                assert batch['operationNs'] is None and batch['raw']['cpuReads'] == [] and batch['raw']['clockReads'] == []
                assert batch['raw']['calls'] == batch['raw']['completed'] == 2000 and batch['raw']['outcomes']['count'] == 2000
                stock_warmup_completed += 2000
    else:
        browser_samples += 1
        assert sample['clockModelDigest'] == '04d863513d53b248b1be3e0905240f3bd6f4d06124582ce3093c2cbfe5320852'
        for batch in sample['raw']:
            assert batch['calls'] == batch['ownersStarted'] == batch['ownersCancelled'] == 32
            for metric, name in [('startMs', 'startClock'), ('cancelMs', 'cancelClock')]:
                value = (batch[name]['endMs'] - batch[name]['beginMs']) / 32
                assert value == batch[metric]
                values[metric].append(value)
    point = {}
    for metric, points in values.items():
        value = sequential_sum(points) / 8
        error = abs(value - sample[metric]); metric_max_abs_error = max(metric_max_abs_error, error)
        assert value == sample[metric] and value > 0
        point[metric] = value
    derived[(v['stage'], v['scene'], v['run'], v['participant'])] = point

# Plan from independently reconstructed eight-run, four-block baseline pilot.
cells = []
for kind, scene in scenes:
    metrics = scene.get('metrics', raw['protocol']['metrics'][kind])
    for metric in metrics:
        left = [derived[('pilot', scene['id'], run, 'left')][metric] for run in range(8)]
        right = [derived[('pilot', scene['id'], run, 'right')][metric] for run in range(8)]
        contrasts = [(math.log(left[2 * i]) - math.log(right[2 * i]) + math.log(left[2 * i + 1]) - math.log(right[2 * i + 1])) / 2 for i in range(4)]
        mean = sequential_sum(contrasts) / 4
        variance = sequential_sum([(x - mean)**2 for x in contrasts]) / 3
        sd = math.sqrt(variance)
        required = 2 * math.ceil(((raw['protocol']['zFamily'] + raw['protocol']['zPower']) * sd / math.log(1 + raw['protocol']['mdeRelative']))**2)
        cells.append({'id': scene['id'] + ':' + metric, 'left': left, 'right': right, 'blockLogContrasts': contrasts, 'logContrastSd': sd, 'requiredRuns': required})
assert len(cells) == 11
max_sd_error = 0.0
for cell, recorded in zip(cells, raw['samplePlan']['cells']):
    assert cell['id'] == recorded['id'] and cell['requiredRuns'] == recorded['requiredRuns']
    max_sd_error = max(max_sd_error, abs(cell['logContrastSd'] - recorded['logContrastSd']))
    assert math.isclose(cell['logContrastSd'], recorded['logContrastSd'], rel_tol=1e-13, abs_tol=1e-15)
alpha = 1 / (11 * 2 * 2 * 2 * 20)
blocks = math.ceil(math.log(alpha) / math.log(0.95))
required = max(292, 2 * blocks, *[x['requiredRuns'] for x in cells])
runs = min(1024, math.ceil(required / 2) * 2)
feasible = required <= 1024
assert (runs, required, feasible) == (raw['samplePlan']['runs'], raw['samplePlan']['requiredRuns'], raw['samplePlan']['feasible'])
assert (alpha, blocks) == (raw['samplePlan']['tail']['alphaPerTail'], raw['samplePlan']['tail']['minimumBlocks'])

resources = []
for name in ['warmup', 'pilot', 'aa']:
    for block in raw[name]['blocks']:
        before, after = block['before'], block['after']
        assert before['affinity'] == after['affinity'] == raw['registration']['machine']['identity']['affinity'] == '0'
        assert before['cpuMax'] == after['cpuMax'] == raw['registration']['machine']['identity']['cgroupCpuMax']
        for key, value in block['delta'].items(): assert value == after['cpuStat'][key] - before['cpuStat'][key]
        resources.append({'stage': name, 'block': block['block'], 'nrThrottled': block['delta']['nr_throttled'], 'throttledUsec': block['delta']['throttled_usec'], 'before': before['at'], 'after': after['at']})

predata = json.loads((DATA / 'predata-tuple.json').read_text())
grant = json.loads((DATA / 'ROOT-QUIET-GRANT.json').read_text())
launch = json.loads((DATA / 'actual-launch.json').read_text())
execution = json.loads((DATA / 'actual-execution.json').read_text())
before = json.loads((DATA / 'OPERATOR-STOP-BEFORE-SIGNAL.json').read_text())
signal = json.loads((DATA / 'OPERATOR-SIGNAL.json').read_text())
def date(x): return datetime.datetime.fromisoformat(x.replace('Z', '+00:00'))
assert launch['sourceHead'] == before['sourceHead'] == predata['expectedHead'] == 'fe092331360837fd7f63d71a4b7f867ba849ebd4'
assert digest(fragments['protocol']) == launch['protocolDigest'] == predata['protocolDigest']
assert launch['argv'] == execution['argv'] == predata['plannedInvocation']
assert launch['predataTupleSha256'] == digest((DATA / 'predata-tuple.json').read_bytes())
assert clock['pid'] == clock['tid'] == execution['childPid'] == signal['ppid'] == before['target']['ppid']
assert signal['pid'] == before['target']['pid'] == 719896 and signal['signal'] == before['plannedSignal'] == 'SIGTERM'
assert signal['onlySignalSent'] is True and before['signalCount'] == 1
times = {'predataCreated': predata['createdAt'], 'grant': grant.get('atUtc', grant.get('grantUtc')),
         'actualStart': launch['startUtc'], 'registration': raw['registration']['registeredAt'],
         'stopBeforeSignal': before['recordedBeforeSignalUtc'], 'signal': signal['signalUtc'],
         'failure': raw['failures'][0]['at'], 'finished': raw['finishedAt'], 'actualEnd': execution['endUtc']}
# Grant field is selected explicitly below if its schema uses a different spelling.
if times['grant'] is None:
    for key in ['grantedAtUtc', 'recordedAtUtc', 'createdAt', 'at']:
        if key in grant: times['grant'] = grant[key]; break
assert times['grant'] is not None, list(grant)
ordered_times = list(times.values())
assert all(date(a) < date(b) for a, b in zip(ordered_times, ordered_times[1:])), times
assert execution['exitCode'] == 1 and launch['singleLaunch'] is True and execution['singleLaunch'] is True

result = {'schema': 'independent-epoch8-literal-readback-v1', 'actualStartUtc': start, 'actualEndUtc': utc(),
          'sourceHead': launch['sourceHead'], 'sourceTree': '285e30e36db32f2fdc9ae442327f6b3396dcf254',
          'rawBytes': len(raw_bytes), 'rawSha256': raw_sha, 'journalBytes': len(journal_bytes), 'journalSha256': digest(journal_bytes),
          'journalRecords': len(journal), 'journalTypes': dict(counts), 'journalFinalDigest': previous,
          'registrationDigest': raw['registrationDigest'], 'frozenPlanDigest': digest(frozen_payload),
          'wrongWrapperPlanOnlyDigest': digest(fragments['samplePlan']),
          'NFreezeRecordZeroBasedIndex': frozen_index, 'stages': stage_structure,
          'candidateCompletedSamples': 0, 'candidateFailedSamples': 0,
          'registeredCompletedSamples': len(seen), 'nativeCpuSamples': cpu_samples, 'nativeCpuEndpoints': cpu_count,
          'browserSamples': browser_samples, 'nativeClockPidTid': clock['pid'],
          'nativeCpuLastCounterNs': str(previous_cpu), 'sampleMetricMaxAbsError': metric_max_abs_error,
          'stockTimedUsefulCalls': stock_completed, 'stockUntimedWarmupUsefulCalls': stock_warmup_completed,
          'pilotRecomputedCells': cells, 'pilotSdMaxAbsDifferencePythonVsRecordedJs': max_sd_error,
          'independentPlan': {'runs': runs, 'requiredRuns': required, 'feasible': feasible, 'minimumBlocks': blocks, 'alphaPerTail': alpha},
          'resources': resources, 'resourceThrottledBlocks': sum(x['nrThrottled'] != 0 or x['throttledUsec'] != 0 for x in resources),
          'failedSample': failed[0], 'chronology': times,
          'disposition': 'UNPROVEN: infeasible registered N and operator-interrupted incomplete baseline-only AA',
          'canonicalRerun': False, 'SutExecutions': 0, 'heavy': 0, 'queued': 0}
(ROOT / 'independent-readback.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
with (ROOT / 'readset.ndjson').open('a') as out:
    for name, scope in [('server-profile.json', 'Full literal artifact: every complete sample, CPU RLE, clock deltas, useful stock outcomes, raw point metrics, pilot N, stages, resources and provenance'), ('journal.ndjson', 'Every one of 925 literal records: payload byte SHA/chain, complete sample identity/order, N freeze, failures, finished external raw digest')]:
        content = (DATA / name).read_bytes()
        out.write(json.dumps({'utc': utc(), 'path': str(DATA / name), 'category': 'independent-primary-readback', 'bytes': len(content), 'sha256': digest(content), 'reviewedScope': scope}, ensure_ascii=False) + '\n')
print(json.dumps({k: result[k] for k in ['actualStartUtc', 'actualEndUtc', 'journalRecords', 'registeredCompletedSamples', 'nativeCpuEndpoints', 'independentPlan', 'stages', 'resourceThrottledBlocks', 'chronology', 'sampleMetricMaxAbsError', 'pilotSdMaxAbsDifferencePythonVsRecordedJs']}, ensure_ascii=False, indent=2))
