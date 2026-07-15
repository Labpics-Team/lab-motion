/**
 * animate/live.ts — композируемый живой движок ./animate (срез R3c-1).
 *
 * Исполняет группы, не представимые синхронной WAAPI-кривой (среды без WAAPI,
 * jsdom-харнессы, разошедшиеся v0, перебор бюджета сетки). Регистрация —
 * опцией фасада: `animate(el, props, { engine: liveEngine })`; базовый граф
 * не несёт ни байта этого модуля (tree-shakeable по построению: ни одного
 * runtime-импорта отсюда в базе).
 *
 * Клауза «не переписывать солвер»: пружинные полосы — тонкий адаптер над
 * публичным ядром MotionValue (тот же аналитический солвер, smooth-pickup,
 * финитные стражи); tween — микро-вычисление прогресса без физики. Полосы НЕ
 * крутят собственных циклов: ран владеет ЕДИНСТВЕННОЙ requestFrame-подпиской
 * на кадр (канон «N полос — один шов») и кормит MotionValue синтетическими
 * timestamp'ами ЛОКАЛЬНОГО времени полосы. Эпоха MotionValue якорится в нуле
 * активной фазы, поэтому elapsed солвера == локальное время: позиция и
 * скорость аналитичны в любой момент (замкнутая форма, не интегрирование),
 * а seek пружинной полосы — это просто подача нужного ts.
 *
 * Субкадровая фаза delay/stagger — порт #169/#174 (эталон: main-unit):
 *   local = logical − anchor. Кадровые дельты накапливаются в signed-фазе
 *   _phaseMs, стартующей с −delayMs (первый ts — анкер, dt=0; нефинитный ts
 *   или переполнившаяся дельта — ровно один fixed-step со сбросом анкера;
 *   отрицательная дельта клампится в 0 и не откатывает фазу). Пересечение
 *   нуля активирует полосы С ПОЛНЫМ frame-overshoot: полоса стартует с точной
 *   субкадровой фазы delay/stagger, а не «тиком после делэя». Хранится именно
 *   signed-фаза, а не пара (logical, anchor): после seek у IEEE-границы
 *   вычитание двух почти равных MAX-чисел стёрло бы малую локальную фазу.
 *   Активация — ТОЛЬКО по фактическому знаку фазы (исторический порог
 *   «wallMs + 16ms >= delay» из #174 сюда не возвращать).
 *   pause исключает wall-gap (play заново якорит dt), seek переносит anchor
 *   локальной координатой БЕЗ отката logical-времени и без пересева
 *   MotionValue-ранов (их elapsed — то же локальное время).
 *
 * Кадровая дисциплина: все полосы группы тикают одним локальным ts; DOM
 * пишется один раз на кадр на канал группы (атомарный transform-вектор +
 * css-эмит). Инлайн-стиль на каждом кадре — он же «hold» при прерывании:
 * _supersede без replacement не мигает к базе.
 *
 * Ограничения (директива R3a, живут в композируемом css-модуле):
 *   - css-полоса без formatCssAt-шва пишет только финал (C⁰-дискретно);
 *   - скоростная проекция css (projectCssV0-канон) не выполняется — v0
 *     прогресс-полосы css всегда 0; снимок середины css-полосы отдаёт
 *     точную пару (p, ṗ) для C⁰-непрерывности значения через шов.
 */

import { FIXED_DT_S, MAX_FRAMES } from '../internal/constants.js';
import { MotionValue } from '../motion-value.js';
import { buildTransform } from '../value/transform.js';
import type { PlannedLiveGroup } from './compositor-plan.js';
import type {
  AnimateEngine,
  AnimateEngineContext,
  AnimateEngineRun,
  RequestFrameFn,
} from './index.js';
import type { ProgressSnapshot } from './compositor-unit.js';

const FIXED_DT_MS = FIXED_DT_S * 1000;

/** Шаг центральной разности производной изинга (канон main-лейнов #174). */
const EASE_DERIV_H = 1e-3;

/**
 * Порог покоя MotionValue (EPSILON ядра): суб-эпсилон импульс на нулевом
 * спане — покой. Без этого гарда setTarget проглотил бы полосу своим
 * snap-if-at-rest и подвесил finished (полоса без единого эмита).
 */
