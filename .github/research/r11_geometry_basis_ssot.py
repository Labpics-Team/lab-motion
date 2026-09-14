from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


p = Path('src/projection/driver.ts')
s = p.read_text()

s = sub1(
    r'''  /\*\* Q\(t\), коэффициент физической начальной скорости для x/y\. \*/\n  let positionBasisHat = 0;\n  /\*\* Q'\(t\); нужен для повторного retarget без потери уже перенесённой скорости\. \*/\n  let positionBasisVelocityHat = 0;\n''',
    '',
    s,
    'remove mirrored basis state',
)

# Exception/cancel paths preserve visible Q but discard carried Q' exactly as before.
s = s.replace('positionBasisVelocityHat = 0;', 'springBasis._velocityV0 = 0;')

s = sub1(
    r'''    pHat = 1;\n    vHat = 0;\n    positionBasisHat = 0;\n    springBasis\._velocityV0 = 0;\n    progress = 1;''',
    '''    pHat = 1;
    vHat = 0;
    springBasis._valueV0 = springBasis._velocityV0 = 0;
    progress = 1;''',
    s,
    'settle basis reset',
)

s = sub1(
    r'''    pHat = 0;\n    vHat = visibleVelocity\(0, v0\);\n    positionBasisHat = 0;\n    positionBasisVelocityHat = vector \? 1 : 0;\n    progress = 0;''',
    '''    pHat = 0;
    vHat = visibleVelocity(0, v0);
    springBasis._valueV0 = 0;
    springBasis._velocityV0 = vector ? 1 : 0;
    progress = 0;''',
    s,
    'start basis state',
)

s = sub1(
    r'''      pHat = p;\n      vHat = visibleVelocity\(value, velocity\);\n      positionBasisHat = basisVisible \? q : 0;\n      positionBasisVelocityHat = basisVisible \? qVelocity : 0;\n      progress = clamp01\(p\);\n      emit\(projector, p, positionBasisHat\);''',
    '''      pHat = p;
      vHat = visibleVelocity(value, velocity);
      springBasis._valueV0 = basisVisible ? q : 0;
      springBasis._velocityV0 = basisVisible ? qVelocity : 0;
      progress = clamp01(p);
      emit(projector, p, springBasis._valueV0);''',
    s,
    'tick basis ownership',
)

s = sub1(
    r'''      const positionBasisPrev = positionBasisHat;\n      const positionBasisVelocityPrev = positionBasisVelocityHat;''',
    '''      const positionBasisPrev = springBasis._valueV0;
      const positionBasisVelocityPrev = springBasis._velocityV0;''',
    s,
    'pickup basis read',
)

s = sub1(
    r'''      pHat = pp;\n      vHat = 0;\n      positionBasisHat = 0;\n      springBasis\._velocityV0 = 0;\n      progress = clamp01\(pp\);''',
    '''      pHat = pp;
      vHat = 0;
      springBasis._valueV0 = springBasis._velocityV0 = 0;
      progress = clamp01(pp);''',
    s,
    'seek basis reset',
)

s = s.replace('rebaseNode(n.id, n, n, p0, positionBasisHat)', 'rebaseNode(n.id, n, n, p0, springBasis._valueV0)')
s = s.replace('boxWithPositionBasis(node, pHat, positionBasisHat)', 'boxWithPositionBasis(node, pHat, springBasis._valueV0)')

assert 'positionBasisHat' not in s
assert 'positionBasisVelocityHat' not in s
p.write_text(s)
