from pathlib import Path
import os

p = Path('src/projection/driver.ts')
s = p.read_text()

old = '''          const oldVx = old._qb === true
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
'''
assert s.count(old) == 1

variant = os.environ['VARIANT']
if variant == 'mode_owner':
    new = '''          const oldVx = bounded
            ? finite(oldRx * visibleVelocity(pPrev + oldX * positionBasisPrev, vPrev + oldX * positionBasisVelocityPrev))
            : finite(oldRx * vPrev + oldX * positionBasisVelocityPrev);
          const oldVy = bounded
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
'''
elif variant == 'direct_ratio':
    new = '''          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          let x: number;
          let y: number;
          if (bounded) {
            const vx = visibleVelocity(pPrev + oldX * positionBasisPrev, vPrev + oldX * positionBasisVelocityPrev);
            const vy = visibleVelocity(pPrev + oldY * positionBasisPrev, vPrev + oldY * positionBasisVelocityPrev);
            x = rx === 0 ? 0 : finite(finite(oldRx * vx) / rx - v0) + 0;
            y = ry === 0 ? 0 : finite(finite(oldRy * vy) / ry - v0) + 0;
          } else {
            x = finite(oldRx * vPrev + oldX * positionBasisVelocityPrev - rx * v0) + 0;
            y = finite(oldRy * vPrev + oldY * positionBasisVelocityPrev - ry * v0) + 0;
          }
'''
elif variant == 'direct_inline':
    new = '''          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          let x = bounded
            ? rx === 0 ? 0 : finite(finite(oldRx * visibleVelocity(pPrev + oldX * positionBasisPrev, vPrev + oldX * positionBasisVelocityPrev)) / rx - v0) + 0
            : finite(oldRx * vPrev + oldX * positionBasisVelocityPrev - rx * v0) + 0;
          let y = bounded
            ? ry === 0 ? 0 : finite(finite(oldRy * visibleVelocity(pPrev + oldY * positionBasisPrev, vPrev + oldY * positionBasisVelocityPrev)) / ry - v0) + 0
            : finite(oldRy * vPrev + oldY * positionBasisVelocityPrev - ry * v0) + 0;
'''
else:
    raise AssertionError(variant)

p.write_text(s.replace(old, new, 1))
