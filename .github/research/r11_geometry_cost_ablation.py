from pathlib import Path
import os
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


variant = os.environ['VARIANT']
if variant == 'baseline':
    raise SystemExit(0)

if variant == 'pickup':
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    s = sub1(
        r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{.*?\n\}''',
        '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  return mixBox(src.first, src.last, pHat);
}''',
        s,
        'pickup helper',
    )
    p.write_text(s)
    raise SystemExit(0)

if variant == 'residual':
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    s = sub1(
        r'''      // x/y carry their own physical boundary velocity while scalar channels share P\(t\)\.\n      let vector = false;\n      if \(prevById !== undefined\) \{.*?\n      \}\n\n      // Валидация дерева''',
        '''      let vector = false;

      // Валидация дерева''',
        s,
        'residual generation',
    )
    p.write_text(s)
    raise SystemExit(0)

if variant == 'geometry':
    p = Path('src/projection/geometry.ts')
    s = p.read_text()
    s = sub1(
        r'''      const vectorNode = node as DriverProjectionNodeInit;.*?\n\n      const a = liveAncestor\[i\];''',
        '''      const bx = 0;
      const by = 0;

      const a = liveAncestor[i];''',
        s,
        'geometry basis path',
    )
    p.write_text(s)
    raise SystemExit(0)

if variant == 'clamp':
    g = Path('src/projection/geometry.ts')
    s = g.read_text()
    s = sub1(
        r'''      const vectorNode = node as DriverProjectionNodeInit;\n      const bx = q === 0 \? 0 : \(vectorNode\._qx \?\? 0\);\n      const by = q === 0 \? 0 : \(vectorNode\._qy \?\? 0\);\n      if \(vectorNode\._qb === true\) \{.*?\n      \} else \{\n        if \(bx !== 0\) v\.x = finite\(v\.x \+ bx \* q\) \+ 0;\n        if \(by !== 0\) v\.y = finite\(v\.y \+ by \* q\) \+ 0;\n      \}''',
        '''      const vectorNode = node as DriverProjectionNodeInit;
      const bx = q === 0 ? 0 : (vectorNode._qx ?? 0);
      const by = q === 0 ? 0 : (vectorNode._qy ?? 0);
      if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
      if (by !== 0) v.y = finite(v.y + by * q) + 0;''',
        s,
        'geometry clamp branch',
    )
    s = s.replace('  _qb?: true;\n', '')
    g.write_text(s)

    d = Path('src/projection/driver.ts')
    s = d.read_text()
    s = sub1(
        r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{.*?\n\}''',
        '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  if (q !== 0) {
    const out = box as { x: number; y: number };
    const x = src._qx ?? 0;
    const y = src._qy ?? 0;
    if (x !== 0) out.x = finite(box.x + x * q) + 0;
    if (y !== 0) out.y = finite(box.y + y * q) + 0;
  }
  return box;
}''',
        s,
        'pickup clamp branch',
    )
    s = sub1(
        r'''          const oldX = old\._qx \?\? 0;.*?          let x = finite\(oldVx - rx \* v0\) \+ 0;\n          let y = finite\(oldVy - ry \* v0\) \+ 0;\n          if \(bounded\) \{\n            x = rx === 0 \? 0 : finite\(x / rx\) \+ 0;\n            y = ry === 0 \? 0 : finite\(y / ry\) \+ 0;\n          \}''',
        '''          const oldX = old._qx ?? 0;
          const oldY = old._qy ?? 0;
          const oldRx = old.last.x - old.first.x;
          const oldRy = old.last.y - old.first.y;
          const oldVx = finite(oldRx * vPrev + oldX * positionBasisVelocityPrev);
          const oldVy = finite(oldRy * vPrev + oldY * positionBasisVelocityPrev);
          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          const x = finite(oldVx - rx * v0) + 0;
          const y = finite(oldVy - ry * v0) + 0;''',
        s,
        'driver clamp velocity',
    )
    s = s.replace('            if (bounded) node._qb = true;\n', '')
    s = s.replace('  _qb?: true;\n', '')
    d.write_text(s)
    raise SystemExit(0)

raise AssertionError(f'unknown variant: {variant}')
