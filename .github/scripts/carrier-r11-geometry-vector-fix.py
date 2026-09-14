from pathlib import Path


def replace_one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, got {count}')
    return text.replace(old, new, 1)


geometry_path = Path('src/projection/geometry.ts')
geometry = geometry_path.read_text()

geometry = replace_one(
    geometry,
    "export function createProjector(nodes: readonly ProjectionNodeInit[]): Projector {\n  const count = nodes.length;",
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
): ProjectionDriverProjector {
  const count = nodes.length;""",
    'geometry factory signature',
)

geometry = replace_one(
    geometry,
    """  // Parent-ссылки (лес: у узла не больше одного родителя).
  const parentIdx: (number | null)[] = new Array(count);""",
    """  // Driver-only homogeneous position basis. Values are physical px/s
  // corrections relative to the shared scalar progress velocity. Public
  // createProjector never supplies them, so its old bit-path stays untouched.
  const positionBasisX = new Float64Array(count);
  const positionBasisY = new Float64Array(count);
  let hasPositionBasis = false;
  if (positionBasisById !== undefined) {
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

  // Parent-ссылки (лес: у узла не больше одного родителя).
  const parentIdx: (number | null)[] = new Array(count);""",
    'geometry basis arrays',
)

geometry = replace_one(
    geometry,
    """  const at = (p: number): readonly ProjectionFrame[] => {
    const t = Number.isNaN(p) ? 0 : p; // санация p — паритет flipAtRaw (NaN → 0)
    const tc = clamp01(t);""",
    """  const atBasis = (p: number, positionBasisValue: number): readonly ProjectionFrame[] => {
    const t = Number.isNaN(p) ? 0 : p; // санация p — паритет flipAtRaw (NaN → 0)
    const q = finite(positionBasisValue);
    const tc = clamp01(t);""",
    'geometry atBasis signature',
)

geometry = replace_one(
    geometry,
    """      const node = nodes[i];
      const frame = frames[oi];
      mixInto(node.first, node.last, t, v);

      const a = liveAncestor[i];""",
    """      const node = nodes[i];
      const frame = frames[oi];
      mixInto(node.first, node.last, t, v);
      // Linear second-order spring solution: page position = scalar path + u·Q(t).
      // Q(0)=0 and Q'(0)=1, so this preserves C0 while carrying only the
      // independent x/y boundary velocity not representable by one scalar p.
      if (q !== 0) {
        const bx = positionBasisX[i];
        const by = positionBasisY[i];
        if (bx !== 0) v.x = finite(v.x + bx * q) + 0;
        if (by !== 0) v.y = finite(v.y + by * q) + 0;
      }

      const a = liveAncestor[i];""",
    'geometry position basis application',
)

geometry = replace_one(
    geometry,
    """      if (a === null) {
        if (anchorIsLast[i]) {
          rootFlipInto(node.first, node.last, t, frame);""",
    """      if (a === null) {
        if (
          anchorIsLast[i] &&
          (q === 0 || (positionBasisX[i] === 0 && positionBasisY[i] === 0))
        ) {
          rootFlipInto(node.first, node.last, t, frame);""",
    'geometry corrected root path',
)

geometry = replace_one(
    geometry,
    """  return { at, order };
}""",
    """  const at = (p: number): readonly ProjectionFrame[] => atBasis(p, 0);
  return { at, atBasis, order, hasPositionBasis };
}

/** Public scalar projector. The returned shape intentionally stays unchanged. */
export function createProjector(nodes: readonly ProjectionNodeInit[]): Projector {
  const projector = createProjectorCore(nodes);
  return { at: projector.at, order: projector.order };
}

/** @internal Projection driver seam for independent x/y boundary velocity. */
export function createDriverProjector(
  nodes: readonly ProjectionNodeInit[],
  positionBasisById: ReadonlyMap<string, PositionBasisCorrection>,
): ProjectionDriverProjector {
  return createProjectorCore(nodes, positionBasisById);
}""",
    'geometry factory return',
)
geometry_path.write_text(geometry)


driver_path = Path('src/projection/driver.ts')
driver = driver_path.read_text()

driver = replace_one(
    driver,
    "import { solveSpring } from '../internal/solver.js';",
    "import { solveSpring, type MutableSpringBasis } from '../internal/solver.js';",
    'driver solver import',
)
driver = replace_one(
    driver,
    """  clamp01,
  createProjector,
  finite,""",
    """  clamp01,
  createDriverProjector,
  finite,""",
    'driver projector import',
)
driver = replace_one(
    driver,
    """  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
} from './geometry.js';""",
    """  type ProjectionDriverProjector,
  type ProjectionFrame,
  type ProjectionNodeInit,
} from './geometry.js';""",
    'driver projector type import',
)

driver = replace_one(
    driver,
    """/**
 * Ребейз узла на p̂ по данным src-узла: first' = V(p̂), radii.first'/opacity.from'
 * — тем же lerp'ом (C⁰ всех каналов); цели (.last/.to) — из target.
 * Единая механика pickup (src = prev-узел старого полёта) и release (src = сам
 * узел: скраб зафиксировал p_seek). Src без radii/opacity → канал target как есть.
 */
function rebaseNode(
  id: string,
  target: Omit<ProjectionPlayNode, 'id'>,
  src: ProjectionNodeInit,
  pHat: number,
): ProjectionNodeInit {
  const tc = clamp01(pHat);
  return {
    id,
    parent: target.parent,
    first: mixBox(src.first, src.last, pHat),""",
    """interface PositionCorrection {
  readonly x: number;
  readonly y: number;
}

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
}

/**
 * Ребейз узла на текущем аналитическом visual box. Scalar channels use p̂;
 * page-space x/y additionally include the homogeneous Q(t) basis so repeated
 * retargets never fall back to DOM reads or discard already-carried velocity.
 */
function rebaseNode(
  id: string,
  target: Omit<ProjectionPlayNode, 'id'>,
  src: ProjectionNodeInit,
  pHat: number,
  correction?: PositionCorrection,
  positionBasisValue = 0,
): ProjectionNodeInit {
  const tc = clamp01(pHat);
  return {
    id,
    parent: target.parent,
    first: boxWithPositionBasis(src, pHat, correction, positionBasisValue),""",
    'driver vector rebase',
)

driver = replace_one(
    driver,
    """interface Flight {
  /** Узлы полёта; Map сохраняет порядок вставки (= порядок resolved-входа). */
  readonly byId: ReadonlyMap<string, ProjectionNodeInit>;
  readonly projector: Projector;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */""",
    """interface Flight {
  /** Узлы полёта; Map сохраняет порядок вставки (= порядок resolved-входа). */
  readonly byId: ReadonlyMap<string, ProjectionNodeInit>;
  /** Physical x/y velocity correction relative to the shared scalar progress. */
  readonly positionCorrectionById: ReadonlyMap<string, PositionCorrection>;
  readonly projector: ProjectionDriverProjector;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */""",
    'driver flight vector state',
)

driver = replace_one(
    driver,
    """  /** Производная видимого p последнего кадра. Покой/cancel = 0. */
  let vHat = 0;
  /** Публичный прогресс — всегда [0,1]. */
  let progress = 1;
  /** Инвалидация кадров перехваченного полёта (класс stale-frame, flip :217-218). */
  let generation = 0;
  /** Переиспользуемый выход солвера (ноль аллокаций на кадр). */
  const solved = { value: 0, velocity: 0 };
""",
    """  /** Производная видимого p последнего кадра. Покой/cancel = 0. */
  let vHat = 0;
  /** Q(t), коэффициент физической начальной скорости для x/y. */
  let positionBasisHat = 0;
  /** Q'(t); нужен для повторного retarget без потери уже перенесённой скорости. */
  let positionBasisVelocityHat = 0;
  /** Публичный прогресс — всегда [0,1]. */
  let progress = 1;
  /** Инвалидация кадров перехваченного полёта (класс stale-frame, flip :217-218). */
  let generation = 0;
  /** Переиспользуемый выход солвера (ноль аллокаций на кадр). */
  const solved = { value: 0, velocity: 0 };
  const springBasis: MutableSpringBasis = {
    _value: 0,
    _valueV0: 0,
    _velocity: 0,
    _velocityV0: 0,
  };
""",
    'driver spring basis state',
)

driver = replace_one(
    driver,
    """  const emit = (projector: Projector, p: number): void => {
    try {
      onFrame?.(projector.at(p));""",
    """  const emit = (
    projector: ProjectionDriverProjector,
    p: number,
    positionBasisValue = 0,
  ): void => {
    try {
      onFrame?.(projector.atBasis(p, positionBasisValue));""",
    'driver emit basis',
)

driver = replace_one(
    driver,
    """    phase = 'rest';
    pHat = 1;
    vHat = 0;
    progress = 1;
    emit(projector, 1);""",
    """    phase = 'rest';
    pHat = 1;
    vHat = 0;
    positionBasisHat = 0;
    positionBasisVelocityHat = 0;
    progress = 1;
    emit(projector, 1, 0);""",
    'driver settle basis reset',
)

driver = replace_one(
    driver,
    """  const startRun = (projector: Projector, v0: number): void => {
    generation++;
    const gen = generation;
    phase = 'active';
    pHat = 0;
    vHat = visibleVelocity(0, v0);
    progress = 0;""",
    """  const startRun = (projector: ProjectionDriverProjector, v0: number): void => {
    generation++;
    const gen = generation;
    phase = 'active';
    pHat = 0;
    vHat = visibleVelocity(0, v0);
    positionBasisHat = 0;
    positionBasisVelocityHat = projector.hasPositionBasis ? 1 : 0;
    progress = 0;""",
    'driver startRun basis init',
)

driver = replace_one(
    driver,
    """      solveSpring(params, elapsed, v0, solved);
      const value = finite(solved.value);
      const velocity = finite(solved.velocity);
      const converged =
        (Math.abs(1 - value) < REST && Math.abs(velocity) < REST) || frames >= MAX_FRAMES;
      if (converged) {
        settle(projector);
        return;
      }
      const p = bounded ? clamp01(value) : value;
      pHat = p;
      vHat = visibleVelocity(value, velocity);
      progress = clamp01(p);
      emit(projector, p);""",
    """      solveSpring(params, elapsed, v0, solved, springBasis);
      const value = finite(solved.value);
      const velocity = finite(solved.velocity);
      const q = projector.hasPositionBasis ? finite(springBasis._valueV0) : 0;
      const qVelocity = projector.hasPositionBasis ? finite(springBasis._velocityV0) : 0;
      const basisConverged =
        !projector.hasPositionBasis || (Math.abs(q) < REST && Math.abs(qVelocity) < REST);
      const converged =
        (Math.abs(1 - value) < REST && Math.abs(velocity) < REST && basisConverged) ||
        frames >= MAX_FRAMES;
      if (converged) {
        settle(projector);
        return;
      }
      const p = bounded ? clamp01(value) : value;
      const basisVisible =
        !bounded ||
        (value > 0 && value < 1) ||
        (value === 0 && velocity >= 0) ||
        (value === 1 && velocity <= 0);
      pHat = p;
      vHat = visibleVelocity(value, velocity);
      positionBasisHat = basisVisible ? q : 0;
      positionBasisVelocityHat = basisVisible ? qVelocity : 0;
      progress = clamp01(p);
      emit(projector, p, positionBasisHat);""",
    'driver tick vector basis',
)

driver = replace_one(
    driver,
    """    emit(projector, 0);
    if (gen === generation && phase === 'active') schedule(tick);""",
    """    emit(projector, 0, 0);
    if (gen === generation && phase === 'active') schedule(tick);""",
    'driver initial emit basis',
)

driver = replace_one(
    driver,
    """      const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;
      const pPrev = pHat;
      const vPrev = vHat;""",
    """      const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;
      const prevPositionCorrections =
        phase !== 'rest' && flight !== null ? flight.positionCorrectionById : undefined;
      const pPrev = pHat;
      const vPrev = vHat;
      const positionBasisPrev = positionBasisHat;
      const positionBasisVelocityPrev = positionBasisVelocityHat;""",
    'driver previous vector state',
)

driver = replace_one(
    driver,
    "return rebaseNode(n.id, n, old, pPrev);",
    """return rebaseNode(
            n.id,
            n,
            old,
            pPrev,
            prevPositionCorrections?.get(n.id),
            positionBasisPrev,
          );""",
    'driver retarget visual pickup',
)

driver = replace_one(
    driver,
    """      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createProjector(resolved);
      const reduced = prefersReducedMotion(options?.matchMedia); // резолв ОДИН раз на play

      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of resolved) byId.set(node.id, node);
      flight = { byId, projector, reduced };""",
    """      // x/y carry their own physical boundary velocity while keeping the
      // shared scalar progress for every existing non-position channel. The
      // correction is zero for unchanged targets, preserving the old bit-path.
      const positionCorrectionById = new Map<string, PositionCorrection>();
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
            positionCorrectionById.set(node.id, correction);
          }
        }
      }

      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createDriverProjector(resolved, positionCorrectionById);
      const reduced = prefersReducedMotion(options?.matchMedia); // резолв ОДИН раз на play

      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of resolved) byId.set(node.id, node);
      flight = { byId, positionCorrectionById, projector, reduced };""",
    'driver correction map and projector',
)

driver = replace_one(
    driver,
    """      phase = 'canceled';
      vHat = 0;
    },""",
    """      phase = 'canceled';
      vHat = 0;
      positionBasisVelocityHat = 0;
    },""",
    'driver cancel vector velocity',
)

driver = replace_one(
    driver,
    """      phase = 'held'; // boxAt/pickup остаются аналитическими, автономных кадров нет
      pHat = pp;
      vHat = 0;
      progress = clamp01(pp);
      emit(flight.projector, pp);""",
    """      phase = 'held'; // boxAt/pickup остаются аналитическими, автономных кадров нет
      pHat = pp;
      vHat = 0;
      positionBasisHat = 0;
      positionBasisVelocityHat = 0;
      progress = clamp01(pp);
      emit(flight.projector, pp, 0);""",
    'driver seek clears inherited basis',
)

driver = replace_one(
    driver,
    """      const rebased: ProjectionNodeInit[] = [];
      for (const n of flight.byId.values()) rebased.push(rebaseNode(n.id, n, n, p0));
      const projector = createProjector(rebased);
      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of rebased) byId.set(node.id, node);
      const reduced = flight.reduced;
      flight = { byId, projector, reduced };""",
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
      const projector = createDriverProjector(rebased, positionCorrectionById);
      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of rebased) byId.set(node.id, node);
      const reduced = flight.reduced;
      flight = { byId, positionCorrectionById, projector, reduced };""",
    'driver release vector rebase',
)

driver = replace_one(
    driver,
    "return phase === 'rest' ? node.last : mixBox(node.first, node.last, pHat);",
    """return phase === 'rest'
        ? node.last
        : boxWithPositionBasis(
            node,
            pHat,
            flight?.positionCorrectionById.get(id),
            positionBasisHat,
          );""",
    'driver boxAt vector state',
)

driver_path.write_text(driver)
