from pathlib import Path
import os
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


def fuse() -> None:
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    pattern = r'''      // C⁰ всех каналов: visual pickup — first' = V\(p̂\) аналитически \(ноль\n      // DOM-чтений\), radii\.first'/opacity\.from' — тем же lerp'ом на clamp01\(p̂\)\.\n      const resolved: ProjectionNodeInit\[\] = nodes\.map\(\(n\) => \{.*?\n      \}\);\n\n      // C¹: v0' по доминантному каналу ВСЕХ продолжающихся узлов \(новые не участвуют —\n      // их px/s не определены\)\. Паттерн доминантной проекции \+ normalizeV0\.\n      let v0 = 0;\n      if \(prevById !== undefined && vPrev !== 0\) \{.*?\n        if \(bestAbs > RANGE_EPSILON\) \{\n          v0 = clampMagnitude\(finite\(\(vPrev \* bestR\) / bestRp\), V0_CAP\);\n        \}\n      \}\n'''
    replacement = '''      // C⁰ pickup и C¹ dominant scan имеют один owner-pass: у продолжающегося
      // узла old уже известен в момент разрешения first, поэтому второй обход дерева не нужен.
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
      const resolved: ProjectionNodeInit[] = nodes.map((n) => {
        const old = prevById?.get(n.id);
        let node: ProjectionNodeInit;
        if (n.first === undefined) {
          if (old === undefined) throw new MotionParamError('LM078');
          node = rebaseNode(n, old, pPrev, positionBasisPrev);
        } else {
          node = n as ProjectionNodeInit;
        }
        if (old !== undefined && vPrev !== 0) {
          consider(old.last.x - old.first.x, node.last.x - node.first.x);
          consider(old.last.y - old.first.y, node.last.y - node.first.y);
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
        }
        return node;
      });
      const v0 = bestAbs > RANGE_EPSILON
        ? clampMagnitude(finite((vPrev * bestR) / bestRp), V0_CAP)
        : 0;
'''
    s = sub1(pattern, replacement, s, 'dominant fusion')
    p.write_text(s)


def fuse_scan_flag() -> None:
    fuse()
    p = Path('src/projection/driver.ts')
    s = p.read_text()
    old = '''      let bestAbs = 0;
      let bestR = 0;
      let bestRp = 0;'''
    new = '''      const scanVelocity = prevById !== undefined && vPrev !== 0;
      let bestAbs = 0;
      let bestR = 0;
      let bestRp = 0;'''
    assert s.count(old) == 1
    s = s.replace(old, new, 1)
    assert s.count('        if (old !== undefined && vPrev !== 0) {') == 1
    s = s.replace('        if (old !== undefined && vPrev !== 0) {', '        if (scanVelocity && old !== undefined) {', 1)
    p.write_text(s)


variant = os.environ['VARIANT']
if variant == 'base':
    pass
elif variant == 'fusion':
    fuse()
elif variant == 'fusion_flag':
    fuse_scan_flag()
else:
    raise AssertionError(variant)