const REST_EPSILON = 1e-10;

/** Канон channelAt старых лейнов: взвешенная форма не переполняется на
 *  MAX ↔ −MAX (никакой «телепортации» в цель), края — точные операнды. */
function laneAt(from: number, to: number, p: number): number {
  if (p === 1) return to;
  if (p === 0 || from === to) return from;
  const value = (1 - p) * from + p * to;
  return Number.isFinite(value) ? value : to;
}

function defaultRequestFrame(cb: (ts?: number) => void): number {
  const raf = (globalThis as {
    requestAnimationFrame?: (cb: (ts?: number) => void) => number;
  }).requestAnimationFrame;
  if (typeof raf === 'function') return raf(cb);
  return setTimeout(cb, FIXED_DT_MS) as unknown as number;
}

/** Полоса живого прогона: движущийся числовой канал на MotionValue. */
interface LiveLane {
  readonly _key: string;
  readonly _from: number;
  readonly _to: number;
  readonly _mv: MotionValue;
  _settled: boolean;
  /** Оседание уже учтено в _pending (сметается кадровым sweep'ом). */
  _reported: boolean;
}

class LiveRun implements AnimateEngineRun {
  readonly finished: Promise<void>;

  private readonly _group: PlannedLiveGroup;
  private readonly _context: AnimateEngineContext;
  /** Полное состояние transform-группы: residuals + анимируемые каналы. */
  private readonly _state: Record<string, number> = {};
  private readonly _lanes: LiveLane[] = [];
  private _cssProgress: MotionValue | undefined;
  private _resolve!: () => void;
  private _done = false;
  private _paused = false;
  private _started = false;
  private _pending = 0;

  // ── Логические часы рана (порт #169/#174) ─────────────────────────────────
  /** Signed local phase: local = max(0, _phaseMs); рождается в −delayMs. */
  private _phaseMs: number;
  private _lastTs: number | undefined;
  /** Кадры активной фазы — страховка замёрзших host-часов (канон MAX_FRAMES). */
  private _frames = 0;
  /** Глушит кадры, выданные до pause/cancel (у RequestFrameFn нет отмены). */
  private _generation = 0;

  // ── Синтетический кадровый шов полос ──────────────────────────────────────
  /** Тики, которые MotionValue-полосы попросили на следующий кадр (один
   *  переиспользуемый контейнер: горячий кадр не аллоцирует). */
  private readonly _laneTicks: Array<(ts?: number) => void> = [];
  private readonly _laneFrame: RequestFrameFn = (cb) => {
    this._laneTicks.push(cb);
    return 1; // ненулевой handle: MotionValue не строит setTimeout-fallback
  };

  // ── Кадровые dirty-флаги: одна DOM-запись на канал на кадр ────────────────
  private _numericDirty = false;
  private _cssAt: number | undefined;
  private _cssFinal = false;
  private _cssSettled = false;
  private _cssReported = false;

  // ── Кэш последнего РЕНДЕРЕННОГО tween-кадра (снимок не пере-зовёт ease) ───
  private _renderedK = 0;
  private _renderedP = 0;
  /** Производная в _renderedK: NaN = не вычислена (канон _tweenDpdt #174). */
  private _renderedDpdt = Number.NaN;

