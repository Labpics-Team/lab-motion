"""Проверяет сохранённые данные; не выдаёт их за новый benchmark или remote CI."""
import hashlib, json, math, statistics
from pathlib import Path
root = Path(__file__).resolve().parent
for entry in json.loads((root/'MANIFEST.json').read_text()):
    data=(root/entry['path']).read_bytes()
    assert len(data)==entry['bytes'], entry['path']
    assert hashlib.sha256(data).hexdigest()==entry['sha256'], entry['path']
rows=json.loads((root/'forward-conformance.json').read_text())
assert len(rows)==26
for row in rows:
    # Legacy JSON field `guarded` is the forward candidate in this file.
    value=row['guarded']
    assert value['topology']==0 and all(math.isfinite(value[k]) and value[k]<1e-9 for k in ['maxPosition','maxVelocity','maxRendered'])
    assert row['observed']['base']==row['observed']['guarded']
control=json.loads((root/'controls.json').read_text())
assert control['reverse']['maxPosition']>1e19
assert control['forward']['maxPosition']<1e-9
assert control['sabotage']['maxPosition']>1
summaries=json.loads((root/'clean-statistics.json').read_text())
for run in ['clean-1','clean-2']:
    data=json.loads((root/f'paired-{run}.json').read_text())
    assert len(data['rows'])==24*7
    assert all(row['order']==('BAAB' if row['block']%2 else 'ABBA') for row in data['rows'])
    for result in [s for s in summaries if s['run']==run]:
        selected=[r for r in data['rows'] if r['cell']==result['cell']]
        metric=result['metric']
        ratios=[]
        for row in selected:
            a=statistics.mean(s[metric] for s in row['samples'] if s['id']=='A')
            b=statistics.mean(s[metric] for s in row['samples'] if s['id']=='B')
            assert a>0 and b>0
            ratios.append((b/a-1)*100)
        assert all(abs(a-b)<1e-9 for a,b in zip(ratios,result['pairedPercent']))
        assert abs(statistics.median(ratios)-result['medianPercent'])<1e-9
for run in [1,2]:
    data=json.loads((root/f'causal-{run}.json').read_text())
    assert len(data['rows'])==18*3
    for row in data['rows']:
        assert sorted(row['order'])==['A','F','O']
        assert len({json.dumps(s['observed'],sort_keys=True) for s in row['samples']})==1
print('PASS: hashes, 26 forward cases, reverse witness, sign sabotage, raw paired estimator recomputation and causal topology')
