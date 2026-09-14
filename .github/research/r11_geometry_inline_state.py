from pathlib import Path
import re


def sub1(pattern: str, repl: str, text: str, label: str) -> str:
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    assert n == 1, f'{label}: {n}'
    return out


g = Path('src/projection/geometry.ts')
s = g.read_text()
s = sub1(
    r'interface PositionBasisCorrection \{.*?function createProjectorCore\(\n  nodes: readonly ProjectionNodeInit\[\],\n  positionBasisById\?: ReadonlyMap<string, PositionBasisCorrection>,\n  boundPositionBasis = false,\n\): ProjectionDriverProjector \{',
    '''interface DriverProjectionNodeInit extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
  _qb?: true;
}

export function createProjector(nodes: readonly ProjectionNodeInit[]): Projector {''',
    s,
    'geometry header',
)
s = sub1(
    r'\n  // Driver-only homogeneous position basis\..*?\n  // Parent-ссылки',
    '\n\n  // Parent-ссылки',
    s,
    'geometry materialization',
)
s = sub1(
    r'  const atBasis = \(p: number, positionBasisValue: number\): readonly ProjectionFrame\[\] => \{',
    '  const at = (p: number, positionBasisValue = 0): readonly ProjectionFrame[] => {',
    s,
    'geometry at',
)
s = sub1(
    r'''      if \(q !== 0\) \{\n.*?      const a = liveAncestor\[i\];\n      if \(a === null\) \{\n        if \(\n          anchorIsLast\[i\] &&\n          \(q === 0 \|\| \(\(positionBasisX\?\.\[i\] \?\? 0\) === 0 && \(positionBasisY\?\.\[i\] \?\? 0\) === 0\)\)\n        \) \{''',
    '''      const vectorNode = node as DriverProjectionNodeInit;
      const bx = q === 0 ? 0 : (vectorNode._qx ?? 0);
      const by = q === 0 ? 0 : (vectorNode._qy ?? 0);
      if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
      if (by !== 0) v.y = finite(v.y + by * q) + 0;
      if (q !== 0 && vectorNode._qb === true) {
        v.x = Math.max(Math.min(v.x, Math.max(node.first.x, node.last.x)), Math.min(node.first.x, node.last.x));
        v.y = Math.max(Math.min(v.y, Math.max(node.first.y, node.last.y)), Math.min(node.first.y, node.last.y));
      }

      const a = liveAncestor[i];
      if (a === null) {
        if (anchorIsLast[i] && bx === 0 && by === 0) {''',
    s,
    'geometry vector apply',
)
s = sub1(
    r'''  const at = \(p: number\): readonly ProjectionFrame\[\] => atBasis\(p, 0\);\n  return \{ at, atBasis, order, hasPositionBasis \};\n\}\n\n/\*\* Public scalar projector\..*?export function createDriverProjector\(.*?\n\}\n?$''',
    '''  return { at, order };
}
''',
    s,
    'geometry tail',
)
assert all(x not in s for x in ['PositionBasisCorrection', 'ProjectionDriverProjector', 'createDriverProjector', 'positionBasisX', 'positionBasisY', 'atBasis'])
g.write_text(s)


