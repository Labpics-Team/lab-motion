from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f"{label}: {n}"
    return out


g = Path('src/projection/geometry.ts')
s = g.read_text()
s = sub1(
    r'''interface DriverProjectionNodeInit extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}''',
    '''interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _vx?: number;
  _vy?: number;
}''',
    s,
    'geometry node velocity type',
)
s = s.replace(
    'const at = (p: number, positionBasisValue = 0): readonly ProjectionFrame[] => {\n    const t = Number.isNaN(p) ? 0 : p; // санация p — паритет flipAtRaw (NaN → 0)\n    const q = finite(positionBasisValue);\n    const tc = clamp01(t);',
    '''const at = (p: number, qValue = 0, scalarV0 = 0, bounded = false): readonly ProjectionFrame[] => {
    const base = Number.isNaN(p) ? 0 : p;
    const q = finite(qValue);
    const scalar = q === 0 ? base : finite(base + finite(scalarV0) * q);
    const t = bounded ? clamp01(scalar) : scalar;
    const tc = clamp01(t);''',
)
s = sub1(
    r'''      // Linear second-order spring solution: page position = scalar path \+ u·Q\(t\)\.\n      // Q\(0\)=0 and Q'\(0\)=1, so this preserves C0 while carrying only the\n      // independent x/y boundary velocity not representable by one scalar p\.\n      const vectorNode = node as DriverProjectionNodeInit;\n      const bx = q === 0 \? 0 : \(vectorNode\._qx \?\? 0\);\n      const by = q === 0 \? 0 : \(vectorNode\._qy \?\? 0\);\n      if \(vectorNode\._qb === true\) \{\n        if \(bx !== 0\) v\.x = lerp1\(node\.first\.x, node\.last\.x, clamp01\(t \+ bx \* q\)\);\n        if \(by !== 0\) v\.y = lerp1\(node\.first\.y, node\.last\.y, clamp01\(t \+ by \* q\)\);\n      \} else \{\n        if \(bx !== 0\) v\.x = finite\(v\.x \+ bx \* q\) \+ 0;\n        if \(by !== 0\) v\.y = finite\(v\.y \+ by \* q\) \+ 0;\n      \}''',
    '''      // One zero-v0 spring basis, channel-owned initial velocities.
      const vectorNode = node as DriverProjectionNodeInit;
      const vx0 = q === 0 ? undefined : vectorNode._vx;
      const vy0 = q === 0 ? undefined : vectorNode._vy;
      if (vx0 !== undefined) {
        const px = finite(base + vx0 * q);
        v.x = lerp1(node.first.x, node.last.x, bounded ? clamp01(px) : px);
      }
      if (vy0 !== undefined) {
        const py = finite(base + vy0 * q);
        v.y = lerp1(node.first.y, node.last.y, bounded ? clamp01(py) : py);
      }''',
    s,
    'geometry channel basis',
)
s = s.replace(
    'if (anchorIsLast[i] && bx === 0 && by === 0) {',
    'if (anchorIsLast[i] && vx0 === undefined && vy0 === undefined) {',
)
assert '._qx' not in s and '._qy' not in s and '._qb' not in s
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = sub1(
    r'''interface VectorProjectionNode extends ProjectionNodeInit \{\n  _qx\?: number;\n  _qy\?: number;\n  _qb\?: true;\n\}''',
    '''interface VectorProjectionNode extends ProjectionNodeInit {
  _vx?: number;
  _vy?: number;
}''',
    s,
    'driver node velocity type',
)
s = sub1(
    r'''function boxWithPositionBasis\(src: VectorProjectionNode, pHat: number, q: number\): FlipRect \{.*?\n\}''',
    '''function boxWithChannelBasis(
  src: VectorProjectionNode,
  base: number,
  q: number,
  scalarV0: number,
  bounded: boolean,
): FlipRect {
  const scalar = q === 0 ? base : finite(base + scalarV0 * q);
  const t = bounded ? clamp01(scalar) : scalar;
  const box = mixBox(src.first, src.last, t);
  if (q !== 0) {
    const out = box as { x: number; y: number };
    if (src._vx !== undefined) {
      const px = finite(base + src._vx * q);
      out.x = lerp1(src.first.x, src.last.x, bounded ? clamp01(px) : px);
    }
    if (src._vy !== undefined) {
      const py = finite(base + src._vy * q);
      out.y = lerp1(src.first.y, src.last.y, bounded ? clamp01(py) : py);
    }
  }
  return box;
}''',
    s,
    'driver channel box',
)
s = sub1(
    r'''function rebaseNode\(\n  id: string,\n  target: Omit<ProjectionPlayNode, 'id'>,\n  src: VectorProjectionNode,\n  pHat: number,\n  positionBasisValue = 0,\n\): VectorProjectionNode \{.*?\n\}''',
    '''function rebaseNode(
  id: string,
  target: Omit<ProjectionPlayNode, 'id'>,
  src: VectorProjectionNode,
  base: number,
  q: number,
  scalarV0: number,
  bounded: boolean,
): VectorProjectionNode {
  const scalar = q === 0 ? base : finite(base + scalarV0 * q);
  const tc = clamp01(scalar);
  return {
    id,
    parent: target.parent,
    first: boxWithChannelBasis(src, base, q, scalarV0, bounded),
    last: target.last,
    anchor: target.anchor,
    radii:
      target.radii !== undefined && src.radii !== undefined
        ? { first: lerpRadii(src.radii.first, src.radii.last, tc), last: target.radii.last }
        : target.radii,
    opacity:
      target.opacity !== undefined && src.opacity !== undefined
        ? { from: lerp1(src.opacity.from, src.opacity.to, tc), to: target.opacity.to }
        : target.opacity,
  };
}''',
    s,
    'rebase channel basis',
)
s = s.replace('  readonly vector: boolean;\n', '')
s = s.replace(
    '  /** Производная видимого p последнего кадра. Покой/cancel = 0. */\n  let vHat = 0;',
    '''  /** Производная видимого p последнего кадра. Покой/cancel = 0. */
  let vHat = 0;
  /** Нормированная начальная скорость scalar-каналов текущего run. */
  let v0Hat = 0;''',
)
s = s.replace(
    "      vHat = 0;\n      springBasis._velocityV0 = 0;\n      throw error;",
    "      vHat = 0;\n      springBasis._velocity = springBasis._velocityV0 = 0;\n      throw error;",
    1,
)
s = sub1(
    r'''  /\*\* Исключение пользовательского callback не должно оставлять «играющий» зомби-run\. \*/\n  const emit = \(.*?\n  \};''',
    '''  /** Исключение пользовательского callback не должно оставлять «играющий» зомби-run. */
  const emit = (projector: Projector, base: number, q = 0, scalarV0 = 0): void => {
    try {
      onFrame?.((projector.at as (
        p: number,
        q?: number,
        scalarV0?: number,
        bounded?: boolean,
      ) => readonly ProjectionFrame[])(base, q, scalarV0, bounded));
    } catch (error) {
      generation++;
      phase = 'canceled';
      vHat = 0;
      springBasis._velocity = springBasis._velocityV0 = 0;
      clearPendingTick();
      throw error;
    }
  };''',
    s,
    'emit channel basis',
)
s = sub1(
    r'''  const settle = \(projector: Projector\): void => \{.*?\n  \};\n\n  const startRun = \(projector: Projector, v0: number, vector = false\): void => \{.*?\n  \};''',
    '''  const settle = (projector: Projector): void => {
    generation++;
    clearPendingTick();
    const gen = generation;
    phase = 'rest';
    pHat = 1;
    vHat = v0Hat = 0;
    springBasis._value = 1;
    springBasis._velocity = springBasis._valueV0 = springBasis._velocityV0 = 0;
    progress = 1;
    emit(projector, 1);
    if (gen === generation && phase === 'rest') onRest?.();
  };

  const startRun = (projector: Projector, v0: number, vector = false): void => {
    generation++;
    const gen = generation;
    phase = 'active';
    v0Hat = v0;
    pHat = 0;
    vHat = visibleVelocity(0, v0);
    springBasis._value = springBasis._velocity = springBasis._valueV0 = 0;
    springBasis._velocityV0 = 1;
    progress = 0;
    let elapsed = 0;
    let lastTs: number | undefined;
    let frames = 0;

    const schedule = (cb: (ts?: number) => void): void => {
      if (requestFrame === undefined) {
        settle(projector);
        return;
      }
      scheduleFrame(cb);
    };

    const tick = (ts?: number): void => {
      if (gen !== generation || phase !== 'active') return;
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        elapsed += lastTs === undefined ? FIXED_DT_S : Math.max(0, (ts - lastTs) / 1000);
        lastTs = ts;
      } else {
        elapsed += FIXED_DT_S;
        lastTs = undefined;
      }
      frames++;

      solveSpring(params, elapsed, 0, solved, springBasis);
      const base = finite(springBasis._value);
      const baseVelocity = finite(springBasis._velocity);
      const q = finite(springBasis._valueV0);
      const qVelocity = finite(springBasis._velocityV0);
      const value = finite(base + v0 * q);
      const velocity = finite(baseVelocity + v0 * qVelocity);
      const basisConverged = !vector || (Math.abs(q) < REST && Math.abs(qVelocity) < REST);
      const converged =
        (Math.abs(1 - value) < REST && Math.abs(velocity) < REST && basisConverged) ||
        frames >= MAX_FRAMES;
      if (converged) {
        settle(projector);
        return;
      }
      pHat = bounded ? clamp01(value) : value;
      vHat = visibleVelocity(value, velocity);
      progress = clamp01(pHat);
      emit(projector, base, q, v0);
      if (gen === generation && phase === 'active') schedule(tick);
    };

    emit(projector, 0, 0, v0);
    if (gen === generation && phase === 'active') schedule(tick);
  };''',
    s,
    'settle/startRun channel basis',
)
s = sub1(
    r'''    play\(nodes: readonly ProjectionPlayNode\[\]\): void \{\n      // Незавершённое состояние .*?\n\n      // Валидация дерева''',
    '''    play(nodes: readonly ProjectionPlayNode[]): void {
      const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;
      const basePrev = finite(springBasis._value);
      const baseVelocityPrev = finite(springBasis._velocity);
      const qPrev = finite(springBasis._valueV0);
      const qVelocityPrev = finite(springBasis._velocityV0);
      const scalarV0Prev = v0Hat;
      const vPrev = vHat;
      const channelVelocity = (v0: number): number => {
        const raw = finite(baseVelocityPrev + v0 * qVelocityPrev);
        return bounded ? visibleVelocity(finite(basePrev + v0 * qPrev), raw) : raw;
      };

      const resolved: ProjectionNodeInit[] = nodes.map((n) => {
        if (n.first === undefined) {
          const old = prevById?.get(n.id);
          if (old === undefined) throw new MotionParamError('LM078');
          return rebaseNode(n.id, n, old, basePrev, qPrev, scalarV0Prev, bounded);
        }
        return n as ProjectionNodeInit;
      });

      let v0 = 0;
      if (prevById !== undefined) {
        let bestAbs = 0;
        let bestVelocity = 0;
        let bestRange = 0;
        const consider = (physicalVelocity: number, newRange: number): void => {
          const a = Math.abs(newRange);
          if (a > bestAbs) {
            bestAbs = a;
            bestVelocity = physicalVelocity;
            bestRange = newRange;
          }
        };
        for (const node of resolved) {
          const old = prevById.get(node.id);
          if (old === undefined) continue;
          const oldRx = old.last.x - old.first.x;
          const oldRy = old.last.y - old.first.y;
          consider(oldRx * channelVelocity(old._vx ?? scalarV0Prev), node.last.x - node.first.x);
          consider(oldRy * channelVelocity(old._vy ?? scalarV0Prev), node.last.y - node.first.y);
          consider((old.last.width - old.first.width) * vPrev, node.last.width - node.first.width);
          consider((old.last.height - old.first.height) * vPrev, node.last.height - node.first.height);
          if (old.radii !== undefined && node.radii !== undefined) {
            for (let c = 0; c < 4; c++) {
              consider((old.radii.last[c].x - old.radii.first[c].x) * vPrev, node.radii.last[c].x - node.radii.first[c].x);
              consider((old.radii.last[c].y - old.radii.first[c].y) * vPrev, node.radii.last[c].y - node.radii.first[c].y);
            }
          }
          if (old.opacity !== undefined && node.opacity !== undefined) {
            consider((old.opacity.to - old.opacity.from) * vPrev, node.opacity.to - node.opacity.from);
          }
        }
        if (bestAbs > RANGE_EPSILON) {
          v0 = clampMagnitude(finite(bestVelocity / bestRange), V0_CAP);
        }
      }

      let vector = false;
      if (prevById !== undefined) {
        for (let i = 0; i < resolved.length; i++) {
          let node = resolved[i] as VectorProjectionNode;
          const old = prevById.get(node.id);
          if (old === undefined) continue;
          const oldRx = old.last.x - old.first.x;
          const oldRy = old.last.y - old.first.y;
          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          const vx = Math.abs(rx) <= RANGE_EPSILON
            ? 0
            : clampMagnitude(finite((oldRx * channelVelocity(old._vx ?? scalarV0Prev)) / rx), V0_CAP);
          const vy = Math.abs(ry) <= RANGE_EPSILON
            ? 0
            : clampMagnitude(finite((oldRy * channelVelocity(old._vy ?? scalarV0Prev)) / ry), V0_CAP);
          if (vx !== v0 || vy !== v0) {
            if (nodes[i].first !== undefined) node = resolved[i] = { ...node } as VectorProjectionNode;
            if (vx !== v0) node._vx = vx;
            if (vy !== v0) node._vy = vy;
            vector = true;
          }
        }
      }

      // Валидация дерева''',
    s,
    'play channel-v0 prelude',
)
s = s.replace('flight = { byId, projector, reduced, vector };', 'flight = { byId, projector, reduced };')
s = s.replace(
    '      vHat = 0;\n      springBasis._velocityV0 = 0;\n    },',
    '      vHat = 0;\n      springBasis._velocity = springBasis._velocityV0 = 0;\n    },',
    1,
)
s = s.replace(
    '      pHat = pp;\n      vHat = 0;\n      springBasis._valueV0 = springBasis._velocityV0 = 0;',
    '      pHat = pp;\n      vHat = v0Hat = 0;\n      springBasis._value = pp;\n      springBasis._velocity = springBasis._valueV0 = springBasis._velocityV0 = 0;',
)
s = s.replace('      emit(flight.projector, pp, 0);', '      emit(flight.projector, pp);')
s = s.replace(
    'rebased.push(rebaseNode(n.id, n, n, p0, springBasis._valueV0));',
    'rebased.push(rebaseNode(n.id, n, n, springBasis._value, springBasis._valueV0, v0Hat, bounded));',
)
s = s.replace('flight = { byId, projector, reduced, vector: false };', 'flight = { byId, projector, reduced };')
s = s.replace(
    ': boxWithPositionBasis(node, pHat, springBasis._valueV0);',
    ': boxWithChannelBasis(node, springBasis._value, springBasis._valueV0, v0Hat, bounded);',
)
assert 'boxWithPositionBasis' not in s
assert '._qx' not in s and '._qy' not in s and '._qb' not in s
d.write_text(s)
