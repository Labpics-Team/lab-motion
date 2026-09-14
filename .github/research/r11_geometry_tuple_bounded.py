from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


g = Path('src/projection/geometry.ts')
s = g.read_text()
s = sub1(
    r'''interface DriverProjectionNodeInit extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}''',
    '''interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _q?: readonly [number, number];
}''',
    s,
    'geometry tuple type',
)
s = s.replace(
    'const at = (p: number, positionBasisValue = 0): readonly ProjectionFrame[] => {',
    'const at = (p: number, positionBasisValue = 0, bounded = false): readonly ProjectionFrame[] => {',
)
s = sub1(
    r'''      const vectorNode = node as DriverProjectionNodeInit;\n      const bx = q === 0 \? 0 : \(vectorNode\._qx \?\? 0\);\n      const by = q === 0 \? 0 : \(vectorNode\._qy \?\? 0\);\n      if \(bx !== 0\) v\.x = finite\(v\.x \+ bx \* q\) \+ 0;\n      if \(by !== 0\) v\.y = finite\(v\.y \+ by \* q\) \+ 0;\n      if \(q !== 0 && vectorNode\._qb === true\) \{\n      v\.x = boundPositionAxis\(v\.x, node\.first\.x, node\.last\.x\);\n      v\.y = boundPositionAxis\(v\.y, node\.first\.y, node\.last\.y\);\n    \}''',
    '''      const u = q === 0 ? undefined : (node as DriverProjectionNodeInit)._q;
      const bx = u?.[0] ?? 0;
      const by = u?.[1] ?? 0;
      if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
      if (by !== 0) v.y = finite(v.y + by * q) + 0;
      if (q !== 0 && bounded) {
        v.x = boundPositionAxis(v.x, node.first.x, node.last.x);
        v.y = boundPositionAxis(v.y, node.first.y, node.last.y);
      }''',
    s,
    'geometry tuple use',
)
assert '._qx' not in s and '._qy' not in s and '._qb' not in s
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = sub1(
    r'''interface VectorProjectionNode extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}''',
    '''interface VectorProjectionNode extends ProjectionNodeInit {
  _q?: readonly [number, number];
}''',
    s,
    'driver tuple type',
)
s = sub1(
    r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{.*?\n    \}''',
    '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number, bounded = false): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  const u = q === 0 ? undefined : src._q;
  if (u !== undefined) {
    const out = box as { x: number; y: number };
    out.x = finite(box.x + u[0] * q) + 0;
    out.y = finite(box.y + u[1] * q) + 0;
    if (bounded) {
      out.x = boundPositionAxis(box.x, src.first.x, src.last.x);
      out.y = boundPositionAxis(box.y, src.first.y, src.last.y);
    }
  }
  return box;
}''',
    s,
    'driver tuple box',
)
s = s.replace(
    'first: boxWithPositionBasis(src, pHat, positionBasisValue),',
    'first: boxWithPositionBasis(src, pHat, positionBasisValue, bounded),',
)
s = s.replace(
    "onFrame?.((projector.at as (p: number, q?: number) => readonly ProjectionFrame[])(p, positionBasisValue));",
    "onFrame?.((projector.at as (p: number, q?: number, bounded?: boolean) => readonly ProjectionFrame[])(p, positionBasisValue, bounded));",
)
s = s.replace('(old._qx ?? 0)', '(old._q?.[0] ?? 0)').replace('(old._qy ?? 0)', '(old._q?.[1] ?? 0)')
s = s.replace(
    'const oldBox = boxWithPositionBasis(old, pPrev, positionBasisPrev);',
    'const oldBox = boxWithPositionBasis(old, pPrev, positionBasisPrev, bounded);',
)
s = s.replace(
    'const oldVx = old._qb === true ? boundPositionVelocity(oldBox.x, rawVx, old.first.x, old.last.x) : rawVx;',
    'const oldVx = bounded ? boundPositionVelocity(oldBox.x, rawVx, old.first.x, old.last.x) : rawVx;',
)
s = s.replace(
    'const oldVy = old._qb === true ? boundPositionVelocity(oldBox.y, rawVy, old.first.y, old.last.y) : rawVy;',
    'const oldVy = bounded ? boundPositionVelocity(oldBox.y, rawVy, old.first.y, old.last.y) : rawVy;',
)
s = sub1(
    r'''            node\._qx = x;\n            node\._qy = y;\n            if \(bounded\) node\._qb = true;''',
    '            node._q = [x, y];',
    s,
    'tuple assign',
)
assert '._qx' not in s and '._qy' not in s and '._qb' not in s
d.write_text(s)
