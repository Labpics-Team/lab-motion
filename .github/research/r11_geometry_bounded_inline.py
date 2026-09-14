from pathlib import Path
import re

p = Path('src/projection/driver.ts')
s = p.read_text()


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out

s = sub1(
    r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{.*?\n\}''',
    '''function boundPosition(x: number, a: number, b: number): number {
  return Math.max(Math.min(x, Math.max(a, b)), Math.min(a, b));
}

function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  const x = finite(box.x + (src._qx ?? 0) * q) + 0;
  const y = finite(box.y + (src._qy ?? 0) * q) + 0;
  return {
    ...box,
    x: src._qb === true ? boundPosition(x, src.first.x, src.last.x) : x,
    y: src._qb === true ? boundPosition(y, src.first.y, src.last.y) : y,
  };
}

function boundedVelocity(x: number, v: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return x < lo || x > hi || (x === lo && v < 0) || (x === hi && v > 0) ? 0 : v;
}''',
    s,
    'bounded box helper',
)

# Geometry owns final clamping per axis, so the Q basis itself remains raw. The
# visible state is collapsed only when it is sampled for a new retarget/boxAt.
s = sub1(
    r'''      const basisVisible =\n        !bounded \|\|\n        \(value > 0 && value < 1\) \|\|\n        \(value === 0 && velocity >= 0\) \|\|\n        \(value === 1 && velocity <= 0\);\n      pHat = p;\n      vHat = visibleVelocity\(value, velocity\);\n      positionBasisHat = basisVisible \? q : 0;\n      positionBasisVelocityHat = basisVisible \? qVelocity : 0;''',
    '''      pHat = p;
      vHat = visibleVelocity(value, velocity);
      positionBasisHat = q;
      positionBasisVelocityHat = qVelocity;''',
    s,
    'raw q state',
)

s = sub1(
    r'''          const oldVx = finite\(\(old\.last\.x - old\.first\.x\) \* vPrev \+ \(old\._qx \?\? 0\) \* positionBasisVelocityPrev\);\n          const oldVy = finite\(\(old\.last\.y - old\.first\.y\) \* vPrev \+ \(old\._qy \?\? 0\) \* positionBasisVelocityPrev\);''',
    '''          let oldVx = finite((old.last.x - old.first.x) * vPrev + (old._qx ?? 0) * positionBasisVelocityPrev);
          let oldVy = finite((old.last.y - old.first.y) * vPrev + (old._qy ?? 0) * positionBasisVelocityPrev);
          if (old._qb === true) {
            const rawX = finite(lerp1(old.first.x, old.last.x, pPrev) + (old._qx ?? 0) * positionBasisPrev);
            const rawY = finite(lerp1(old.first.y, old.last.y, pPrev) + (old._qy ?? 0) * positionBasisPrev);
            oldVx = boundedVelocity(rawX, oldVx, old.first.x, old.last.x);
            oldVy = boundedVelocity(rawY, oldVy, old.first.y, old.last.y);
          }''',
    s,
    'visible boundary velocity',
)

# Run-local vector flag is enough; future retargets read the hidden node state.
s = s.replace('  readonly vector: boolean;\n', '')
s = s.replace('flight = { byId, projector, reduced, vector };', 'flight = { byId, projector, reduced };')
s = s.replace('flight = { byId, projector, reduced, vector: false };', 'flight = { byId, projector, reduced };')
assert 'readonly vector:' not in s
assert 'vector: false' not in s
p.write_text(s)
