/**
 * projection/driver.ts — headless-драйвер вложенного FLIP (subpath ./projection).
 *
 * ОДНА нормированная пружина 0→1 на весь переход. Обоснование:
 *   1) групповая когерентность — все V от одного p, дерево едет «одним жестом»
 *      (канон Figma smart-animate / Framer projection), tearing родитель/ребёнок
 *      исключён по построению;
 *   2) один вызов солвера на кадр + N дешёвых лерпов;
 *   3) формулы резолва принимают любые согласованные V — пер-узловые пружины
 *      остаются будущим расширением без изменения математики;
 *   4) пер-канальные пружины уже есть в ./animate — дублировать нечего.
 *
 * Сердце — канон solveSpring(params, t, v0) (src/internal/solver.ts:15): v0 ЖИВОЙ.
 * springUnchecked НЕ используется — у него v0 жёстко 0 (src/spring.ts:141-150),
 * это корень отсутствия velocity continuity в ./flip.
 *
 * Velocity continuity при перехвате (спека §2.3.2) остаётся аналитической и
 * без чтений DOM. Scalar channels (w/h/radii/opacity) сохраняют прежний общий
 * progress P(t): доминантный диапазон задаёт bounded v0', а при неизменных целях
 * теорема R'_c=(1−p̂)R_c даёт точный C¹ каждого такого канала.
 *
 * Page-space x/y используют тот же ОДИН solve, но ещё его линейный базис Q(t)
 * по начальной скорости: V_c(t)=first'_c+R'_c·P(t)+u_c·Q(t), Q(0)=0, Q'(0)=1.
 * u_c = v_boundary,c − R'_c·v0' восстанавливается из старых аналитических
 * R·P'(t)+u·Q'(t). Поэтому при смене 2D-цели каждая ось сохраняет собственную
 * физическую boundary velocity; неизменная цель даёт u=0 и остаётся на старом
 * бит-пути. Тот же скорректированный page-space box поступает в parent-space
 * projector, так что отдельного geometry owner/solver/clock не появляется.
 *
 * C⁰: first' — текущий аналитический visual box; radii/opacity ребейзятся тем
 * же scalar P. V0_CAP по-прежнему ограничивает scalar v0' при малом диапазоне.
 *
 * release() после ребейза с НУЛЕВЫМ диапазоном всех каналов всех узлов
 * (|R'| ≤ RANGE_EPSILON, включая radii/opacity) — немедленный settle: один
 * синхронный эмит p=1 + onRest, ноль кадров rAF (двигать нечего — пружинный
 * прогон был бы 2000 пустых кадров).
 *
 * Паттерны-копии: доминантная проекция v0 и normalizeV0/RANGE_EPSILON
 * (animate/channels.ts) — приватны в своих модулях;
 * generation-инвалидация / handle=0-фоллбек / REST / синхронный первый кадр /
 * финал ровно identity (src/flip/index.ts:217-293), prefersReducedMotion
 * (flip :192-199). FIXED_DT_S/MAX_FRAMES — локальные копии по канону «субпути
 * держат СВОИ бюджеты» (докблок src/internal/constants.ts, прецедент
 * FLIP_-копий src/flip/index.ts:186-188): общая константа склеила бы
 * независимые тюнинг-решения.
 *
 * P3 детерминизм: время только из ts кадра либо FIXED_DT; каждый кадр
 * продвигает elapsed ровно на один шаг: ts при известной базе → (ts−lastTs),
 * иначе (без ts ЛИБО без базы) → FIXED_DT; кадр без ts сбрасывает базу
 * (lastTs = undefined) — стык кадров с ts и без не удваивает время. P4 reduce =
 * character-switch: один синхронный эмит identity (p=1) + onRest, ноль кадров rAF.
 */

import { MotionParamError } from '../errors.js';
import type { FlipRect } from '../flip/index.js';
import { solveSpring, type MutableSpringBasis } from '../internal/solver.js';
import type { RequestFrameFn } from '../motion-value.js';
import { type SpringParams, validateSpringForFrameLoop } from '../spring.js';
import {
  boundPositionAxis,
  boundPositionVelocity,
  clamp01,
  createProjector,
  finite,
  lerp1,
  mixBox,
  type BoxRadii,
  type CornerRadius,
  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
} from './geometry.js';

