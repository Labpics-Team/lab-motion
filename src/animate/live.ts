/**
 * animate/live.ts — композируемый живой движок ./animate (срез R3b).
 *
 * Исполняет группы, не представимые синхронной WAAPI-кривой (среды без WAAPI,
 * jsdom-харнессы, разошедшиеся v0, перебор бюджета сетки). Регистрация —
 * опцией фасада: `animate(el, props, { engine: liveEngine })`; базовый граф
 * не несёт ни байта этого модуля (tree-shakeable по построению: ни одного
 * runtime-импорта отсюда в базе).
 *
 * Клауза «не переписывать солвер»: пружинные полосы — тонкий адаптер над
 * публичным ядром MotionValue (тот же аналитический солвер, smooth-pickup,
 * финитные стражи); tween — микро-цикл прогресса без физики (ease-функция
 * не солвер). Инлайн-стиль пишется на каждый кадр — он же и есть «hold» при
 * прерывании: _supersede без replacement не мигает к базе.
 *
 * Ограничения v1 (документированный контракт, добор — R3c):
 *   - seek точен для tween; для пружинных полос — no-op (аналитическая
 *     перемотка MotionValue не экспонирована публичным ядром);
 *   - css-полоса без formatCssAt-шва пишет только финал (C⁰-дискретно);
 *   - скоростная проекция css (projectCssV0-канон) не выполняется — v0
 *     прогресс-полосы css всегда 0 (политика R3a).
 */

import { MotionValue } from '../motion-value.js';
import { buildTransform } from '../value/transform.js';
import type { PlannedLiveGroup } from './compositor-plan.js';
import type {
  AnimateEngine,
  AnimateEngineContext,
  AnimateEngineRun,
} from './index.js';
import type { ProgressSnapshot } from './compositor-unit.js';

/** Полоса живого прогона: движущийся числовой канал на MotionValue. */
interface LiveLane {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly value: MotionValue;
  settled: boolean;
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
  /** Остаток кадровой задержки до старта полос (мс). */
  private _delayLeft = 0;
  /** Tween-прогресс: единственный источник — накопленные кадровые дельты. */
  private _tweenElapsed = 0;
  private _tweenGeneration = 0;