d = Path('src/projection/driver.ts')
s = d.read_text()
s = s.replace('  createDriverProjector,', '  createProjector,')
s = s.replace('  type ProjectionDriverProjector,\n', '')
s = s.replace('  type ProjectionNodeInit,\n', '  type ProjectionNodeInit,\n  type Projector,\n')
s = sub1(
    r'interface PositionCorrection \{.*?\n\}\n\n/\*\*\n \* Ребейз узла',
    '''interface VectorProjectionNode extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
  _qb?: true;
}

function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  if (q === 0) return box;
  const x = src._qx ?? 0;
  const y = src._qy ?? 0;
  if (x === 0 && y === 0) return box;
  return { ...box, x: finite(box.x + x * q) + 0, y: finite(box.y + y * q) + 0 };
}

/**
 * Ребейз узла''',
    s,
    'driver correction helper',
)
s = sub1(
    r'''  src: ProjectionNodeInit,\n  pHat: number,\n  correction\?: PositionCorrection,\n  positionBasisValue = 0,\n\): ProjectionNodeInit \{''',
    '''  src: VectorProjectionNode,
  pHat: number,
  positionBasisValue = 0,
): VectorProjectionNode {''',
    s,
    'driver rebase signature',
)
s = s.replace(
    'first: boxWithPositionBasis(src, pHat, correction, positionBasisValue),',
    'first: boxWithPositionBasis(src, pHat, positionBasisValue),',
)
s = sub1(
    r'''  readonly byId: ReadonlyMap<string, ProjectionNodeInit>;\n  /\*\* Physical x/y velocity correction relative to the shared scalar progress\. \*/\n  readonly positionCorrectionById: ReadonlyMap<string, PositionCorrection>;\n  readonly projector: ProjectionDriverProjector;''',
    '''  readonly byId: ReadonlyMap<string, VectorProjectionNode>;
  readonly projector: Projector;
  readonly vector: boolean;''',
    s,
    'driver flight',
)
s = s.replace('projector: ProjectionDriverProjector', 'projector: Projector')
s = s.replace(
    'onFrame?.(projector.atBasis(p, positionBasisValue));',
    'onFrame?.((projector.at as (p: number, q?: number) => readonly ProjectionFrame[])(p, positionBasisValue));',
)
s = s.replace(
    'const startRun = (projector: Projector, v0: number): void => {',
    'const startRun = (projector: Projector, v0: number, vector = false): void => {',
)
s = s.replace('positionBasisVelocityHat = projector.hasPositionBasis ? 1 : 0;', 'positionBasisVelocityHat = vector ? 1 : 0;')
s = s.replace('const q = projector.hasPositionBasis ? finite(springBasis._valueV0) : 0;', 'const q = vector ? finite(springBasis._valueV0) : 0;')
s = s.replace('const qVelocity = projector.hasPositionBasis ? finite(springBasis._velocityV0) : 0;', 'const qVelocity = vector ? finite(springBasis._velocityV0) : 0;')
s = s.replace('!projector.hasPositionBasis || (Math.abs(q) < REST && Math.abs(qVelocity) < REST);', '!vector || (Math.abs(q) < REST && Math.abs(qVelocity) < REST);')
s = sub1(
    r'''      const prevPositionCorrections =\n        phase !== 'rest' && flight !== null \? flight\.positionCorrectionById : undefined;\n''',
    '',
    s,
    'driver prev map',
)
s = sub1(
    r'''          return rebaseNode\(\n            n\.id,\n            n,\n            old,\n            pPrev,\n            prevPositionCorrections\?\.get\(n\.id\),\n            positionBasisPrev,\n          \);''',
    '          return rebaseNode(n.id, n, old, pPrev, positionBasisPrev);',
    s,
    'driver pickup',
)
s = sub1(
    r'''      // x/y carry their own physical boundary velocity.*?      // Валидация дерева — рано, до любых эффектов, даже под reduce\.\n      const projector = createDriverProjector\(resolved, positionCorrectionById, bounded\);''',
    '''      // x/y carry their own physical boundary velocity while scalar channels share P(t).
      let vector = false;
      if (prevById !== undefined) {
        for (let i = 0; i < resolved.length; i++) {
          let node = resolved[i] as VectorProjectionNode;
          const old = prevById.get(node.id);
          if (old === undefined) continue;
          const oldVx = finite((old.last.x - old.first.x) * vPrev + (old._qx ?? 0) * positionBasisVelocityPrev);
          const oldVy = finite((old.last.y - old.first.y) * vPrev + (old._qy ?? 0) * positionBasisVelocityPrev);
          const x = finite(oldVx - (node.last.x - node.first.x) * v0) + 0;
          const y = finite(oldVy - (node.last.y - node.first.y) * v0) + 0;
          if (x !== 0 || y !== 0) {
            if (nodes[i].first !== undefined) node = resolved[i] = { ...node } as VectorProjectionNode;
            node._qx = x;
            node._qy = y;
            if (bounded) node._qb = true;
            vector = true;
          }
        }
      }

      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createProjector(resolved);''',
    s,
    'driver vector state',
)
s = sub1(
    r'''      const byId = new Map<string, ProjectionNodeInit>\(\);\n      for \(const node of resolved\) byId\.set\(node\.id, node\);\n      flight = \{ byId, positionCorrectionById, projector, reduced \};''',
    '''      const byId = new Map<string, VectorProjectionNode>();
      for (const node of resolved) byId.set(node.id, node as VectorProjectionNode);
      flight = { byId, projector, reduced, vector };''',
    s,
    'driver flight create',
)
pos = s.find('      startRun(projector, v0);')
assert pos >= 0
s = s[:pos] + '      startRun(projector, v0, vector);' + s[pos + len('      startRun(projector, v0);'):]
s = sub1(
    r'''        rebased\.push\(\n          rebaseNode\(\n            n\.id,\n            n,\n            n,\n            p0,\n            flight\.positionCorrectionById\.get\(n\.id\),\n            positionBasisHat,\n          \),\n        \);''',
    '        rebased.push(rebaseNode(n.id, n, n, p0, positionBasisHat));',
    s,
    'driver release rebase',
)
s = sub1(
    r'''      const positionCorrectionById = new Map<string, PositionCorrection>\(\);\n      const projector = createDriverProjector\(rebased, positionCorrectionById, bounded\);\n      const byId = new Map<string, ProjectionNodeInit>\(\);\n      for \(const node of rebased\) byId\.set\(node\.id, node\);\n      const reduced = flight\.reduced;\n      flight = \{ byId, positionCorrectionById, projector, reduced \};''',
    '''      const projector = createProjector(rebased);
      const byId = new Map<string, VectorProjectionNode>();
      for (const node of rebased) byId.set(node.id, node);
      const reduced = flight.reduced;
      flight = { byId, projector, reduced, vector: false };''',
    s,
    'driver release state',
)
s = sub1(
    r'''        : boxWithPositionBasis\(\n            node,\n            pHat,\n            flight\?\.positionCorrectionById\.get\(id\),\n            positionBasisHat,\n          \);''',
    '        : boxWithPositionBasis(node, pHat, positionBasisHat);',
    s,
    'driver boxAt',
)
assert all(x not in s for x in ['positionCorrectionById', 'PositionCorrection', 'createDriverProjector', 'ProjectionDriverProjector', 'hasPositionBasis'])
d.write_text(s)