// ─── Публичные типы ──────────────────────────────────────────────────────────

export interface ProjectionOptions {
  /** Default { mass: 1, stiffness: 200, damping: 24 } (= DEFAULT_FLIP_SPRING).
   *  Невалидная → MotionParamError В ФАБРИКЕ (validateSpringForFrameLoop), даже под reduce. */
  readonly spring?: SpringParams | undefined;
  readonly requestFrame?: RequestFrameFn | undefined;
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  /** Кадры полёта. Первый — синхронно при play (анти-мигание, паритет flip :286-287). */
  readonly onFrame?: ((frames: readonly ProjectionFrame[]) => void) | undefined;
  /** Ровно один раз на ЗАВЕРШИВШИЙСЯ полёт (финал — точный identity). cancel НЕ зовёт. */
  readonly onRest?: (() => void) | undefined;
  /** Default FALSE — честный overshoot (осознанное отличие от легаси ./flip; пин-тест).
   *  Размеры флорятся ≥0, opacity clamp01, публичный progress [0,1] — всегда. */
  readonly clamp?: boolean | undefined;
}

export interface ProjectionPlayNode extends Omit<ProjectionNodeInit, 'first'> {
  /** Опционален для id незавершённого полёта: first = аналитический V(p̂) (visual pickup).
   *  Для нового id обязателен: MotionParamError
   *  `projection.play: node "${id}" has no "first" and no active flight to pick up from`. */
  readonly first?: FlipRect | undefined;
}

export interface ProjectionControls {
  /** Старт/перехват. Mid-flight: C⁰ по построению (first' = V(p̂) аналитически, ноль DOM),
   *  C¹ по формуле §2.3.2. Generation-инвалидация кадров старого полёта. */
  play(nodes: readonly ProjectionPlayNode[]): void;
  /** Замораживает текущее аналитическое состояние без финального эмита и onRest.
   *  Повторный play может подхватить его с нулевой скоростью. Идемпотентен. */
  cancel(): void;
  /** Скраб (жест ведёт): гасит пружину (generation++), синхронно эмитит кадры на p
   *  (сырой p при clamp:false; размеры флорятся). Валиден и после rest. Скраб
   *  ДЕРЖИТ полёт (playing = true) — жест обязан завершиться release()/cancel().
   *  На покоящемся контроллере без полёта вовсе — no-op (playing не трогается). */
  seek(p: number): void;
  /** Продолжить пружиной из текущего p с начальной скоростью (progress/s; NaN→0, default 0). */
  release(velocity?: number): void;
  /** Аналитический visual box узла СЕЙЧАС — без чтения DOM.
   *  Rest → last; active/held/canceled → box на p последнего кадра; неизвестный id → undefined. */
  boxAt(id: string): FlipRect | undefined;
  readonly playing: boolean;
  /** Публично всегда [0,1] (канон flip :220), даже при clamp:false. */
  readonly progress: number;
  /** Производная ЭМИТИРУЕМОГО прогресса (1/s). На зажатой clamp-границе и в покое → 0. */
  readonly velocity: number;
}

// ─── Константы (паритет flip :184-190 + пороги continuity) ───────────────────

const DEFAULT_PROJECTION_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 24 };
/** Фиксированный шаг, когда шов не дал timestamp (конвенция driver.ts). */
const FIXED_DT_S = 1 / 60;
/** Потолок кадров — страховка от вечного цикла (конвенция MAX_FRAMES). */
const MAX_FRAMES = 2000;
/** Порог сходимости нормированной пружины (|1−value| и |velocity|) — по НЕклампленному значению. */
const REST = 1e-3;
/** Порог вырожденного диапазона (зеркалит RANGE_EPSILON src/animate/channels.ts:174). */
const RANGE_EPSILON = 1e-10;
/** Потолок |v0'| (progress/s): при p̂ → 1 знаменатель мал — без капа нефизичный рывок. */
const V0_CAP = 1e4;

function clampMagnitude(x: number, cap: number): number {
  return x > cap ? cap : x < -cap ? -cap : x;
}

