from pathlib import Path


def one(s: str, old: str, new: str, label: str) -> str:
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1, got {n}')
    return s.replace(old, new, 1)


# Geometry owns projection math; driver supplies one optional interleaved [ux,uy] array.
p = Path('src/projection/geometry.ts')
s = p.read_text()
s = one(s,
"""interface PositionBasisCorrection {
  readonly x: number;
  readonly y: number;
}

/** @internal Driver-only projector: same geometry owner, plus the homogeneous
 * position basis used to preserve independent page-space x/y velocity. */
export interface ProjectionDriverProjector extends Projector {
  atBasis(p: number, positionBasisValue: number): readonly ProjectionFrame[];
  readonly hasPositionBasis: boolean;
}

function createProjectorCore(
  nodes: readonly ProjectionNodeInit[],
  positionBasisById?: ReadonlyMap<string, PositionBasisCorrection>,
  boundPositionBasis = false,
): ProjectionDriverProjector {""",
"""/** @internal Driver-only projector: same geometry owner, plus the homogeneous
 * position basis used to preserve independent page-space x/y velocity. */
export interface ProjectionDriverProjector extends Projector {
  atBasis(p: number, positionBasisValue: number): readonly ProjectionFrame[];
}

function createProjectorCore(
  nodes: readonly ProjectionNodeInit[],
  positionBasis?: Float64Array,
  boundPositionBasis = false,
): ProjectionDriverProjector {""",
'geometry signature')

s = one(s,
"""  // Driver-only homogeneous position basis. Values are physical px/s
  // corrections relative to the shared scalar progress velocity. Public
  // createProjector never supplies them, so its old bit-path stays untouched.
  let positionBasisX: Float64Array | undefined;
  let positionBasisY: Float64Array | undefined;
  let hasPositionBasis = false;
  if (positionBasisById !== undefined && positionBasisById.size !== 0) {
    positionBasisX = new Float64Array(count);
    positionBasisY = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const correction = positionBasisById.get(nodes[i].id);
      if (correction === undefined) continue;
      const x = finite(correction.x);
      const y = finite(correction.y);
      positionBasisX[i] = x;
      positionBasisY[i] = y;
      if (x !== 0 || y !== 0) hasPositionBasis = true;
    }
  }

""",
"""  // Driver-only physical px/s corrections, interleaved [ux,uy] in node order.
  // Undefined is the zero-correction scalar fast path.

""",
'geometry map materialization')

s = s.replace("const bx = positionBasisX?.[i] ?? 0;\n        const by = positionBasisY?.[i] ?? 0;",
              "const bx = positionBasis?.[i * 2] ?? 0;\n        const by = positionBasis?.[i * 2 + 1] ?? 0;")
s = s.replace("(q === 0 || ((positionBasisX?.[i] ?? 0) === 0 && (positionBasisY?.[i] ?? 0) === 0))",
              "(q === 0 || ((positionBasis?.[i * 2] ?? 0) === 0 && (positionBasis?.[i * 2 + 1] ?? 0) === 0))")
s = one(s,
"return { at, atBasis, order, hasPositionBasis };",
"return { at, atBasis, order };",
'geometry return')
s = one(s,
"""export function createDriverProjector(
  nodes: readonly ProjectionNodeInit[],
  positionBasisById: ReadonlyMap<string, PositionBasisCorrection>,
  bounded = false,
): ProjectionDriverProjector {
  return createProjectorCore(nodes, positionBasisById, bounded);
}""",
"""export function createDriverProjector(
  nodes: readonly ProjectionNodeInit[],
  positionBasis: Float64Array | undefined,
  bounded = false,
): ProjectionDriverProjector {
  return createProjectorCore(nodes, positionBasis, bounded);
}""",
'geometry driver factory')
p.write_text(s)


p = Path('src/projection/driver.ts')
s = p.read_text()
s = one(s,
"""interface PositionCorrection {
  readonly x: number;
  readonly y: number;
}

const EMPTY_POSITION_CORRECTIONS: ReadonlyMap<string, PositionCorrection> = new Map();

function boxWithPositionBasis(
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
}""",
"""function boxWithPositionBasis(
  src: ProjectionNodeInit,
  pHat: number,
  ux: number,
  uy: number,
  positionBasisValue: number,
): FlipRect {
  const box = mixBox(src.first, src.last, pHat);
  if (positionBasisValue === 0 || (ux === 0 && uy === 0)) return box;
  return {
    x: finite(box.x + ux * positionBasisValue) + 0,
    y: finite(box.y + uy * positionBasisValue) + 0,
    width: box.width,
    height: box.height,
  };
}""",
'driver correction helper')

