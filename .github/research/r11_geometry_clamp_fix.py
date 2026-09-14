from pathlib import Path


def replace1(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    assert count == 1, f'{label}: expected 1, got {count}'
    return text.replace(old, new, 1)


g = Path('src/projection/geometry.ts')
s = g.read_text()
s = replace1(
    s,
    '''export function clamp01(x: number): number {
  const f = Number.isNaN(x) ? 0 : x;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
''',
    '''export function clamp01(x: number): number {
  const f = Number.isNaN(x) ? 0 : x;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Clamp a page-space position to its pickup→target envelope. @internal */
export function boundPositionAxis(value: number, first: number, last: number): number {
  const lo = Math.min(finite(first), finite(last));
  const hi = Math.max(finite(first), finite(last));
  return value < lo ? lo : value > hi ? hi : value;
}

/** Derivative of boundPositionAxis: hidden/outward motion at a boundary is zero. @internal */
export function boundPositionVelocity(
  value: number,
  velocity: number,
  first: number,
  last: number,
): number {
  const lo = Math.min(finite(first), finite(last));
  const hi = Math.max(finite(first), finite(last));
  if (value < lo || value > hi) return 0;
  if ((value === lo && velocity < 0) || (value === hi && velocity > 0)) return 0;
  return finite(velocity) + 0;
}
''',
    'geometry bounded primitives',
)
s = replace1(
    s,
    '''        if (boundPositionBasis) {
          v.x = Math.max(Math.min(v.x, Math.max(node.first.x, node.last.x)), Math.min(node.first.x, node.last.x));
          v.y = Math.max(Math.min(v.y, Math.max(node.first.y, node.last.y)), Math.min(node.first.y, node.last.y));
        }
''',
    '''        if (boundPositionBasis) {
          v.x = boundPositionAxis(v.x, node.first.x, node.last.x);
          v.y = boundPositionAxis(v.y, node.first.y, node.last.y);
        }
''',
    'geometry emitted clamp',
)
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = replace1(
    s,
    '''import {
  clamp01,
  createDriverProjector,
''',
    '''import {
  boundPositionAxis,
  boundPositionVelocity,
  clamp01,
  createDriverProjector,
''',
    'driver imports',
)
s = replace1(
    s,
    '''function boxWithPositionBasis(
  src: ProjectionNodeInit,
  pHat: number,
  correction: PositionCorrection | undefined,
  positionBasisValue: number,
): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  if (correction === undefined || positionBasisValue === 0) return box;
  return {
    x: finite(box.x + correction.x * positionBasisValue) + 0,
    y: finite(box.y + correction.y * positionBasisValue) + 0,
    width: box.width,
    height: box.height,
  };
}
''',
    '''function boxWithPositionBasis(
  src: ProjectionNodeInit,
  pHat: number,
  correction: PositionCorrection | undefined,
  positionBasisValue: number,
  bounded = false,
): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  if (correction === undefined || positionBasisValue === 0) return box;
  const x = finite(box.x + correction.x * positionBasisValue) + 0;
  const y = finite(box.y + correction.y * positionBasisValue) + 0;
  return {
    x: bounded ? boundPositionAxis(x, src.first.x, src.last.x) : x,
    y: bounded ? boundPositionAxis(y, src.first.y, src.last.y) : y,
    width: box.width,
    height: box.height,
  };
}
''',
    'driver bounded box evaluator',
)
s = replace1(
    s,
    '''  correction?: PositionCorrection,
  positionBasisValue = 0,
): ProjectionNodeInit {
''',
    '''  correction?: PositionCorrection,
  positionBasisValue = 0,
  bounded = false,
): ProjectionNodeInit {
''',
    'rebase signature',
)
s = replace1(
    s,
    '''    first: boxWithPositionBasis(src, pHat, correction, positionBasisValue),
''',
    '''    first: boxWithPositionBasis(src, pHat, correction, positionBasisValue, bounded),
''',
    'rebase bounded first',
)
s = replace1(
    s,
    '''            prevPositionCorrections?.get(n.id),
            positionBasisPrev,
          );
''',
    '''            prevPositionCorrections?.get(n.id),
            positionBasisPrev,
            bounded,
          );
''',
    'play bounded rebase',
)
s = replace1(
    s,
    '''          const oldCorrection = prevPositionCorrections?.get(node.id);
          const oldVx = finite(
            (old.last.x - old.first.x) * vPrev +
              (oldCorrection?.x ?? 0) * positionBasisVelocityPrev,
          );
          const oldVy = finite(
            (old.last.y - old.first.y) * vPrev +
              (oldCorrection?.y ?? 0) * positionBasisVelocityPrev,
          );
''',
    '''          const oldCorrection = prevPositionCorrections?.get(node.id);
          const oldBox = boxWithPositionBasis(
            old,
            pPrev,
            oldCorrection,
            positionBasisPrev,
          );
          const rawVx = finite(
            (old.last.x - old.first.x) * vPrev +
              (oldCorrection?.x ?? 0) * positionBasisVelocityPrev,
          );
          const rawVy = finite(
            (old.last.y - old.first.y) * vPrev +
              (oldCorrection?.y ?? 0) * positionBasisVelocityPrev,
          );
          const oldVx = bounded
            ? boundPositionVelocity(oldBox.x, rawVx, old.first.x, old.last.x)
            : rawVx;
          const oldVy = bounded
            ? boundPositionVelocity(oldBox.y, rawVy, old.first.y, old.last.y)
            : rawVy;
''',
    'visible vector velocity',
)
s = replace1(
    s,
    '''            flight.positionCorrectionById.get(n.id),
            positionBasisHat,
          ),
''',
    '''            flight.positionCorrectionById.get(n.id),
            positionBasisHat,
            bounded,
          ),
''',
    'release bounded rebase',
)
s = replace1(
    s,
    '''            flight?.positionCorrectionById.get(id),
            positionBasisHat,
          );
''',
    '''            flight?.positionCorrectionById.get(id),
            positionBasisHat,
            bounded,
          );
''',
    'boxAt bounded state',
)
d.write_text(s)


t = Path('test/projection-vector-clamp.test.ts')
s = t.read_text()
needle = '\n});\n'
pos = s.rfind(needle)
assert pos >= 0, 'clamp test suite tail not found'
regression = r'''

  it('boxAt and repeated pickup share the emitted per-axis clamp state', () => {
    const clock = makeClock();
    let target = { x: 240, y: 0 };
    let emitted = { x: 0, y: 0 };
    const controls = createProjection({
      clamp: true,
      spring: { mass: 1, stiffness: 200, damping: 4 },
      requestFrame: clock.requestFrame,
      onFrame(frames) {
        emitted = {
          x: target.x + frames[0]!.tx,
          y: target.y + frames[0]!.ty,
        };
      },
    });

    controls.play([
      {
        id: 'card',
        first: { x: 0, y: 0, width: 100, height: 100 },
        last: { x: target.x, y: target.y, width: 100, height: 100 },
      },
    ]);
    clock.step(1000 / 120);
    clock.step(1000 / 120);

    const pickup = controls.boxAt('card')!;
    target = { x: pickup.x + 5, y: pickup.y + 220 };
    controls.play([
      { id: 'card', last: { x: target.x, y: target.y, width: 100, height: 100 } },
    ]);
    clock.step(1000 / 120);

    const before = { ...emitted };
    const analytical = controls.boxAt('card')!;
    expect(analytical.x).toBeCloseTo(before.x, 10);
    expect(analytical.y).toBeCloseTo(before.y, 10);
    // Non-vacuous witness: x is held at its upper pickup→target envelope while
    // the hidden homogeneous state would otherwise continue outside it.
    expect(before.x).toBeCloseTo(target.x, 10);

    target = { x: before.x - 40, y: before.y + 20 };
    controls.play([
      { id: 'card', last: { x: target.x, y: target.y, width: 100, height: 100 } },
    ]);
    expect(emitted.x).toBeCloseTo(before.x, 10);
    expect(emitted.y).toBeCloseTo(before.y, 10);

    // A velocity hidden beyond the old clamp edge is not a visible boundary
    // velocity. The next run may move inward, but cannot revive an outward kick.
    clock.step(1000 / 120);
    expect(emitted.x).toBeLessThanOrEqual(before.x + 1e-9);
  });
'''
s = s[:pos] + regression + s[pos:]
t.write_text(s)
