from pathlib import Path
import os
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


def index_owner() -> None:
    g = Path('src/projection/geometry.ts')
    s = g.read_text()
    old = 'export function createProjector(nodes: readonly ProjectionNodeInit[]): Projector {\n'
    new = '''export function createProjector(nodes: readonly ProjectionNodeInit[]): Projector;
export function createProjector(
  nodes: readonly ProjectionNodeInit[],
  indexById = new Map<string, number>(),
): Projector {
'''
    assert s.count(old) == 1, s.count(old)
    s = s.replace(old, new, 1)
    assert s.count('  const indexById = new Map<string, number>();\n') == 1
    s = s.replace('  const indexById = new Map<string, number>();\n', '', 1)
    g.write_text(s)

    d = Path('src/projection/driver.ts')
    s = d.read_text()
    old = '''interface Flight {
  /** Узлы полёта; Map сохраняет порядок вставки (= порядок resolved-входа). */
  readonly byId: ReadonlyMap<string, VectorProjectionNode>;
  readonly projector: Projector;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */
  readonly reduced: boolean;
}
'''
    new = '''interface Flight {
  readonly nodes: readonly VectorProjectionNode[];
  readonly indexById: ReadonlyMap<string, number>;
  readonly projector: Projector;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */
  readonly reduced: boolean;
}

function flightNode(flight: Flight, id: string): VectorProjectionNode | undefined {
  const i = flight.indexById.get(id);
  return i === undefined ? undefined : flight.nodes[i];
}
'''
    assert s.count(old) == 1, 'Flight after all_safe must have no vector field'
    s = s.replace(old, new, 1)

    assert s.count("const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;") == 1
    s = s.replace(
        "const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;",
        "const prevFlight = phase !== 'rest' && flight !== null ? flight : undefined;",
        1,
    )
    assert s.count('const old = prevById?.get(n.id);') == 1
    s = s.replace(
        'const old = prevById?.get(n.id);',
        'const old = prevFlight === undefined ? undefined : flightNode(prevFlight, n.id);',
        1,
    )
    assert s.count('prevById !== undefined') == 2
    s = s.replace('prevById !== undefined', 'prevFlight !== undefined')
    assert s.count('const old = prevById.get(node.id);') == 2
    s = s.replace('const old = prevById.get(node.id);', 'const old = flightNode(prevFlight, node.id);')
    assert 'prevById' not in s

    old = '''      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createProjector(resolved);
      const reduced = prefersReducedMotion(options?.matchMedia); // резолв ОДИН раз на play

      const byId = new Map<string, VectorProjectionNode>();
      for (const node of resolved) byId.set(node.id, node as VectorProjectionNode);
      flight = { byId, projector, reduced };
'''
    new = '''      // Валидация дерева и индекс id имеют одного владельца.
      const indexById = new Map<string, number>();
      const projector = (createProjector as unknown as (
        nodes: readonly ProjectionNodeInit[],
        index: Map<string, number>,
      ) => Projector)(resolved, indexById);
      const reduced = prefersReducedMotion(options?.matchMedia);
      flight = { nodes: resolved as readonly VectorProjectionNode[], indexById, projector, reduced };
'''
    assert s.count(old) == 1, 'play map owner'
    s = s.replace(old, new, 1)

    assert s.count('for (const n of flight.byId.values()) {') == 1
    s = s.replace('for (const n of flight.byId.values()) {', 'for (const n of flight.nodes) {', 1)
    old = '''      const projector = createProjector(rebased);
      const byId = new Map<string, VectorProjectionNode>();
      for (const node of rebased) byId.set(node.id, node);
      const reduced = flight.reduced;
      flight = { byId, projector, reduced };
'''
    new = '''      const indexById = new Map<string, number>();
      const projector = (createProjector as unknown as (
        nodes: readonly ProjectionNodeInit[],
        index: Map<string, number>,
      ) => Projector)(rebased, indexById);
      const reduced = flight.reduced;
      flight = { nodes: rebased, indexById, projector, reduced };
'''
    assert s.count(old) == 1, 'release map owner'
    s = s.replace(old, new, 1)

    assert s.count('const node = flight?.byId.get(id);') == 1
    s = s.replace(
        'const node = flight?.byId.get(id);',
        'const node = flight === null ? undefined : flightNode(flight, id);',
        1,
    )
    assert '.byId' not in s
    d.write_text(s)


def direct_inline() -> None:
    d = Path('src/projection/driver.ts')
    s = d.read_text()
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
    new = '''          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          let x = bounded
            ? rx === 0 ? 0 : finite(finite(oldRx * visibleVelocity(pPrev + oldX * positionBasisPrev, vPrev + oldX * positionBasisVelocityPrev)) / rx - v0) + 0
            : finite(oldRx * vPrev + oldX * positionBasisVelocityPrev - rx * v0) + 0;
          let y = bounded
            ? ry === 0 ? 0 : finite(finite(oldRy * visibleVelocity(pPrev + oldY * positionBasisPrev, vPrev + oldY * positionBasisVelocityPrev)) / ry - v0) + 0
            : finite(oldRy * vPrev + oldY * positionBasisVelocityPrev - ry * v0) + 0;
'''
    assert s.count(old) == 1, 'direct residual block'
    d.write_text(s.replace(old, new, 1))


def residual_helper() -> None:
    d = Path('src/projection/driver.ts')
    s = d.read_text()
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
    new = '''          const residual = (oldRange: number, basis: number, range: number): number => {
            const oldVelocity = old._qb === true
              ? finite(oldRange * visibleVelocity(pPrev + basis * positionBasisPrev, vPrev + basis * positionBasisVelocityPrev))
              : finite(oldRange * vPrev + basis * positionBasisVelocityPrev);
            const value = finite(oldVelocity - range * v0) + 0;
            return bounded ? range === 0 ? 0 : finite(value / range) + 0 : value;
          };
          const rx = node.last.x - node.first.x;
          const ry = node.last.y - node.first.y;
          let x = residual(oldRx, oldX, rx);
          let y = residual(oldRy, oldY, ry);
'''
    assert s.count(old) == 1, 'helper residual block'
    d.write_text(s.replace(old, new, 1))


variant = os.environ['VARIANT']
if variant == 'safe_base':
    pass
elif variant == 'index_owner':
    index_owner()
elif variant == 'direct_inline':
    direct_inline()
elif variant == 'helper':
    residual_helper()
elif variant == 'index_direct':
    index_owner(); direct_inline()
elif variant == 'index_helper':
    index_owner(); residual_helper()
else:
    raise AssertionError(variant)