s = one(s,
"""  correction?: PositionCorrection,
  positionBasisValue = 0,
): ProjectionNodeInit {
  const tc = clamp01(pHat);
  return {
    id,
    parent: target.parent,
    first: boxWithPositionBasis(src, pHat, correction, positionBasisValue),""",
"""  ux = 0,
  uy = 0,
  positionBasisValue = 0,
): ProjectionNodeInit {
  const tc = clamp01(pHat);
  return {
    id,
    parent: target.parent,
    first: boxWithPositionBasis(src, pHat, ux, uy, positionBasisValue),""",
'driver rebase args')

s = one(s,
"""interface Flight {
  /** Узлы полёта; Map сохраняет порядок вставки (= порядок resolved-входа). */
  readonly byId: ReadonlyMap<string, ProjectionNodeInit>;
  /** Physical x/y velocity correction relative to the shared scalar progress. */
  readonly positionCorrectionById: ReadonlyMap<string, PositionCorrection>;
  readonly projector: ProjectionDriverProjector;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */
  readonly reduced: boolean;
}""",
"""interface Flight {
  readonly nodes: readonly ProjectionNodeInit[];
  readonly indexById: ReadonlyMap<string, number>;
  /** Interleaved physical [ux,uy] correction in nodes order; absent on scalar path. */
  readonly positionBasis: Float64Array | undefined;
  readonly projector: ProjectionDriverProjector;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */
  readonly reduced: boolean;
}

function indexNodes(nodes: readonly ProjectionNodeInit[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) out.set(nodes[i].id, i);
  return out;
}""",
'driver flight state')

# startRun no longer asks projector to own basis-state metadata.
s = one(s,
"const startRun = (projector: ProjectionDriverProjector, v0: number): void => {",
"const startRun = (projector: ProjectionDriverProjector, v0: number, vector: boolean): void => {",
'startRun signature')
s = s.replace("positionBasisVelocityHat = projector.hasPositionBasis ? 1 : 0;",
              "positionBasisVelocityHat = vector ? 1 : 0;")
s = s.replace("const q = projector.hasPositionBasis ? finite(springBasis._valueV0) : 0;\n      const qVelocity = projector.hasPositionBasis ? finite(springBasis._velocityV0) : 0;\n      const basisConverged =\n        !projector.hasPositionBasis || (Math.abs(q) < REST && Math.abs(qVelocity) < REST);",
              "const q = vector ? finite(springBasis._valueV0) : 0;\n      const qVelocity = vector ? finite(springBasis._velocityV0) : 0;\n      const basisConverged = !vector || (Math.abs(q) < REST && Math.abs(qVelocity) < REST);")

s = one(s,
"""      const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;
      const prevPositionCorrections =
        phase !== 'rest' && flight !== null ? flight.positionCorrectionById : undefined;
      const pPrev = pHat;""",
"""      const prevNodes = phase !== 'rest' && flight !== null ? flight.nodes : undefined;
      const prevIndexById = phase !== 'rest' && flight !== null ? flight.indexById : undefined;
      const prevPositionBasis = phase !== 'rest' && flight !== null ? flight.positionBasis : undefined;
      const pPrev = pHat;""",
'previous flight state')

# Replace resolved map block as one unit.
s = one(s,
"""      const resolved: ProjectionNodeInit[] = nodes.map((n) => {
        if (n.first === undefined) {
          const old = prevById?.get(n.id);
          if (old === undefined) {
            throw new MotionParamError('LM078');
          }
          return rebaseNode(
            n.id,
            n,
            old,
            pPrev,
            prevPositionCorrections?.get(n.id),
            positionBasisPrev,
          );
        }
        // first задан: узел структурно уже ProjectionNodeInit; геометрия читает
        // поля по ссылкам в обоих вариантах — копия объекта ничего не защищала.
        return n as ProjectionNodeInit;
      });""",
"""      const resolved: ProjectionNodeInit[] = nodes.map((n) => {
        if (n.first === undefined) {
          const oldIndex = prevIndexById?.get(n.id);
          if (oldIndex === undefined || prevNodes === undefined) throw new MotionParamError('LM078');
          return rebaseNode(
            n.id,
            n,
            prevNodes[oldIndex],
            pPrev,
            prevPositionBasis?.[oldIndex * 2] ?? 0,
            prevPositionBasis?.[oldIndex * 2 + 1] ?? 0,
            positionBasisPrev,
          );
        }
        return n as ProjectionNodeInit;
      });""",
'resolved pickup')

# Dominant scan old lookup.
s = s.replace("if (prevById !== undefined && vPrev !== 0) {", "if (prevIndexById !== undefined && prevNodes !== undefined && vPrev !== 0) {")
s = s.replace("const old = prevById.get(node.id);\n          if (old === undefined) continue;",
              "const oldIndex = prevIndexById.get(node.id);\n          if (oldIndex === undefined) continue;\n          const old = prevNodes[oldIndex];", 1)

