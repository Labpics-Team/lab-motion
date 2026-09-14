from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


g = Path('src/projection/geometry.ts')
s = g.read_text()
needle = '''export function clamp01(x: number): number {
  const f = Number.isNaN(x) ? 0 : x;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
'''
assert s.count(needle) == 1
s = s.replace(
    needle,
    needle
    + '''
/** Driver-private page-position carry shared by analytic pickup and tree projection. @internal */
export function carryPositionAxis(
  base: number,
  first: number,
  last: number,
  p: number,
  q: number,
  correction: number,
  bounded: boolean,
): number {
  if (q === 0 || correction === 0) return base;
  return bounded
    ? lerp1(first, last, clamp01(p + correction * q))
    : finite(base + correction * q) + 0;
}
''',
)
s = sub1(
    r'''      const vectorNode = node as DriverProjectionNodeInit;\n      const bx = q === 0 \? 0 : \(vectorNode\._qx \?\? 0\);\n      const by = q === 0 \? 0 : \(vectorNode\._qy \?\? 0\);\n      if \(vectorNode\._qb === true\) \{\n        if \(bx !== 0\) v\.x = lerp1\(node\.first\.x, node\.last\.x, clamp01\(t \+ bx \* q\)\);\n        if \(by !== 0\) v\.y = lerp1\(node\.first\.y, node\.last\.y, clamp01\(t \+ by \* q\)\);\n      \} else \{\n        if \(bx !== 0\) v\.x = finite\(v\.x \+ bx \* q\) \+ 0;\n        if \(by !== 0\) v\.y = finite\(v\.y \+ by \* q\) \+ 0;\n      \}''',
    '''      const vectorNode = node as DriverProjectionNodeInit;
      const bx = q === 0 ? 0 : (vectorNode._qx ?? 0);
      const by = q === 0 ? 0 : (vectorNode._qy ?? 0);
      const qb = vectorNode._qb === true;
      v.x = carryPositionAxis(v.x, node.first.x, node.last.x, t, q, bx, qb);
      v.y = carryPositionAxis(v.y, node.first.y, node.last.y, t, q, by, qb);''',
    s,
    'geometry shared evaluator',
)
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
import_anchor = '''import {
  clamp01,
'''
assert s.count(import_anchor) == 1
s = s.replace(import_anchor, '''import {
  carryPositionAxis,
  clamp01,
''')
s = sub1(
    r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{.*?\n\}''',
    '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  const out = box as { x: number; y: number };
  const bounded = src._qb === true;
  out.x = carryPositionAxis(box.x, src.first.x, src.last.x, pHat, q, src._qx ?? 0, bounded);
  out.y = carryPositionAxis(box.y, src.first.y, src.last.y, pHat, q, src._qy ?? 0, bounded);
  return box;
}''',
    s,
    'driver shared evaluator',
)
d.write_text(s)
