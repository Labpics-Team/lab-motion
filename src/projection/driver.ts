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
 * Velocity continuity при перехвате (спека §2.3.2): скорость канала c ∈ {x,y,w,h}
 * узла аналитична каждый кадр: V̇_c = R_c · ṗ, R_c = L_c − F_c. Пер-боксовые px/s
 * НЕ хранятся — восстанавливаются замкнутой формой (принцип readCompositorSpring,
 * src/compositor/index.ts:369: «состояние никогда не читается из DOM»).
 *   C⁰: first' = mixBox(first, last, p̂) — аналитический visual box, ноль DOM.
 *   C¹: v0'·R'_c = v̂·R_c ⇒ доминантный канал c* = argmax |R'_c| по ВСЕМ
 *       продолжающимся узлам × каналам; v0' = v̂·R_{c*}/R'_{c*} (|R'| ≤ ε → 0),
 *       потолок V0_CAP (при p̂→1 знаменатель (1−p̂) мал — без капа нефизичный рывок).
 *   Теорема: при неизменных целях R'_c = (1−p̂)·R_c для ВСЕХ каналов сразу ⇒
 *   v0' = v̂/(1−p̂) точен для каждого канала каждого узла — точный C¹ всюду,
 *   отдельной ветки в коде нет. При изменённых целях — точный C¹ доминантного,
 *   C⁰ + пропорциональная скорость у остальных (честность WAAPI-групп).
 *
 * Паттерны-копии (НЕ импорты — импорт утянул бы чужой граф при splitting:false):
 * dominantV0 (src/animate/waapi-unit.ts:309-318), normalizeV0/RANGE_EPSILON
 * (src/animate/channels.ts:174-182), generation-инвалидация / handle=0-фоллбек /
 * FIXED_DT / REST / MAX_FRAMES / синхронный первый кадр / финал ровно identity
 * (src/flip/index.ts:217-293), prefersReducedMotion (flip :192-199).
 *
 * P3 детерминизм: время только из ts кадра либо FIXED_DT. P4 reduce =
 * character-switch: один синхронный эмит identity (p=1) + onRest, ноль кадров rAF.
 */

import { MotionParamError } from '../errors.js';
import type { FlipRect } from '../flip/index.js';
import { solveSpring } from '../internal/solver.js';
import type { RequestFrameFn } from '../motion-value.js';
import { type SpringParams, validateSpringParams } from '../spring.js';
import {
  clamp01,
  createProjector,
  finite,
  mixBox,
  type ProjectionFrame,
  type ProjectionNodeInit,
  type Projector,
} from './geometry.js';

// ─── Публичные типы ──────────────────────────────────────────────────────────

export interface ProjectionOptions {
  /** Default { mass: 1, stiffness: 200, damping: 24 } (= DEFAULT_FLIP_SPRING).
   *  Невалидная → MotionParamError В ФАБРИКЕ (validateSpringParams), даже под reduce. */
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
   *  (сырой p при clamp:false; размеры флорятся). Валиден и после rest. */
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
  readonly nodes: readonly ProjectionNodeInit[];
  readonly byId: ReadonlyMap<string, ProjectionNodeInit>;
  readonly projector: Projector;
  /** Character-switch зафиксирован на play (§4.4: смена reduce в полёте не подхватывается). */
  readonly reduced: boolean;
}

type ProjectionPhase = 'rest' | 'active' | 'held' | 'canceled';

/** Создать headless-контроллер проекции: одна пружина 0→1, синхронные колбэки. */
export function createProjection(options?: ProjectionOptions): ProjectionControls {
  const params = options?.spring ?? DEFAULT_PROJECTION_SPRING;
  // Ранний детерминированный бросок (канон drive/flip) — даже под reduced-motion.
  validateSpringParams(params);
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
  /** Публичный прогресс — всегда [0,1]. */
  let progress = 1;
  /** Инвалидация кадров перехваченного полёта (класс stale-frame, flip :217-218). */
  let generation = 0;
  /** Переиспользуемый выход солвера (ноль аллокаций на кадр). */
  const solved = { value: 0, velocity: 0 };

  /** Производная clamp(value): вне диапазона она нулевая, на границе зависит от направления. */
  const visibleVelocity = (value: number, velocity: number): number => {
    if (!bounded) return velocity + 0;
    if (value < 0 || value > 1) return 0;
    if (value === 0 && velocity < 0) return 0;
    if (value === 1 && velocity > 0) return 0;
    return velocity + 0;
  };

  /** Исключение пользовательского callback не должно оставлять «играющий» зомби-run. */
  const emit = (projector: Projector, p: number): void => {
    try {
      onFrame?.(projector.at(p));
    } catch (error) {
      generation++;
      phase = 'canceled';
      vHat = 0;
      throw error;
    }
  };

  const startRun = (projector: Projector, v0: number): void => {
    generation++;
    const gen = generation;
    phase = 'active';
    pHat = 0;
    vHat = visibleVelocity(0, v0);
    progress = 0;
    let elapsed = 0;
    let lastTs: number | undefined;
    let frames = 0;

    const finish = (): void => {
      if (gen !== generation || phase !== 'active') return;
      phase = 'rest';
      pHat = 1;
      vHat = 0;
      progress = 1;
      emit(projector, 1); // финал — РОВНО p = 1 (точный identity)
      // Финальный onFrame может синхронно запустить/отменить новый run: старый onRest stale.
      if (gen === generation && phase === 'rest') onRest?.();
    };

    const schedule = (cb: (ts?: number) => void): void => {
      if (requestFrame === undefined) {
        // Без шва и без rAF полёт невозможен честно — identity сразу (канон flip :251-256).
        finish();
        return;
      }
      const handle = requestFrame(cb);
      if (handle === 0) setTimeout(() => cb(undefined), 0); // non-draining шов (flip :258)
    };

    const tick = (ts?: number): void => {
      if (gen !== generation || phase !== 'active') return; // stale/отменён/удержан
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        elapsed = lastTs === undefined ? elapsed : elapsed + Math.max(0, (ts - lastTs) / 1000);
        lastTs = ts;
      } else {
        elapsed += FIXED_DT_S;
      }
      frames++;

      // Солвер отдаёт сырые числа — политика стражей на стороне вызывающего
      // (докблок solver.ts); зеркалим clampFinite-политику spring.ts.
      solveSpring(params, elapsed, v0, solved);
      const value = finite(solved.value);
      const velocity = finite(solved.velocity);
      const converged =
        (Math.abs(1 - value) < REST && Math.abs(velocity) < REST) || frames >= MAX_FRAMES;
      if (converged) {
        finish();
        return;
      }
      const p = bounded ? clamp01(value) : value;
      pHat = p;
      vHat = visibleVelocity(value, velocity);
      progress = clamp01(p);
      emit(projector, p);
      // Callback мог синхронно перехватить run — не оставляем даже один stale request.
      if (gen === generation && phase === 'active') schedule(tick);
    };

    // Первый кадр — синхронно на p=0 (анти-мигание, flip :286-287).
    emit(projector, 0);
    if (gen === generation && phase === 'active') schedule(tick);
  };

  return {
    play(nodes: readonly ProjectionPlayNode[]): void {
      // Незавершённое состояние (active/held/canceled) остаётся аналитическим источником pickup.
      const prevById = phase !== 'rest' && flight !== null ? flight.byId : undefined;
      const pPrev = pHat;
      const vPrev = vHat;

      // C⁰: visual pickup — first' = V(p̂) аналитически (ноль DOM-чтений).
      const resolved: ProjectionNodeInit[] = nodes.map((n) => {
        let first = n.first;
        if (first === undefined) {
          const old = prevById?.get(n.id);
          if (old === undefined) {
            throw new MotionParamError(
              `projection.play: node "${n.id}" has no "first" and no active flight to pick up from`,
            );
          }
          first = mixBox(old.first, old.last, pPrev);
        }
        return {
          id: n.id,
          parent: n.parent,
          first,
          last: n.last,
          anchor: n.anchor,
          radii: n.radii,
          opacity: n.opacity,
        };
      });

      // C¹: v0' по доминантному каналу ВСЕХ продолжающихся узлов (новые не участвуют —
      // их px/s не определены). Паттерн dominantV0 + normalizeV0 (см. шапку).
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
        }
        if (bestAbs > RANGE_EPSILON) {
          v0 = clampMagnitude(finite((vPrev * bestR) / bestRp), V0_CAP);
        }
      }

      // Валидация дерева — рано, до любых эффектов, даже под reduce.
      const projector = createProjector(resolved);
      const reduced = prefersReducedMotion(options?.matchMedia); // резолв ОДИН раз на play

      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of resolved) byId.set(node.id, node);
      flight = { nodes: resolved, byId, projector, reduced };

      if (reduced || resolved.length === 0) {
        // Reduce и пустое дерево не требуют автономного кадра: один точный финал.
        generation++;
        const gen = generation;
        phase = 'rest';
        pHat = 1;
        vHat = 0;
        progress = 1;
        emit(projector, 1);
        if (gen === generation && phase === 'rest') onRest?.();
        return;
      }

      startRun(projector, v0);
    },

    cancel(): void {
      if (flight === null || phase === 'rest' || phase === 'canceled') return;
      generation++;
      phase = 'canceled';
      vHat = 0;
    },

    seek(p: number): void {
      if (flight === null) return;
      generation++; // пружина погашена
      const raw = Number.isNaN(p) ? 0 : p;
      const pp = bounded ? clamp01(raw) : raw;
      phase = 'held'; // boxAt/pickup остаются аналитическими, автономных кадров нет
      pHat = pp;
      vHat = 0;
      progress = clamp01(pp);
      emit(flight.projector, pp);
    },

    release(velocity?: number): void {
      if (flight === null || phase === 'rest') return;
      const p0 = pHat;
      const remaining = finite(1 - p0);

      // В точной цели диапазон ребейза нулевой: нормализовать физическую скорость не к чему.
      // Новый run ничего не может визуально сдвинуть, поэтому честный результат — rest сейчас.
      if (Math.abs(remaining) <= RANGE_EPSILON) {
        generation++;
        const gen = generation;
        phase = 'rest';
        pHat = 1;
        vHat = 0;
        progress = 1;
        emit(flight.projector, 1);
        if (gen === generation && phase === 'rest') onRest?.();
        return;
      }

      // Ребейз как перехват: first' = V(p_seek) для всех узлов (цели не менялись —
      // теорема §2.3.2 даёт точный C¹ всех каналов при v0 = v/(1−p_seek)).
      const rebased: ProjectionNodeInit[] = flight.nodes.map((n) => ({
        ...n,
        first: mixBox(n.first, n.last, p0),
      }));
      const projector = createProjector(rebased);
      const byId = new Map<string, ProjectionNodeInit>();
      for (const node of rebased) byId.set(node.id, node);
      const reduced = flight.reduced;
      flight = { nodes: rebased, byId, projector, reduced };

      if (reduced) {
        // Character-switch удержан: под reduce release снапает (без автономного полёта).
        generation++;
        const gen = generation;
        phase = 'rest';
        pHat = 1;
        vHat = 0;
        progress = 1;
        emit(projector, 1);
        if (gen === generation && phase === 'rest') onRest?.();
        return;
      }

      const v = finite(velocity ?? 0);
      const v0 = clampMagnitude(finite(v / remaining), V0_CAP);
      startRun(projector, v0);
    },

    boxAt(id: string): FlipRect | undefined {
      const node = flight?.byId.get(id);
      if (node === undefined) return undefined;
      return phase === 'rest' ? node.last : mixBox(node.first, node.last, pHat);
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
