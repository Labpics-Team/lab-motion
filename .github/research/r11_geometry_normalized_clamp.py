from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


g = Path('src/projection/geometry.ts')
s = g.read_text()
s = sub1(
    r'''\n/\*\* @internal Clamp page-space axis to pickup→target envelope\. \*/\nexport function boundPositionAxis\(.*?\n\}\n\n/\*\* @internal Derivative of boundPositionAxis\. \*/\nexport function boundPositionVelocity\(.*?\n\}\n''',
    '\n',
    s,
    'remove absolute clamp helpers',
)
s = sub1(
    r'''      const vectorNode = node as DriverProjectionNodeInit;\n      const bx = q === 0 \? 0 : \(vectorNode\._qx \?\? 0\);\n      const by = q === 0 \? 0 : \(vectorNode\._qy \?\? 0\);\n      if \(bx !== 0\) v\.x = finite\(v\.x \+ bx \* q\) \+ 0;\n      if \(by !== 0\) v\.y = finite\(v\.y \+ by \* q\) \+ 0;\n      if \(q !== 0 && vectorNode\._qb === true\) \{\n      v\.x = boundPositionAxis\(v\.x, node\.first\.x, node\.last\.x\);\n      v\.y = boundPositionAxis\(v\.y, node\.first\.y, node\.last\.y\);\n    \}''',
    '''      const vectorNode = node as DriverProjectionNodeInit;
      const bx = q === 0 ? 0 : (vectorNode._qx ?? 0);
      const by = q === 0 ? 0 : (vectorNode._qy ?? 0);
      if (vectorNode._qb === true) {
        if (bx !== 0) v.x = lerp1(node.first.x, node.last.x, clamp01(t + bx * q));
        if (by !== 0) v.y = lerp1(node.first.y, node.last.y, clamp01(t + by * q));
      } else {
        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
        if (by !== 0) v.y = finite(v.y + by * q) + 0;
      }''',
    s,
    'normalized geometry clamp',
)
assert 'boundPositionAxis' not in s and 'boundPositionVelocity' not in s
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = s.replace('  boundPositionAxis,\n  boundPositionVelocity,\n', '')
s = sub1(
    r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{.*?\n    \}''',
    '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  if (q === 0) return box;
  const out = box as { x: number; y: number };
  const x = src._qx ?? 0;
  const y = src._qy ?? 0;
  if (src._qb === true) {
    if (x !== 0) out.x = lerp1(src.first.x, src.last.x, clamp01(pHat + x * q));
    if (y !== 0) out.y = lerp1(src.first.y, src.last.y, clamp01(pHat + y * q));
  } else {
    if (x !== 0) out.x = finite(box.x + x * q) + 0;
    if (y !== 0) out.y = finite(box.y + y * q) + 0;
  }
  return box;
}''',
    s,
    'normalized pickup box',
)
s = sub1(
    r'''          const oldBox = boxWithPositionBasis\(old, pPrev, positionBasisPrev\);\n        const rawVx = finite\(\(old\.last\.x - old\.first\.x\) \* vPrev \+ \(old\._qx \?\? 0\) \* positionBasisVelocityPrev\);\n        const rawVy = finite\(\(old\.last\.y - old\.first\.y\) \* vPrev \+ \(old\._qy \?\? 0\) \* positionBasisVelocityPrev\);\n        const oldVx = old\._qb === true \? boundPositionVelocity\(oldBox\.x, rawVx, old\.first\.x, old\.last\.x\) : rawVx;\n        const oldVy = old\._qb === true \? boundPositionVelocity\(oldBox\.y, rawVy, old\.first\.y, old\.last\.y\) : rawVy;\n        const x = finite\(oldVx - \(node\.last\.x - node\.first\.x\) \* v0\) \+ 0;\n          const y = finite\(oldVy - \(node\.last\.y - node\.first\.y\) \* v0\) \+ 0;\n          if \(x !== 0 \|\| y !== 0\) \{\n            if \(nodes\[i\]\.first !== undefined\) node = resolved\[i\] = \{ \.\.\.node \} as VectorProjectionNode;\n            node\._qx = x;\n            node\._qy = y;\n            if \(bounded\) node\._qb = true;''',
    '''          const oldX = old._qx ?? 0;
          const oldY = old._qy ?? 0;
          const oldRx = old.last.x - old.first.x;
          const oldRy = old.last.y - old.first.y;
          const oldVx = old._qb === true
            ? finite(oldRx * visibleVelocity(pPrev + oldX * positionBasisPrev, vPrev + oldX * positionBasisVelocityPrev))
            : finite(oldRx * vPrev + oldX * positionBasisVelocityPrev);
          const oldVy = old._qb === true
            ? finite(oldRy * visibleVelocity(pPrev + oldY * positionBasisPrev, vPrev + oldY * positionBasisVelocityPrev))
            : finite(oldRy * vPrev + oldY * positionBasisVelocityPrev);
          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          let x = finite(oldVx - rx * v0) + 0;
          let y = finite(oldVy - ry * v0) + 0;
          if (bounded) {
            x = rx === 0 ? 0 : finite(x / rx) + 0;
            y = ry === 0 ? 0 : finite(y / ry) + 0;
          }
          if (x !== 0 || y !== 0) {
            if (nodes[i].first !== undefined) node = resolved[i] = { ...node } as VectorProjectionNode;
            node._qx = x;
            node._qy = y;
            if (bounded) node._qb = true;''',
    s,
    'normalized boundary velocity',
)
assert 'boundPositionAxis' not in s and 'boundPositionVelocity' not in s
d.write_text(s)