  constructor(group: PlannedLiveGroup, context: AnimateEngineContext) {
    this._group = group;
    this._context = context;
    this.finished = new Promise<void>((resolve) => {
      this._resolve = resolve;
    });
    group.residuals.forEach((value, key) => {
      this._state[key] = value;
    });
    for (const ch of group.numeric) this._state[ch.key] = ch.from;

    // Полосы создаются лениво-неподвижными: MotionValue не тикает до
    // setTarget, поэтому конструктор не эмитит кадров (фаза commit фасада).
    if (context.mode.kind === 'spring') {
      const spring = context.mode.spring;
      for (const ch of group.numeric) {
        if (ch.from === ch.to && ch.velocity === 0) continue; // статичный канал
        const value = new MotionValue({
          initial: ch.from,
          spring,
          requestFrame: context.requestFrame,
          initialVelocity: ch.velocity,
          clamp: false, // честная траектория: перелёт эмитится
        });
        this._lanes.push({ key: ch.key, from: ch.from, to: ch.to, value, settled: false });
      }
      if (group.css !== undefined) {
        this._cssProgress = new MotionValue({
          initial: 0,
          spring,
          requestFrame: context.requestFrame,
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
    if (group.delayMs > 0) {
      // Задержка живёт на кадровых дельтах (канон main-лейнов): шаг-часы
      // харнессов и живой rAF детерминированно делят одну шкалу.
      this._delayLoop();
    } else {
      this._start();
    }
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  play(): void {
    if (this._done || !this._paused) return;
    this._paused = false;
    if (!this._started) {
      // Остаток delay добирается тем же кадровым циклом.
      if (this._delayLeft > 0) this._delayLoop();
      else this._start();
      return;
    }
    // C¹-резюме: setTarget подхватывает сохранённую скорость полосы.
    for (const lane of this._lanes) {
      if (!lane.settled) lane.value.setTarget(lane.to);
    }
    this._cssProgress?.setTarget(1);
    if (this._context.mode.kind === 'tween') this._startTweenLoop();
  }

  pause(): void {
    if (this._done || this._paused) return;
    this._paused = true;
    if (!this._started) {
      // Пауза в delay-фазе: кадровый цикл сам заглохнет по флагу,
      // накопленный остаток задержки сохранён в _delayLeft.
      return;
    }
    for (const lane of this._lanes) lane.value.stop();
    this._cssProgress?.stop();
    // Tween: elapsed уже накоплен кадрами; поколение глушит висящий кадр.
    if (this._context.mode.kind === 'tween') this._tweenGeneration++;
  }

  /** Точен для tween; для пружинных полос — документированный no-op (v1). */
  seek(tMs: number): void {
    if (this._done || !Number.isFinite(tMs)) return;
    if (this._context.mode.kind !== 'tween' || !this._started) return;
    this._tweenElapsed = Math.max(0, tMs - this._group.delayMs);
    this._tweenWrite(this._tweenElapsed);
    if (!this._paused) this._startTweenLoop();
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
    if (this._context.mode.kind === 'tween') {
      const duration = this._context.mode.durationMs;
      const u = Math.min(1, Math.max(0, this._tweenElapsed / duration));
      const ease = this._context.mode.ease;
      const h = 1e-4;
      const rawValue = ease(u);
      const value = Number.isFinite(rawValue) ? rawValue : u; // линейный гард
      const slope = (ease(Math.min(1, u + h)) - ease(Math.max(0, u - h)))
        / (Math.min(1, u + h) - Math.max(0, u - h) || 1);
      return {
        value,
        velocity: Number.isFinite(slope) ? slope / (duration / 1000) : 0,
      };
    }
    // Пружина: прогресс-пространство первой движущейся полосы (sharedV0-группы
    // делят прогресс; v0-mismatch группы честно отдают доминантную полосу).
    const lane = this._lanes[0];
    if (lane === undefined) return { value: 1, velocity: 0 };
    const range = lane.to - lane.from;
    if (range === 0) return { value: 1, velocity: 0 };
    return {
      value: (lane.value.value - lane.from) / range,
      velocity: lane.value.velocity / range,
    };
  }

  // ── Приватное ─────────────────────────────────────────────────────────────

  private _requestFrame(): (cb: (ts?: number) => void) => number {
    return this._context.requestFrame
      ?? ((cb: (ts?: number) => void): number => {
        const raf = (globalThis as {
          requestAnimationFrame?: (cb: (ts?: number) => void) => number;
        }).requestAnimationFrame;
        if (typeof raf === 'function') return raf(cb);
        return setTimeout(cb, 16) as unknown as number;
      });
  }

  /** Кадровая задержка: тот же ts-дельта-канон, что и tween-цикл. */
  private _delayLoop(): void {
    if (this._delayLeft <= 0) this._delayLeft = this._group.delayMs;
    const requestFrame = this._requestFrame();
    let lastTs: number | undefined;
    const step = (ts?: number): void => {
      if (this._done || this._paused || this._started) return;
      if (ts !== undefined) {
        if (lastTs !== undefined) this._delayLeft -= ts - lastTs;
        lastTs = ts;
      } else {
        this._delayLeft -= 1000 / 60;
      }
      if (this._delayLeft <= 0) {
        this._start();
        return;
      }
      requestFrame(step);
    };
    requestFrame(step);
  }

  private _start(): void {
    if (this._done || this._started || this._paused) return;
    this._started = true;
    if (this._context.mode.kind === 'tween') {
      this._startTweenLoop();
      return;
    }
    for (const lane of this._lanes) {
      // Подписочный emit MotionValue (текущее значение немедленно) глушится:
      // серия кадров группы начинается с ПЕРВОГО тика (канон main-харнессов),
      // а поза from уже лежит в _state с конструктора.
      let armed = false;
      lane.value.onChange((value) => {
        if (!armed || this._done || lane.settled) return;
        this._state[lane.key] = value;
        this._writeNumeric();
        // Канон settle MotionValue: финальный emit — ровно target, скорость 0.
        if (value === lane.to && lane.value.velocity === 0 && this._started) {
          lane.settled = true;
          this._laneDone();
        }
      });
      armed = true;
      lane.value.setTarget(lane.to);
    }
    const cssProgress = this._cssProgress;
    if (cssProgress !== undefined) {
      let armed = false;
      cssProgress.onChange((p) => {
        if (!armed || this._done) return;
        if (p === 1 && cssProgress.velocity === 0 && this._started) {
          this._writeCssFinal();
          this._laneDone();
          return;
        }
        this._writeCssAt(p);
      });
      armed = true;
      cssProgress.setTarget(1);
    }
  }

  private _startTweenLoop(): void {
    const generation = ++this._tweenGeneration;
    const mode = this._context.mode;
    if (mode.kind !== 'tween') return;
    const requestFrame = this._context.requestFrame
      ?? ((cb: (ts?: number) => void): number => {
        const raf = (globalThis as {
          requestAnimationFrame?: (cb: (ts?: number) => void) => number;
        }).requestAnimationFrame;
        if (typeof raf === 'function') return raf(cb);
        return setTimeout(cb, 16) as unknown as number;
      });
    // Elapsed накапливается кадровыми дельтами host-timestamp (канон
    // MotionValue: первый ts — эпоха, кадр без ts — фиксированный шаг):
    // детерминизм step-clock харнессов и живого rAF одинаков.
    let lastTs: number | undefined;
    const step = (ts?: number): void => {
      if (this._done || this._paused || generation !== this._tweenGeneration) return;
      if (ts !== undefined) {
        if (lastTs !== undefined) this._tweenElapsed += ts - lastTs;
        lastTs = ts;
      } else {
        this._tweenElapsed += 1000 / 60;
      }
      if (this._tweenElapsed >= mode.durationMs) {
        this._tweenWrite(mode.durationMs);
        this._laneDone();
        return;
      }
      this._tweenWrite(this._tweenElapsed);
      requestFrame(step);
    };
    requestFrame(step);
  }

  /** Кадр tween: точный ease-прогресс по всем каналам группы. */
  private _tweenWrite(elapsedMs: number): void {
    const mode = this._context.mode;
    if (mode.kind !== 'tween') return;
    const u = Math.min(1, Math.max(0, elapsedMs / mode.durationMs));
    // Враждебный ease (NaN/∞) → линейный кадр (контракт старых tween-лейнов);
    // производная такого кадра не сеется в подхват (снимок ниже — тот же гард).
    const raw = u >= 1 ? 1 : mode.ease(u);
    const p = Number.isFinite(raw) ? raw : u;
    for (const ch of this._group.numeric) {
      const value = ch.from + (ch.to - ch.from) * p;
      this._state[ch.key] = Number.isFinite(value) ? value : ch.to;
    }
    this._writeNumeric();
    if (u >= 1) this._writeCssFinal();
    else this._writeCssAt(p);
  }

  private _writeNumeric(): void {
    const group = this._group;
    if (group.numeric.length === 0) return;
    try {
      if (group.group === 'transform') {
        group.el.style.setProperty('transform', buildTransform(this._state));
      } else {
        group.el.style.setProperty(
          group.group,
          String(this._state[group.numeric[0]!.key]),
        );
      }
    } catch {
      /* hostile style не роняет кадровую полосу */
    }
  }

  private _writeCssAt(p: number): void {
    const css = this._group.css;
    if (css === undefined) return;
    // Без шва середина не представима — пишется только финал (C⁰-дискретно).
    const value = this._context.formatCssAt?.(css.from, css.to, p);
    if (value === undefined) return;
    try {
      this._group.el.style.setProperty(this._group.group, String(value));
    } catch {
      /* hostile style не роняет кадровую полосу */
    }
  }

  private _writeCssFinal(): void {
    const css = this._group.css;
    if (css === undefined) return;
    try {
      this._group.el.style.setProperty(this._group.group, String(css.to));
    } catch {
      /* hostile style не роняет терминализацию */
    }
  }

  private _laneDone(): void {
    if (this._done) return;
    if (--this._pending <= 0) this._finish();
  }

  private _finish(): void {
    if (this._done) return;
    this._done = true;
    this._tweenGeneration++;
    for (const lane of this._lanes) lane.value.destroy();
    this._cssProgress?.destroy();
    this._resolve();
  }
}

/** Эталонный живой движок: `animate(el, props, { engine: liveEngine })`. */
export const liveEngine: AnimateEngine = (group, context) =>
  new LiveRun(group, context);