/** Аналитические радиусы на клампленном t: визуальный радиус СЕЙЧАС = lerp(rF, rL, t). */
function lerpRadii(a: BoxRadii, b: BoxRadii, t: number): BoxRadii {
  const out = [] as unknown as [CornerRadius, CornerRadius, CornerRadius, CornerRadius];
  for (let c = 0; c < 4; c++) {
    out[c] = { x: lerp1(a[c].x, b[c].x, t), y: lerp1(a[c].y, b[c].y, t) };
  }
  return out;
}

interface VectorProjectionNode extends ProjectionNodeInit {
  _qx?: number;
  _qy?: number;
  _qb?: true;
}

function boxWithPositionBasis(src: VectorProjectionNode, pHat: number, q: number): FlipRect {
      const box = mixBox(src.first, src.last, pHat);
      if (q === 0) return box;
      const out = box as { x: number; y: number };
      const x = src._qx ?? 0;
      const y = src._qy ?? 0;
      if (x !== 0) out.x = finite(box.x + x * q) + 0;
      if (y !== 0) out.y = finite(box.y + y * q) + 0;
      if (src._qb === true) {
        out.x = boundPositionAxis(box.x, src.first.x, src.last.x);
        out.y = boundPositionAxis(box.y, src.first.y, src.last.y);
      }
      return box;
    }

/**
 * Ребейз узла на текущем аналитическом visual box. Scalar channels use p̂;
 * page-space x/y additionally include the homogeneous Q(t) basis so repeated
 * retargets never fall back to DOM reads or discard already-carried velocity.
 */