  constructor(group: PlannedLiveGroup, context: AnimateEngineContext) {
    this._group = group;
    this._context = context;
    this._phaseMs = -group._delayMs;
    this.finished = new Promise<void>((resolve) => {
      this._resolve = resolve;
    });
    group._residuals.forEach((value, key) => {
      this._state[key] = value;
    });
    for (const ch of group._numeric) this._state[ch._key] = ch._from;

    // Полосы создаются лениво-неподвижными: MotionValue не тикает до
    // setTarget, поэтому конструктор не эмитит кадров (фаза commit фасада).
    if (context.mode.kind === 'spring') {
      const spring = context.mode.spring;
      for (const ch of group._numeric) {
        // Статичный канал; суб-эпсилон импульс на нулевом спане — тоже покой.
        if (ch._from === ch._to && Math.abs(ch._velocity) < REST_EPSILON) continue;
        const value = new MotionValue({
          initial: ch._from,
          spring,
          requestFrame: this._laneFrame,
          initialVelocity: ch._velocity,
          clamp: false, // честная траектория: перелёт эмитится
        });
        this._lanes.push({
          _key: ch._key,
          _from: ch._from,
          _to: ch._to,
          _mv: value,
          _settled: false,
          _reported: false,
        });
      }
      if (group._css !== undefined) {
        this._cssProgress = new MotionValue({
          initial: 0,
          spring,
          requestFrame: this._laneFrame,
          clamp: false,
        });
      }
    }
    this._pending = this._lanes.length
      + (this._cssProgress !== undefined ? 1 : 0)
      + (context.mode.kind === 'tween' ? 1 : 0);

    if (this._pending === 0) {
      // Вся группа статична: финал пишется немедленно, кадры не нужны.
      this._writeNumeric();
      this._writeCssFinal();
      this._finish();
      return;
    }

    // Подписки полос: немедленный emit MotionValue глушится (поза from уже
    // в _state), запись в DOM делает кадровый flush — не каждый emit.
    for (const lane of this._lanes) {
      let armed = false;
      lane._mv.onChange((value) => {
        if (!armed || this._done || lane._settled) return;
        this._state[lane._key] = value;
        this._numericDirty = true;
        // Канон settle MotionValue: финальный emit — ровно target, скорость 0.
        if (value === lane._to && lane._mv.velocity === 0 && this._started) {
          lane._settled = true;
        }
      });
      armed = true;
    }
    const cssProgress = this._cssProgress;
    if (cssProgress !== undefined) {
      let armed = false;
      cssProgress.onChange((p) => {
        if (!armed || this._done || this._cssSettled) return;
        if (p === 1 && cssProgress.velocity === 0 && this._started) {
          this._cssSettled = true;
          this._cssFinal = true;
          return;
        }
        this._cssAt = p;
      });
      armed = true;
    }
    this._arm();
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  play(): void {
    if (this._done || !this._paused) return;
    this._paused = false;
    // Wall-gap исключается: следующий host-ts — новый анкер (dt = 0).
    this._lastTs = undefined;
    try {
      this._arm();
    } catch (error) {
      // Неудачный host-schedule восстанавливает paused и допускает повтор.
      this._paused = true;
      throw error;
    }
  }

  pause(): void {
    if (this._done || this._paused) return;
    this._paused = true;
    // Уже выданный host-кадр глохнет поколением. Полосы НЕ stop()-аются:
    // их elapsed — локальное время, пауза просто перестаёт его кормить,
    // поэтому resume продолжает ту же аналитическую траекторию (C¹ точно).
    this._generation++;
  }

  /**
   * Перемотка к локальному времени полосы (мс активной фазы, канон
   * main-лейнов): logical-часы не откатываются, anchor переносится
   * (следующий host-ts — dt=0), остаток delay снимается — seek активирует
   * полосу. Пружинные полосы перематываются аналитически: локальное время
   * подаётся синтетическим ts, солвер решает замкнутой формой.
   */
  seek(tMs: number): void {
    if (this._done || !Number.isFinite(tMs)) return;
    const localMs = Math.max(0, tMs);
    this._phaseMs = localMs;
    this._lastTs = undefined;
    this._runAt(localMs);
  }

  cancel(): void {
    if (this._done) return;
    // Инлайн-стиль уже держит последнюю позу — доп. записей не нужно.
    this._finish();
  }

  // ── Владение (протокол PlanGroupOwner) ────────────────────────────────────

  _supersede(replacement?: () => void): void {
    if (this._done) {
      replacement?.();
      return;
    }
    // Successor пишет первым; наши полосы глохнут без отката позы —
    // непрерывность обеспечивает уже записанный инлайн-стиль.
    replacement?.();
    this._finish();
  }

  _rollback(): void {
    this._finish();
  }

  /** Прогресс-снимок для C¹-подхвата следующим планом. */
  _snapshot(): ProgressSnapshot {
    // Полоса до активации неподвижна: capture-до-delay отдаёт покой
    // (посеянный initialVelocity — стартовое условие, не текущее движение).
    if (!this._started) return { _value: 0, _velocity: 0 };
    if (this._context.mode.kind === 'tween') {
      const mode = this._context.mode;
      // Значение — кэш последнего рендеренного кадра (ease не пере-зовётся);
      // производная — центральная разность с окном, поджатым внутрь [0,1]
      // (изинги клампят снаружи — разность через край сломала бы наклон),
      // вычисляется один раз на рендеренный k (канон _tweenDpdt: повторный
      // снимок того же кадра не пере-зовёт opaque ease).
      if (Number.isNaN(this._renderedDpdt)) {
        const k = this._renderedK;
        const k0 = k > EASE_DERIV_H ? k - EASE_DERIV_H : 0;
        const k1 = k + EASE_DERIV_H < 1 ? k + EASE_DERIV_H : 1;
        const slope = (mode.ease(k1) - mode.ease(k0)) / (k1 - k0);
        // Наклон по k → прогресс/с; враждебная производная не сеется в v0.
        this._renderedDpdt = Number.isFinite(slope)
          ? slope / (mode.durationMs / 1000)
          : 0;
      }
      return { _value: this._renderedP, _velocity: this._renderedDpdt };
    }
    // Пружина: прогресс-пространство первой движущейся полосы (sharedV0-группы
    // делят прогресс; v0-mismatch группы честно отдают доминантную полосу).
    const lane = this._lanes[0];
    if (lane === undefined) {
      // Чисто css-группа: точная пара (p, ṗ) прогресс-полосы — C⁰ значения
      // идёт через шов formatCssAt, скорость css планировщик не проецирует.
      const cssProgress = this._cssProgress;
      if (cssProgress !== undefined) {
        return { _value: cssProgress.value, _velocity: cssProgress.velocity };
      }
      return { _value: 1, _velocity: 0 };
    }
    const range = lane._to - lane._from;
    if (range === 0) return { _value: 1, _velocity: 0 };
    return {
      _value: (lane._mv.value - lane._from) / range,
      _velocity: lane._mv.velocity / range,
    };
  }

  // ── Кадровый цикл ─────────────────────────────────────────────────────────

  private _arm(): void {
    const generation = this._generation;
    (this._context.requestFrame ?? defaultRequestFrame)(
      (ts) => this._step(ts, generation),
    );
  }

  private _step(ts: number | undefined, generation: number): void {
    if (this._done || this._paused || generation !== this._generation) return;
    let dt: number;
    if (ts === undefined || !Number.isFinite(ts)) {
      // Кадр без ts / нефинитный ts: ровно один fixed-step, анкер сброшен.
      dt = FIXED_DT_MS;
      this._lastTs = undefined;
    } else {
      dt = this._lastTs === undefined ? 0 : ts - this._lastTs;
      this._lastTs = ts;
      if (!Number.isFinite(dt)) {
        // Переполнение конечной дельты (±MAX-скачок) — один fixed-step.
        dt = FIXED_DT_MS;
        this._lastTs = undefined;
      }
    }
    if (dt < 0) dt = 0; // регресс host-часов не откатывает локальную фазу
    this._phaseMs += dt;
    if (this._phaseMs >= 0) {
      this._frames++;
      this._runAt(Math.max(0, this._phaseMs));
    }
    if (!this._done && !this._paused) this._arm();
  }

  /** Кадр в локальном времени tMs: активация, тики полос, один flush в DOM. */
  private _runAt(tMs: number): void {
    const mode = this._context.mode;
    if (mode.kind === 'tween') {
      this._started = true;
      // Страховка замёрзших host-часов — канон MAX_FRAMES ядра.
      const frozen = this._frames >= MAX_FRAMES && tMs <= 0;
      this._tweenFrame(frozen ? mode.durationMs : tMs);
      return;
    }
    if (!this._started) {
      this._started = true;
      // Активация: setTarget подхватывает посеянный initialVelocity полос
      // (C¹-подхват), анкерный тик 0 якорит эпоху солвера в нуле фазы, тик
      // tMs доносит точный субкадровый overshoot пересечения delay.
      for (const lane of this._lanes) lane._mv.setTarget(lane._to);
      this._cssProgress?.setTarget(1);
      this._tickLanes(0);
      if (tMs > 0) this._tickLanes(tMs);
    } else {
      this._tickLanes(tMs);
    }
    this._flushWrites();
    this._sweepSettled();
  }

  /** Кормит полосы одним локальным ts: атомарный вектор одного времени. */
  private _tickLanes(tMs: number): void {
    const ticks = this._laneTicks;
    const count = ticks.length;
    if (count === 0) return;
    // Голова исполняется, re-schedule полос прибывает в хвост ТОГО ЖЕ
    // массива — горячий кадр не аллоцирует контейнеров (канон hot-path).
    for (let i = 0; i < count; i++) ticks[i]!(tMs);
    const remaining = ticks.length - count;
    for (let i = 0; i < remaining; i++) ticks[i] = ticks[count + i]!;
    ticks.length = remaining;
  }

  /** Кадр tween: точный ease-прогресс по всем каналам группы, один вызов ease. */
  private _tweenFrame(tMs: number): void {
    const mode = this._context.mode;
    if (mode.kind !== 'tween') return;
    if (tMs >= mode.durationMs) {
      // Натуральное завершение: точные финальные операнды, ease не зовётся.
      this._renderedK = 1;
      this._renderedP = 1;
      this._renderedDpdt = Number.NaN;
      for (const ch of this._group._numeric) this._state[ch._key] = ch._to;
      this._writeNumeric();
      this._writeCssFinal();
      if (--this._pending <= 0) this._finish();
      return;
    }
    const k = tMs / mode.durationMs;
    // Враждебный ease (NaN/∞) → линейный кадр (контракт старых tween-лейнов);
    // производная такого кадра не сеется в подхват (гард снимка выше).
    const raw = mode.ease(k);
    const p = Number.isFinite(raw) ? raw : k;
    this._renderedK = k;
    this._renderedP = p;
    this._renderedDpdt = Number.NaN;
    for (const ch of this._group._numeric) {
      this._state[ch._key] = laneAt(ch._from, ch._to, p);
    }
    this._writeNumeric();
    this._writeCssAt(p);
  }

  /** Одна DOM-запись на канал на кадр: собранный вектор + css-эмит. */
  private _flushWrites(): void {
    if (this._numericDirty) {
      this._numericDirty = false;
      this._writeNumeric();
    }
    if (this._cssFinal) {
      this._cssFinal = false;
      this._cssAt = undefined;
      this._writeCssFinal();
    } else if (this._cssAt !== undefined) {
      const p = this._cssAt;
      this._cssAt = undefined;
      this._writeCssAt(p);
    }
  }

  /** Учитывает осевшие полосы ПОСЛЕ финальной записи кадра. */
  private _sweepSettled(): void {
    if (this._done) return;
    let settled = 0;
    for (const lane of this._lanes) {
      if (lane._settled && !lane._reported) {
        lane._reported = true;
        settled++;
      }
    }
    if (this._cssSettled && !this._cssReported) {
      this._cssReported = true;
      settled++;
    }
    if (settled > 0 && (this._pending -= settled) <= 0) this._finish();
  }

  private _writeNumeric(): void {
    const group = this._group;
    if (group._numeric.length === 0) return;
    try {
      if (group._group === 'transform') {
        group._el.style.setProperty('transform', buildTransform(this._state));
      } else {
        group._el.style.setProperty(
          group._group,
          String(this._state[group._numeric[0]!._key]),
        );
      }
    } catch {
      /* hostile style не роняет кадровую полосу */
    }
  }

  private _writeCssAt(p: number): void {
    const css = this._group._css;
    if (css === undefined) return;
    // Без шва середина не представима — пишется только финал (C⁰-дискретно).
    const value = this._context.formatCssAt?.(css._from, css._to, p);
    if (value === undefined) return;
    try {
      this._group._el.style.setProperty(this._group._group, String(value));
    } catch {
      /* hostile style не роняет кадровую полосу */
    }
  }

  private _writeCssFinal(): void {
    const css = this._group._css;
    if (css === undefined) return;
    try {
      this._group._el.style.setProperty(this._group._group, String(css._to));
    } catch {
      /* hostile style не роняет терминализацию */
    }
  }

  private _finish(): void {
    if (this._done) return;
    this._done = true;
    this._generation++;
    for (const lane of this._lanes) lane._mv.destroy();
    this._cssProgress?.destroy();
    this._laneTicks.length = 0;
    this._resolve();
  }
}

/** Эталонный живой движок: `animate(el, props, { engine: liveEngine })`. */
export const liveEngine: AnimateEngine = (group, context) =>
  new LiveRun(group, context);
