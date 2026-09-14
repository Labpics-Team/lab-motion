from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out

# This script runs AFTER r11_geometry_inline_state.py.
g = Path('src/projection/geometry.ts')
s = g.read_text()
s = sub1(
    r'''interface DriverProjectionNodeInit extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}''',
    '''interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _q?: readonly [number, number, true?];
}''',
    s,
    'geometry tuple type',
)
s = sub1(
    r'''      const vectorNode = node as DriverProjectionNodeInit;\n      const bx = q === 0 \? 0 : \(vectorNode\._qx \?\? 0\);\n      const by = q === 0 \? 0 : \(vectorNode\._qy \?\? 0\);\n      if \(bx !== 0\) v\.x = finite\(v\.x \+ bx \* q\) \+ 0;\n      if \(by !== 0\) v\.y = finite\(v\.y \+ by \* q\) \+ 0;\n      if \(q !== 0 && vectorNode\._qb === true\) \{''',
    '''      const u = q === 0 ? undefined : (node as DriverProjectionNodeInit)._q;
      const bx = u?.[0] ?? 0;
      const by = u?.[1] ?? 0;
      if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
      if (by !== 0) v.y = finite(v.y + by * q) + 0;
      if (u?.[2] === true) {''',
    s,
    'geometry tuple use',
)
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = sub1(
    r'''interface VectorProjectionNode extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}\n\nfunction boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{\n  const box = mixBox\(src\.first, src\.last, pHat\);\n  if \(q === 0\) return box;\n  const x = src\._qx \?\? 0;\n  const y = src\._qy \?\? 0;\n  if \(x === 0 && y === 0\) return box;\n  return \{ \.\.\.box, x: finite\(box\.x \+ x \* q\) \+ 0, y: finite\(box\.y \+ y \* q\) \+ 0 \};\n\}''',
    '''interface VectorProjectionNode extends ProjectionNodeInit {
  _q?: readonly [number, number, true?];
}

function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  const u = q === 0 ? undefined : src._q;
  if (u === undefined) return box;
  (box as { x: number }).x = finite(box.x + u[0] * q) + 0;
  (box as { y: number }).y = finite(box.y + u[1] * q) + 0;
  return box;
}''',
    s,
    'driver tuple helper',
)
# Flight does not need to retain the run-local "vector" bit.
s = s.replace('  readonly vector: boolean;\n', '')
s = s.replace('flight = { byId, projector, reduced, vector };', 'flight = { byId, projector, reduced };')
s = s.replace('flight = { byId, projector, reduced, vector: false };', 'flight = { byId, projector, reduced };')

# The analytical spring basis already is the SSOT for Q/Q'. Reuse it rather
# than mirroring two extra controller fields.
s = s.replace('  let positionBasisHat = 0;\n', '')
s = s.replace('  let positionBasisVelocityHat = 0;\n', '')
s = s.replace('      positionBasisVelocityHat = 0;', '      springBasis._velocityV0 = 0;')
s = s.replace('    positionBasisHat = 0;\n    positionBasisVelocityHat = 0;', '    springBasis._valueV0 = 0;\n    springBasis._velocityV0 = 0;')
s = s.replace('    positionBasisHat = 0;\n    positionBasisVelocityHat = vector ? 1 : 0;', '    springBasis._valueV0 = 0;\n    springBasis._velocityV0 = vector ? 1 : 0;')
s = s.replace('      positionBasisHat = basisVisible ? q : 0;\n      positionBasisVelocityHat = basisVisible ? qVelocity : 0;', '      springBasis._valueV0 = basisVisible ? q : 0;\n      springBasis._velocityV0 = basisVisible ? qVelocity : 0;')
s = s.replace('      emit(projector, p, positionBasisHat);', '      emit(projector, p, springBasis._valueV0);')
s = s.replace('      const positionBasisPrev = positionBasisHat;\n      const positionBasisVelocityPrev = positionBasisVelocityHat;', '      const positionBasisPrev = springBasis._valueV0;\n      const positionBasisVelocityPrev = springBasis._velocityV0;')
s = s.replace('      positionBasisHat = 0;\n      positionBasisVelocityHat = 0;', '      springBasis._valueV0 = 0;\n      springBasis._velocityV0 = 0;')
s = s.replace('positionBasisHat,', 'springBasis._valueV0,')
s = s.replace('positionBasisHat);', 'springBasis._valueV0);')
# Fail closed on the actual mirrored controller declarations; residual names in
# comments are harmless, and any live code reference is caught by typecheck.
assert 'let positionBasisHat' not in s
assert 'let positionBasisVelocityHat' not in s

# Compact correction storage into one private tuple.
s = s.replace('(old._qx ?? 0)', '(old._q?.[0] ?? 0)')
s = s.replace('(old._qy ?? 0)', '(old._q?.[1] ?? 0)')
s = sub1(
    r'''            node\._qx = x;\n            node\._qy = y;\n            if \(bounded\) node\._qb = true;''',
    '            node._q = bounded ? [x, y, true] : [x, y];',
    s,
    'driver tuple assign',
)
assert all(x not in s for x in ['._qx', '._qy', '._qb', 'readonly vector:'])

d.write_text(s)
