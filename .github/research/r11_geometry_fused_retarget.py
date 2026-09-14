from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


p = Path('src/projection/driver.ts')
s = p.read_text()
s = sub1(
    r'''      // C¹: v0' по доминантному каналу ВСЕХ продолжающихся узлов \(новые не участвуют —\n      // их px/s не определены\)\. Паттерн доминантной проекции \+ normalizeV0\.\n      let v0 = 0;\n      if \(prevById !== undefined && vPrev !== 0\) \{.*?\n      \}\n\n      // x/y carry their own physical boundary velocity while scalar channels share P\(t\)\.\n      let vector = false;\n      if \(prevById !== undefined\) \{.*?\n      \}\n''',
    '''      // One continuation scan owns both scalar dominant velocity and x/y physical boundary velocity.
      let v0 = 0;
      let vector = false;
      if (prevById !== undefined) {
        let bestAbs = 0;
        let bestR = 0;
        let bestRp = 0;
        const consider = (rOld: number, rNew: number): void => {
          const a = Math.abs(rNew);
          if (a > bestAbs) {
            bestAbs = a;
            bestR = rOld;
            bestRp = rNew;
          }
        };
        for (let i = 0; i < resolved.length; i++) {
          let node = resolved[i] as VectorProjectionNode;
          const old = prevById.get(node.id);
          if (old === undefined) continue;
          const oldRx = old.last.x - old.first.x;
          const oldRy = old.last.y - old.first.y;
          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          consider(oldRx, rx);
          consider(oldRy, ry);
          consider(old.last.width - old.first.width, node.last.width - node.first.width);
          consider(old.last.height - old.first.height, node.last.height - node.first.height);
          if (old.radii !== undefined && node.radii !== undefined) {
            for (let c = 0; c < 4; c++) {
              consider(old.radii.last[c].x - old.radii.first[c].x, node.radii.last[c].x - node.radii.first[c].x);
              consider(old.radii.last[c].y - old.radii.first[c].y, node.radii.last[c].y - node.radii.first[c].y);
            }
          }
          if (old.opacity !== undefined && node.opacity !== undefined) {
            consider(old.opacity.to - old.opacity.from, node.opacity.to - node.opacity.from);
          }

          const oldX = old._qx ?? 0;
          const oldY = old._qy ?? 0;
          const oldVx = old._qb === true
            ? finite(oldRx * visibleVelocity(pPrev + oldX * positionBasisPrev, vPrev + oldX * positionBasisVelocityPrev))
            : finite(oldRx * vPrev + oldX * positionBasisVelocityPrev);
          const oldVy = old._qb === true
            ? finite(oldRy * visibleVelocity(pPrev + oldY * positionBasisPrev, vPrev + oldY * positionBasisVelocityPrev))
            : finite(oldRy * vPrev + oldY * positionBasisVelocityPrev);
          if (nodes[i].first !== undefined) node = resolved[i] = { ...node } as VectorProjectionNode;
          // Temporary physical velocities; finalized into residual coefficients after v0 is known.
          node._qx = oldVx;
          node._qy = oldVy;
        }
        if (bestAbs > RANGE_EPSILON) {
          v0 = clampMagnitude(finite((vPrev * bestR) / bestRp), V0_CAP);
        }
        for (const raw of resolved) {
          const node = raw as VectorProjectionNode;
          if (node._qx === undefined) continue;
          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          let x = finite(node._qx - rx * v0) + 0;
          let y = finite((node._qy ?? 0) - ry * v0) + 0;
          if (bounded) {
            x = rx === 0 ? 0 : finite(x / rx) + 0;
            y = ry === 0 ? 0 : finite(y / ry) + 0;
            node._qb = true;
          }
          node._qx = x;
          node._qy = y;
          if (x !== 0 || y !== 0) vector = true;
        }
      }
''',
    s,
    'fuse scalar and vector continuation scans',
)
p.write_text(s)