function rebaseNode(
  id: string,
  target: Omit<ProjectionPlayNode, 'id'>,
  src: VectorProjectionNode,
  pHat: number,
  positionBasisValue = 0,
): VectorProjectionNode {
  const tc = clamp01(pHat);
  return {
    id,
    parent: target.parent,
    first: boxWithPositionBasis(src, pHat, positionBasisValue),
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
}

/** |a − b| > RANGE_EPSILON — канал жив. */
function chDiff(a: number, b: number): boolean {
  return Math.abs(a - b) > RANGE_EPSILON;
}

/** true, если хоть один канал узла (бокс, radii, opacity) имеет живой диапазон. */
function hasLiveRange(n: ProjectionNodeInit): boolean {
  if (
    chDiff(n.last.x, n.first.x) ||
    chDiff(n.last.y, n.first.y) ||
    chDiff(n.last.width, n.first.width) ||
    chDiff(n.last.height, n.first.height)
  ) {
    return true;
  }
  const r = n.radii;
  if (r !== undefined) {
    for (let c = 0; c < 4; c++) {
      if (chDiff(r.last[c].x, r.first[c].x) || chDiff(r.last[c].y, r.first[c].y)) return true;
    }
  }
  const o = n.opacity;
  return o !== undefined && chDiff(o.to, o.from);
}

/** Локальная копия паттерна flip :192-199 (duck-typed matchMedia). */
function prefersReducedMotion(
  matchMedia: ((q: string) => { matches: boolean }) | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ─── Драйвер ─────────────────────────────────────────────────────────────────

interface Flight {
  /** Узлы полёта; Map сохраняет порядок вставки (= порядок resolved-входа). */
  readonly byId: ReadonlyMap<string, VectorProjectionNode>;
  readonly projector: Projector;
  readonly vector: boolean;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */
  readonly reduced: boolean;
}

type ProjectionPhase = 'rest' | 'active' | 'held' | 'canceled';

/** Создать headless-контроллер проекции: одна пружина 0→1, синхронные колбэки. */
export function createProjection(options?: ProjectionOptions): ProjectionControls {
  const params = options?.spring ?? DEFAULT_PROJECTION_SPRING;
  // Ранний детерминированный бросок (канон drive/flip) — даже под reduced-motion.
  validateSpringForFrameLoop(params);
  // Clamp-режим: default FALSE — честный overshoot (отличие от легаси ./flip).
  const bounded = options?.clamp === true;
  const requestFrame = options?.requestFrame;
  const onFrame = options?.onFrame;
  const onRest = options?.onRest;

  let flight: Flight | null = null;
  let phase: ProjectionPhase = 'rest';
  /** p последнего кадра (сырой при clamp:false) — сырьё continuity/boxAt. Покой = 1. */
  let pHat = 1;
  /** Производная видимого p последнего кадра. Покой/cancel = 0. */
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


  // Один controller владеет максимум одной физической frame-reservation.
  // Повторный play/cancel/seek меняет только логический callback внутри неё:
  // stale generation не оставляет второй rAF висеть рядом с новым полётом.
  let pendingTick: ((ts?: number) => void) | null = null;
  let frameReserved = false;
  let frameFallback: ReturnType<typeof setTimeout> | null = null;

  const clearFrameFallback = (): void => {
    if (frameFallback === null) return;
    clearTimeout(frameFallback);
    frameFallback = null;
  };

  const clearPendingTick = (): void => {
    pendingTick = null;
  };

  const scheduleFrame = (cb: (ts?: number) => void): void => {
    pendingTick = cb;
    if (frameReserved) return;
    if (requestFrame === undefined) return;

    frameReserved = true;
    let synchronous = true;
    let delivered = false;
    const fire = (ts?: number): void => {
      if (delivered) return;
      if (synchronous) {
        if (frameFallback === null) frameFallback = setTimeout(() => fire(undefined), 0);
        return;
      }
      delivered = true;
      clearFrameFallback();
      frameReserved = false;
      const latest = pendingTick;
      pendingTick = null;
      latest?.(ts);
    };

    let handle: number;
    try {
      handle = requestFrame(fire);
    } catch (error) {
      delivered = true;
      frameReserved = false;
      clearPendingTick();
      clearFrameFallback();
      generation++;
      phase = 'canceled';
      vHat = 0;
      positionBasisVelocityHat = 0;
      throw error;
    }
    synchronous = false;
    if (handle == 0 && frameFallback === null) frameFallback = setTimeout(() => fire(undefined), 0);
  };

  /** Производная clamp(value): вне диапазона она нулевая, на границе зависит от направления. */
  const visibleVelocity = (value: number, velocity: number): number => {
    if (!bounded) return velocity + 0;
    if (value < 0 || value > 1) return 0;
    if (value === 0 && velocity < 0) return 0;
    if (value === 1 && velocity > 0) return 0;
    return velocity + 0;
  };

  /** Исключение пользовательского callback не должно оставлять «играющий» зомби-run. */
  const emit = (
    projector: Projector,
    p: number,
    positionBasisValue = 0,
  ): void => {
    try {
      onFrame?.((projector.at as (p: number, q?: number) => readonly ProjectionFrame[])(p, positionBasisValue));
    } catch (error) {
      generation++;
      phase = 'canceled';
      vHat = 0;
      positionBasisVelocityHat = 0;
      clearPendingTick();
      throw error;
    }
  };

  /**
   * Единый снап в покой (reduce/пустое дерево на play, сходимость полёта,
   * мгновенный release без живого диапазона, отсутствие requestFrame):
   * порядок «эмит → onRest» жёсткий, generation++ глушит stale-кадры.
   * Финальный onFrame может синхронно запустить/отменить новый run —
   * тогда старый onRest stale (гард по gen/phase).
   */
  const settle = (projector: Projector): void => {
    generation++;
    clearPendingTick();
    const gen = generation;
    phase = 'rest';
    pHat = 1;
    vHat = 0;
    positionBasisHat = 0;
    positionBasisVelocityHat = 0;
    progress = 1;
    emit(projector, 1, 0); // финал — РОВНО p = 1 (точный identity)
    if (gen === generation && phase === 'rest') onRest?.();
  };

  const startRun = (projector: Projector, v0: number, vector = false): void => {
    generation++;
    const gen = generation;
    phase = 'active';
    pHat = 0;
    vHat = visibleVelocity(0, v0);
    positionBasisHat = 0;
    positionBasisVelocityHat = vector ? 1 : 0;
    progress = 0;
    let elapsed = 0;
    let lastTs: number | undefined;
    let frames = 0;

    const schedule = (cb: (ts?: number) => void): void => {
      if (requestFrame === undefined) {
        // Без шва и без rAF полёт невозможен честно — identity сразу (канон flip :251-256).
        settle(projector);
        return;
      }
      scheduleFrame(cb);
    };

    const tick = (ts?: number): void => {
      if (gen !== generation || phase !== 'active') return; // stale/отменён/удержан
      // Каждый кадр — ровно один шаг времени: (ts−lastTs) при известной базе,
      // FIXED_DT без ts ЛИБО без базы. Кадр без ts сбрасывает базу — стык
      // ts/без-ts не удваивает elapsed (без сброса следующий ts-кадр посчитал
      // бы весь интервал, уже покрытый FIXED_DT).
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        elapsed += lastTs === undefined ? FIXED_DT_S : Math.max(0, (ts - lastTs) / 1000);
        lastTs = ts;
      } else {
        elapsed += FIXED_DT_S;
        lastTs = undefined;
      }
      frames++;

      // Солвер отдаёт сырые числа — политика стражей на стороне вызывающего
      // (докблок solver.ts); зеркалим clampFinite-политику spring.ts.
      solveSpring(params, elapsed, v0, solved, springBasis);
      const value = finite(solved.value);
      const velocity = finite(solved.velocity);
      const q = vector ? finite(springBasis._valueV0) : 0;
      const qVelocity = vector ? finite(springBasis._velocityV0) : 0;
      const basisConverged =
        !vector || (Math.abs(q) < REST && Math.abs(qVelocity) < REST);
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
      emit(projector, p, positionBasisHat);
      // Callback мог синхронно перехватить run — не оставляем даже один stale request.
      if (gen === generation && phase === 'active') schedule(tick);
    };

    // Первый кадр — синхронно на p=0 (анти-мигание, flip :286-287).
    emit(projector, 0, 0);
    if (gen === generation && phase === 'active') schedule(tick);
  };

  return {
    play(nodes: readonly ProjectionPlayNode[]): void {
      // Незавершённое состояние (active/held/canceled) остаётся аналитическим источником pickup.
      const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;
      const pPrev = pHat;
      const vPrev = vHat;
      const positionBasisPrev = positionBasisHat;
      const positionBasisVelocityPrev = positionBasisVelocityHat;

      // C⁰ всех каналов: visual pickup — first' = V(p̂) аналитически (ноль
      // DOM-чтений), radii.first'/opacity.from' — тем же lerp'ом на clamp01(p̂).
      const resolved: ProjectionNodeInit[] = nodes.map((n) => {
        if (n.first === undefined) {
          const old = prevById?.get(n.id);
          if (old === undefined) {
            throw new MotionParamError('LM078');
          }
          return rebaseNode(n.id, n, old, pPrev, positionBasisPrev);
        }
        // first задан: узел структурно уже ProjectionNodeInit; геометрия читает
        // поля по ссылкам в обоих вариантах — копия объекта ничего не защищала.
        return n as ProjectionNodeInit;
      });

      // C¹: v0' по доминантному каналу ВСЕХ продолжающихся узлов (новые не участвуют —
      // их px/s не определены). Паттерн доминантной проекции + normalizeV0.
      let v0 = 0;
      if (prevById !== undefined && vPrev !== 0) {
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
        for (const node of resolved) {
          const old = prevById.get(node.id);
          if (old === undefined) continue;
          consider(old.last.x - old.first.x, node.last.x - node.first.x);
          consider(old.last.y - old.first.y, node.last.y - node.first.y);
          consider(old.last.width - old.first.width, node.last.width - node.first.width);
          consider(old.last.height - old.first.height, node.last.height - node.first.height);
          // Radii/opacity — полноправные каналы C¹ («всех каналов» — буквально):
          // полёт только по радиусам/фейду не должен терять скорость на перехвате.
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
        if (bestAbs > RANGE_EPSILON) {
          v0 = clampMagnitude(finite((vPrev * bestR) / bestRp), V0_CAP);
        }
      }

      // x/y carry their own physical boundary velocity while scalar channels share P(t).
      let vector = false;
      if (prevById !== undefined) {
        for (let i = 0; i < resolved.length; i++) {
          let node = resolved[i] as VectorProjectionNode;
          const old = prevById.get(node.id);
          if (old === undefined) continue;
          const oldBox = boxWithPositionBasis(old, pPrev, positionBasisPrev);
        const rawVx = finite((old.last.x - old.first.x) * vPrev + (old._qx ?? 0) * positionBasisVelocityPrev);
        const rawVy = finite((old.last.y - old.first.y) * vPrev + (old._qy ?? 0) * positionBasisVelocityPrev);
        const oldVx = old._qb === true ? boundPositionVelocity(oldBox.x, rawVx, old.first.x, old.last.x) : rawVx;
        const oldVy = old._qb === true ? boundPositionVelocity(oldBox.y, rawVy, old.first.y, old.last.y) : rawVy;
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
      const projector = createProjector(resolved);
      const reduced = prefersReducedMotion(options?.matchMedia); // резолв ОДИН раз на play

      const byId = new Map<string, VectorProjectionNode>();
      for (const node of resolved) byId.set(node.id, node as VectorProjectionNode);
      flight = { byId, projector, reduced, vector };

      if (reduced || resolved.length === 0) {
        // P4 character-switch и пустое дерево не требуют автономного кадра:
        // один синхронный точный финал, ноль кадров rAF.
        settle(projector);
        return;
      }

      startRun(projector, v0, vector);
    },

    cancel(): void {
      if (flight === null || phase === 'rest' || phase === 'canceled') return;
      generation++;
      clearPendingTick();
      phase = 'canceled';
      vHat = 0;
      positionBasisVelocityHat = 0;
    },

    /**
     * Скраб: жест ВЕДЁТ полёт и обязан его завершить — release()/cancel().
     * playing остаётся true (нужно boxAt/visual pickup, §4.2): полёт удержан
     * жестом, а не брошен. На покоящемся контроллере БЕЗ полёта вовсе
     * (byId пуст — play не звался) — no-op без перевода playing: скрабить нечего.
     */
    seek(p: number): void {
      if (flight === null) return;
      generation++; // пружина погашена
      clearPendingTick();
      const raw = Number.isNaN(p) ? 0 : p;
      const pp = bounded ? clamp01(raw) : raw;
      phase = 'held'; // boxAt/pickup остаются аналитическими, автономных кадров нет
      pHat = pp;
      vHat = 0;
      positionBasisHat = 0;
      positionBasisVelocityHat = 0;
      progress = clamp01(pp);
      emit(flight.projector, pp, 0);
    },

    release(velocity?: number): void {
      if (flight === null || phase === 'rest') return;
      const p0 = pHat;
      const remaining = finite(1 - p0);

      // В точной цели диапазон ребейза нулевой: нормализовать физическую скорость не к чему.
      // Новый run ничего не может визуально сдвинуть, поэтому честный результат — rest сейчас.
      if (Math.abs(remaining) <= RANGE_EPSILON) {
        settle(flight.projector);
        return;
      }

      // Ребейз как перехват (единая механика rebaseNode, src = сам узел):
      // first' = V(p_seek), radii/opacity — тем же lerp'ом (C⁰ всех каналов;
      // цели не менялись — теорема §2.3.2 даёт точный C¹ при v0 = v/(1−p_seek)).
      const rebased: ProjectionNodeInit[] = [];
      for (const n of flight.byId.values()) {
        rebased.push(rebaseNode(n.id, n, n, p0, positionBasisHat));
      }
      const projector = createProjector(rebased);
      const byId = new Map<string, VectorProjectionNode>();
      for (const node of rebased) byId.set(node.id, node);
      const reduced = flight.reduced;
      flight = { byId, projector, reduced, vector: false };

      if (reduced) {
        // Character-switch удержан: под reduce release снапает (без автономного полёта).
        settle(projector);
        return;
      }

      // Все каналы всех узлов после ребейза нулевые — двигать нечего:
      // мгновенный settle, ноль rAF (фантомный полёт с v0=V0_CAP исключён).
      if (!rebased.some(hasLiveRange)) {
        settle(projector);
        return;
      }

      const v = finite(velocity ?? 0);
      const v0 = clampMagnitude(finite(v / remaining), V0_CAP);
      startRun(projector, v0);
    },

    boxAt(id: string): FlipRect | undefined {
      const node = flight?.byId.get(id);
      if (node === undefined) return undefined;
      return phase === 'rest'
        ? node.last
        : boxWithPositionBasis(node, pHat, positionBasisHat);
    },

    get playing(): boolean {
      return phase === 'active' || phase === 'held';
    },
    get progress(): number {
      return progress;
    },
    get velocity(): number {
      return vHat;
    },
  };
}
