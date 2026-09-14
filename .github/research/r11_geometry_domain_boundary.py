from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out

# The canonical motion contract does not claim rendered-pixel C1 under clamping.
# Keep clamp:true on the pre-existing scalar path and admit vector carry only for
# the supported unbounded 2D domain.
g = Path('src/projection/geometry.ts')
s = g.read_text()
s = sub1(
    r'''export function carryPositionAxis\(\n  base: number,\n  first: number,\n  last: number,\n  p: number,\n  q: number,\n  correction: number,\n  bounded: boolean,\n\): number \{\n  if \(q === 0 \|\| correction === 0\) return base;\n  return bounded\n    \? lerp1\(first, last, clamp01\(p \+ correction \* q\)\)\n    : finite\(base \+ correction \* q\) \+ 0;\n\}''',
    '''export function carryPositionAxis(base: number, q: number, correction: number): number {
  return q === 0 || correction === 0 ? base : finite(base + correction * q) + 0;
}''',
    s,
    'unbounded shared position evaluator',
)
s = sub1(
    r'''interface DriverProjectionNodeInit extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}''',
    '''interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}''',
    s,
    'geometry node scope',
)
s = sub1(
    r'''      const vectorNode = node as DriverProjectionNodeInit;\n      const bx = q === 0 \? 0 : \(vectorNode\._qx \?\? 0\);\n      const by = q === 0 \? 0 : \(vectorNode\._qy \?\? 0\);\n      const qb = vectorNode\._qb === true;\n      v\.x = carryPositionAxis\(v\.x, node\.first\.x, node\.last\.x, t, q, bx, qb\);\n      v\.y = carryPositionAxis\(v\.y, node\.first\.y, node\.last\.y, t, q, by, qb\);''',
    '''      const vectorNode = node as DriverProjectionNodeInit;
      const bx = q === 0 ? 0 : (vectorNode._qx ?? 0);
      const by = q === 0 ? 0 : (vectorNode._qy ?? 0);
      v.x = carryPositionAxis(v.x, q, bx);
      v.y = carryPositionAxis(v.y, q, by);''',
    s,
    'geometry unbounded use',
)
assert '._qb' not in s
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = sub1(
    r'''interface VectorProjectionNode extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}''',
    '''interface VectorProjectionNode extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
}''',
    s,
    'driver node scope',
)
s = sub1(
    r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{\n  const box = mixBox\(src\.first, src\.last, pHat\);\n  const out = box as \{ x: number; y: number \};\n  const bounded = src\._qb === true;\n  out\.x = carryPositionAxis\(box\.x, src\.first\.x, src\.last\.x, pHat, q, src\._qx \?\? 0, bounded\);\n  out\.y = carryPositionAxis\(box\.y, src\.first\.y, src\.last\.y, pHat, q, src\._qy \?\? 0, bounded\);\n  return box;\n\}''',
    '''function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  const out = box as { x: number; y: number };
  out.x = carryPositionAxis(box.x, q, src._qx ?? 0);
  out.y = carryPositionAxis(box.y, q, src._qy ?? 0);
  return box;
}''',
    s,
    'driver unbounded pickup',
)
s = sub1(
    r'''      // One continuation scan owns both scalar dominant velocity and x/y physical boundary velocity\.\n      let v0 = 0;\n      let vector = false;\n      if \(prevById !== undefined\) \{''',
    '''      // Scalar continuation remains available for every mode. Independent x/y
      // velocity is admitted only for the supported unclamped 2D domain.
      let v0 = 0;
      let vector = false;
      if (prevById !== undefined) {''',
    s,
    'continuation header',
)
# Keep scalar dominant scan for bounded mode, but suppress x/y residual storage there.
s = sub1(
    r'''          const oldX = old\._qx \?\? 0;\n          const oldY = old\._qy \?\? 0;\n          const oldVx = old\._qb === true\n            \? finite\(oldRx \* visibleVelocity\(pPrev \+ oldX \* positionBasisPrev, vPrev \+ oldX \* positionBasisVelocityPrev\)\)\n            : finite\(oldRx \* vPrev \+ oldX \* positionBasisVelocityPrev\);\n          const oldVy = old\._qb === true\n            \? finite\(oldRy \* visibleVelocity\(pPrev \+ oldY \* positionBasisPrev, vPrev \+ oldY \* positionBasisVelocityPrev\)\)\n            : finite\(oldRy \* vPrev \+ oldY \* positionBasisVelocityPrev\);\n          if \(nodes\[i\]\.first !== undefined\) node = resolved\[i\] = \{ \.\.\.node \} as VectorProjectionNode;\n          // Temporary physical velocities; finalized into residual coefficients after v0 is known\.\n          node\._qx = oldVx;\n          node\._qy = oldVy;''',
    '''          if (!bounded) {
            const oldX = old._qx ?? 0;
            const oldY = old._qy ?? 0;
            const oldVx = finite(oldRx * vPrev + oldX * positionBasisVelocityPrev);
            const oldVy = finite(oldRy * vPrev + oldY * positionBasisVelocityPrev);
            if (nodes[i].first !== undefined) node = resolved[i] = { ...node } as VectorProjectionNode;
            // Temporary physical velocities; finalized into residual coefficients after v0 is known.
            node._qx = oldVx;
            node._qy = oldVy;
          }''',
    s,
    'bounded scalar fallback capture',
)
s = sub1(
    r'''        for \(const raw of resolved\) \{\n          const node = raw as VectorProjectionNode;\n          if \(node\._qx === undefined\) continue;\n          const rx = node\.last\.x - node\.first\.x;\n          const ry = node\.last\.y - node\.first\.y;\n          let x = finite\(node\._qx - rx \* v0\) \+ 0;\n          let y = finite\(\(node\._qy \?\? 0\) - ry \* v0\) \+ 0;\n          if \(bounded\) \{\n            x = rx === 0 \? 0 : finite\(x / rx\) \+ 0;\n            y = ry === 0 \? 0 : finite\(y / ry\) \+ 0;\n            node\._qb = true;\n          \}\n          node\._qx = x;\n          node\._qy = y;\n          if \(x !== 0 \|\| y !== 0\) vector = true;\n        \}''',
    '''        if (!bounded) {
          for (const raw of resolved) {
            const node = raw as VectorProjectionNode;
            if (node._qx === undefined) continue;
            const rx = node.last.x - node.first.x;
            const ry = node.last.y - node.first.y;
            const x = finite(node._qx - rx * v0) + 0;
            const y = finite((node._qy ?? 0) - ry * v0) + 0;
            node._qx = x;
            node._qy = y;
            if (x !== 0 || y !== 0) vector = true;
          }
        }''',
    s,
    'bounded scalar fallback residual',
)
assert '._qb' not in s
d.write_text(s)