# Replace correction construction + flight materialization.
s = one(s,
"""      let mutablePositionCorrections: Map<string, PositionCorrection> | undefined;
      if (prevById !== undefined) {
        for (const node of resolved) {
          const old = prevById.get(node.id);
          if (old === undefined) continue;
          const oldCorrection = prevPositionCorrections?.get(node.id);
          const oldVx = finite(
            (old.last.x - old.first.x) * vPrev +
              (oldCorrection?.x ?? 0) * positionBasisVelocityPrev,
          );
          const oldVy = finite(
            (old.last.y - old.first.y) * vPrev +
              (oldCorrection?.y ?? 0) * positionBasisVelocityPrev,
          );
          const correction = {
            x: finite(oldVx - (node.last.x - node.first.x) * v0) + 0,
            y: finite(oldVy - (node.last.y - node.first.y) * v0) + 0,
          };
          if (correction.x !== 0 || correction.y !== 0) {
            (mutablePositionCorrections ??= new Map()).set(node.id, correction);
          }
        }
      }
      const positionCorrectionById =
        mutablePositionCorrections ?? EMPTY_POSITION_CORRECTIONS;

      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createDriverProjector(resolved, positionCorrectionById, bounded);
      const reduced = prefersReducedMotion(options?.matchMedia); // резолв ОДИН раз на play

      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of resolved) byId.set(node.id, node);
      flight = { byId, positionCorrectionById, projector, reduced };""",
"""      let positionBasis: Float64Array | undefined;
      if (prevIndexById !== undefined && prevNodes !== undefined) {
        for (let i = 0; i < resolved.length; i++) {
          const node = resolved[i];
          const oldIndex = prevIndexById.get(node.id);
          if (oldIndex === undefined) continue;
          const old = prevNodes[oldIndex];
          const ux = prevPositionBasis?.[oldIndex * 2] ?? 0;
          const uy = prevPositionBasis?.[oldIndex * 2 + 1] ?? 0;
          const cx = finite((old.last.x - old.first.x) * vPrev + ux * positionBasisVelocityPrev - (node.last.x - node.first.x) * v0) + 0;
          const cy = finite((old.last.y - old.first.y) * vPrev + uy * positionBasisVelocityPrev - (node.last.y - node.first.y) * v0) + 0;
          if (cx !== 0 || cy !== 0) {
            positionBasis ??= new Float64Array(resolved.length * 2);
            positionBasis[i * 2] = cx;
            positionBasis[i * 2 + 1] = cy;
          }
        }
      }

      const projector = createDriverProjector(resolved, positionBasis, bounded);
      const reduced = prefersReducedMotion(options?.matchMedia);
      flight = { nodes: resolved, indexById: indexNodes(resolved), positionBasis, projector, reduced };""",
'position correction state')

s = one(s, "startRun(projector, v0);", "startRun(projector, v0, positionBasis !== undefined);", 'play startRun')

# Release block.
s = one(s,
"""      const rebased: ProjectionNodeInit[] = [];
      for (const n of flight.byId.values()) {
        rebased.push(
          rebaseNode(
            n.id,
            n,
            n,
            p0,
            flight.positionCorrectionById.get(n.id),
            positionBasisHat,
          ),
        );
      }
      const positionCorrectionById = new Map<string, PositionCorrection>();
      const projector = createDriverProjector(rebased, positionCorrectionById, bounded);
      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of rebased) byId.set(node.id, node);
      const reduced = flight.reduced;
      flight = { byId, positionCorrectionById, projector, reduced };""",
"""      const rebased: ProjectionNodeInit[] = [];
      for (let i = 0; i < flight.nodes.length; i++) {
        const n = flight.nodes[i];
        rebased.push(rebaseNode(
          n.id,
          n,
          n,
          p0,
          flight.positionBasis?.[i * 2] ?? 0,
          flight.positionBasis?.[i * 2 + 1] ?? 0,
          positionBasisHat,
        ));
      }
      const projector = createDriverProjector(rebased, undefined, bounded);
      const reduced = flight.reduced;
      flight = { nodes: rebased, indexById: indexNodes(rebased), positionBasis: undefined, projector, reduced };""",
'release state')
s = one(s, "startRun(projector, v0);", "startRun(projector, v0, false);", 'release startRun')

# boxAt.
s = one(s,
"""      const node = flight?.byId.get(id);
      if (node === undefined) return undefined;
      return phase === 'rest'
        ? node.last
        : boxWithPositionBasis(
            node,
            pHat,
            flight?.positionCorrectionById.get(id),
            positionBasisHat,
          );""",
"""      if (flight === null) return undefined;
      const i = flight.indexById.get(id);
      if (i === undefined) return undefined;
      const node = flight.nodes[i];
      return phase === 'rest'
        ? node.last
        : boxWithPositionBasis(
            node,
            pHat,
            flight.positionBasis?.[i * 2] ?? 0,
            flight.positionBasis?.[i * 2 + 1] ?? 0,
            positionBasisHat,
          );""",
'boxAt state')

# Comments mentioning byId in seek are harmless but facts should stay current.
s = s.replace('(byId пуст — play не звался)', '(nodes пуст — play не звался)')
p.write_text(s)
