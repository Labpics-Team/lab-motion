"""Пересчёт pointwise 95% bootstrap интервалов; не multiplicity-adjusted GO."""
import json
from pathlib import Path
import numpy as np
root=Path(__file__).parent
rng=np.random.default_rng(20260906)
summary=[]
for run in ('clean-1','clean-2'):
    d=json.loads((root/f'paired-{run}.json').read_text())
    for cell in d['cells']:
        rows=[r for r in d['rows'] if r['cell']==cell['name']]
        for metric in ('startMs','frameMs','totalMs'):
            a=np.array([np.mean([s[metric] for s in r['samples'] if s['id']=='A']) for r in rows])
            b=np.array([np.mean([s[metric] for s in r['samples'] if s['id']=='B']) for r in rows])
            p=(b/a-1)*100
            ci=np.quantile(np.median(rng.choice(p,(20000,len(p))),axis=1),[.025,.975])
            summary.append(dict(run=run,cell=cell['name'],metric=metric,baseMedianMs=float(np.median(a)),candidateMedianMs=float(np.median(b)),pairedPercent=p.tolist(),medianPercent=float(np.median(p)),ci95Percent=ci.tolist()))
(root/'clean-statistics-recomputed.json').write_text(json.dumps(summary,indent=2)+'\n')
print('Recomputed 42 pointwise comparisons; not a production GO')
