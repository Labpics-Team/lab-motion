#!/usr/bin/env python3
import csv, json, math, sys
from collections import defaultdict

path = sys.argv[1]
rows = []
with open(path, newline='') as f:
    for row in csv.DictReader(f, delimiter='\t'):
        row['rep'] = int(row['rep'])
        row['count'] = int(row['count'])
        row['checksum'] = float(row['checksum'])
        rows.append(row)

cases = ['settled-single', 'all-seven', 'live-single']
errors = []
calibration = {}
product = {}

def gm(values):
    return math.exp(sum(math.log(v) for v in values) / len(values))

def pick(side, case, mode):
    return sorted(
        [r for r in rows if r['side'] == side and r['case'] == case and r['mode'] == mode],
        key=lambda r: r['rep'],
    )

floors = pick('candidate', 'settled-single', 'floor')
if len(floors) != 2:
    errors.append(f'floor rows={len(floors)} expected=2')
    floor_counts = []
else:
    floor_counts = [r['count'] for r in floors]
    floor_ratio = max(floor_counts) / min(floor_counts)
    calibration['floor'] = {'counts': floor_counts, 'max_min': floor_ratio}
    if floor_ratio > 1.01:
        errors.append(f'floor max/min {floor_ratio:.9f} > 1.01')

native_failure = []
for case in cases:
    base = pick('base', case, 'product')
    cand = pick('candidate', case, 'product')
    pos = pick('candidate', case, 'positive')
    if len(base) != 4 or len(cand) != 4 or len(pos) != 2:
        errors.append(f'{case}: rows base={len(base)} cand={len(cand)} pos={len(pos)}')
        continue
    base_counts = [r['count'] for r in base]
    cand_counts = [r['count'] for r in cand]
    pos_counts = [r['count'] for r in pos]
    base_null = max(base_counts) / min(base_counts)
    cand_null = max(cand_counts) / min(cand_counts)
    sens = gm(pos_counts) / gm(cand_counts)
    if base_null > 1.005:
        errors.append(f'{case}: base max/min {base_null:.9f} > 1.005')
    if cand_null > 1.005:
        errors.append(f'{case}: candidate max/min {cand_null:.9f} > 1.005')
    if sens < 1.01:
        errors.append(f'{case}: sensitivity {sens:.9f} < 1.01')
    if floor_counts:
        floor_max = max(floor_counts)
        for side, vals in [('base', base_counts), ('candidate', cand_counts)]:
            frac = max(floor_max / v for v in vals)
            if frac > 0.005:
                errors.append(f'{case}: floor/product {side} {frac:.9f} > 0.005')
    base_checks = {r['checksum'] for r in base}
    cand_checks = {r['checksum'] for r in cand}
    if len(base_checks) != 1 or len(cand_checks) != 1 or base_checks != cand_checks:
        errors.append(f'{case}: checksum mismatch base={sorted(base_checks)} cand={sorted(cand_checks)}')
    ratios = [cand[i]['count'] / base[i]['count'] for i in range(4)]
    ratio_gm = gm(cand_counts) / gm(base_counts)
    product[case] = {
        'base_counts': base_counts,
        'candidate_counts': cand_counts,
        'positive_counts': pos_counts,
        'base_max_min': base_null,
        'candidate_max_min': cand_null,
        'sensitivity': sens,
        'paired_ratios': ratios,
        'geomean_ratio': ratio_gm,
    }
    if not errors:
        if ratio_gm > 1.05 or any(r > 1.05 for r in ratios):
            native_failure.append(case)

if errors:
    verdict = 'BLOCKED_UNPROVEN'
elif native_failure:
    verdict = 'NO_GO_NATIVE'
else:
    verdict = 'ADMITTED_NATIVE_NONINFERIOR'

result = {
    'verdict': verdict,
    'calibration_errors': errors,
    'native_failure_cases': native_failure,
    'calibration': calibration,
    'product': product,
    'row_count': len(rows),
}
print(json.dumps(result, indent=2, sort_keys=True))
with open('result.json', 'w') as f:
    json.dump(result, f, indent=2, sort_keys=True)
    f.write('\n')

if verdict == 'BLOCKED_UNPROVEN':
    sys.exit(2)
if verdict == 'NO_GO_NATIVE':
    sys.exit(3)
