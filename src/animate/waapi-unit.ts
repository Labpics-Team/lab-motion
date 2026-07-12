/**
 * animate/waapi-unit.ts — compositor-движок одной группы каналов ./animate.
 *
 * Условие маршрута (решает фасад): spring-режим + compositor-eligible группа
 * (transform | opacity) + tier 'compositor' (resolveCompositorTier). Один юнит =
 * ОДНА нативная Animation: два кейфрейма [from, to] в прогресс-пространстве,
 * вся пружинная кривая — в адаптивном linear()-easing (канон compileSpringPlan).
 * Steady-state — ноль работы main-потока; каскад — нативный WAAPI-delay.
 *
 * Прерывания (retarget через фасад / pause / seek) — канон CompositorSpring:
 * cancel + АНАЛИТИЧЕСКИЙ снимок (readCompositorSpring по now-шву, без чтения
 * DOM) + re-emit новой кривой, засеянной скоростью (C¹). cancel()/pause()
 * фиксируют значение инлайн ДО cancel Animation — элемент не мигает к базе.
 *
 * finished: WAAPI Animation.finished недетерминируем в тестах и отсутствует у
 * duck-целей — резолв планируется setTimer-швом на АНАЛИТИЧЕСКОЕ время
 * оседания (delay + duration плана; duration = settleTimeUpperBound ядра).
 *
 * Ограничение честно: несколько transform-каналов делят одну кривую
 * (физика WAAPI: одно свойство = одна Animation) — при ретаргете C¹ точен
 * для доминантного канала (максимальный |range|), остальные C⁰+пропорция.
 * Одиночный канал (типовой случай) — C¹ точен.
 */

import {
  compileSpringPlan,
  readCompositorSpring,
  type SetTimerFn,
} from '../compositor/core.js';
import type { SpringParams } from '../spring.js';
import {
  formatTransform,
  normalizeV0,
  type AnimatableElement,
  type ChannelSnapshot,
  type CssChannel,
  type GroupKey,
  type GroupOwner,
  type GroupRecord,
  type NumericChannel,
} from './channels.js';

/** Duck-контракт WAAPI-цели фасада (Element.animate → {cancel}). */
export interface WaapiTarget extends AnimatableElement {
  animate(
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ): { cancel?: () => void };
}

export interface WaapiUnitOptions {
  readonly el: WaapiTarget;
  readonly group: GroupKey; // 'transform' | 'opacity'
  readonly record: GroupRecord;
  readonly numeric: NumericChannel[];
  readonly residuals: Map<string, number>;
  readonly spring: SpringParams;
  readonly delayMs: number;
  readonly now: () => number;
  readonly setTimer: SetTimerFn;
  readonly onDone: (natural: boolean) => void;
}

/** Compositor-прогон группы: Element.animate + аналитические прерывания. */
export class WaapiUnit implements GroupOwner {
  readonly finished: Promise<void>;

  private readonly _o: WaapiUnitOptions;
  private _resolve!: () => void;
  private _done = false;
  private _paused = false;
  private _anim: { cancel?: () => void } | undefined;
  private _timerCancel: (() => void) | undefined;
  /** Прогресс-пространство текущей кривой (пере-сеется при re-emit). */
  private _v0 = 0;
  private _startTime = 0;
  private _startDelay = 0;

  constructor(opts: WaapiUnitOptions) {
    this._o = opts;
    this.finished = new Promise<void>((res) => {
      this._resolve = res;
    });
    // v0 прогресса кривой группы — по доминантному каналу (max |range|):
    // одиночный канал (типовой случай) → C¹ подхвата точен.
    this._v0 = dominantV0(opts.numeric);
    this._emit(opts.delayMs);
  }

  // ── GroupOwner ────────────────────────────────────────────────────────────

  captureNum(key: string): ChannelSnapshot | undefined {
    const ch = this._o.numeric.find((c) => c.key === key);
    if (ch !== undefined) {
      this._syncSnapshot();
      return { value: ch.value, velocity: ch.velocity };
    }
    const frozen = this._o.residuals.get(key);
    return frozen === undefined ? undefined : { value: frozen, velocity: 0 };
  }

  captureCss(): CssChannel | undefined {
    return undefined; // css-каналы на compositor-путь не маршрутизируются
  }

  numericKeys(): readonly string[] {
    return [...this._o.numeric.map((c) => c.key), ...this._o.residuals.keys()];
  }

  supersede(): void {
    if (this._done) return;
    this._clearTimer();
    this._cancelAnim(); // визуал мгновенно перекроет новая Animation (fill both)
    this._finish(false);
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  pause(): void {
    if (this._done || this._paused) return;
    this._syncSnapshot();
    this._holdInline();
    this._clearTimer();
    this._cancelAnim();
    this._paused = true;
  }

  play(): void {
    if (this._done || !this._paused) return;
    this._paused = false;
    this._reseedFromSnapshot();
    this._emit(0);
  }

  /** Перемотка к виртуальному времени прогона (мс): снимок в t + re-emit. */
  seek(tMs: number): void {
    if (this._done || Number.isNaN(tMs)) return;
    this._snapshotAt(Math.max(0, tMs) / 1000);
    this._clearTimer();
    this._cancelAnim();
    this._paused = false;
    this._reseedFromSnapshot();
    this._emit(0);
  }

  /** Стоп в текущей позиции: инлайн-фиксация ДО cancel (без отката к базе). */
  cancel(): void {
    if (this._done) return;
    this._syncSnapshot();
    this._holdInline();
    this._clearTimer();
    this._cancelAnim();
    this._writeBack();
    this._finish(false);
  }

  // ── Приватное ─────────────────────────────────────────────────────────────

  /** Коммит плана в Element.animate (канон _emitCompositor CompositorSpring). */
  private _emit(delayMs: number): void {
    const o = this._o;
    const plan = compileSpringPlan({
      spring: o.spring,
      property: o.group,
      from: 0,
      to: 1,
      v0: this._v0,
      format: (p) => this._valueAt(p),
    });
    this._startDelay = delayMs;
    this._startTime = o.now();
    this._anim = o.el.animate(plan.keyframes, {
      duration: plan.duration,
      easing: plan.easing,
      iterations: plan.iterations,
      fill: plan.fill,
      composite: plan.composite,
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    });
    // finished — по аналитическому оседанию (duration плана = settle ядра).
    this._timerCancel = o.setTimer(() => {
      this._timerCancel = undefined;
      this._settleNatural();
    }, delayMs + plan.duration);
  }

  /** Строка/число группы при прогрессе p (края — точные from/to каналов). */
  private _valueAt(p: number): string | number {
    const o = this._o;
    if (o.group === 'transform') {
      const live = new Map<string, number>();
      for (const ch of o.numeric) live.set(ch.key, channelAt(ch, p));
      return formatTransform(o.residuals, live);
    }
    return channelAt(o.numeric[0]!, p);
  }

  /** Снимок каналов при виртуальном времени t (сек) — без чтения DOM. */
  private _snapshotAt(t: number): void {
    const r = readCompositorSpring(this._o.spring, { from: 0, to: 1, v0: this._v0, t });
    for (const ch of this._o.numeric) {
      const range = ch.to - ch.from;
      const value = ch.from + r.value * range;
      ch.value = Number.isFinite(value) ? value : ch.to;
      const vel = r.velocity * range;
      ch.velocity = Number.isFinite(vel) ? vel : 0;
    }
  }

  /** Снимок «сейчас» по now-шву (физический t=0 — после окна задержки). */
  private _syncSnapshot(): void {
    const t = (this._o.now() - this._startTime - this._startDelay) / 1000;
    this._snapshotAt(t >= 0 ? t : 0);
  }

  /**
   * Пере-сев кривой из снимка: каналы продолжают from=значение снимка;
   * v0 прогресса — по доминантному каналу (максимальный |range|), C¹ для него
   * точен, одиночный канал — всегда точен.
   */
  private _reseedFromSnapshot(): void {
    const o = this._o;
    const rebased = o.numeric.map((ch) => rebaseChannel(ch));
    o.numeric.length = 0;
    o.numeric.push(...rebased);
    this._v0 = dominantV0(o.numeric);
  }

  /** Инлайн-фиксация текущего значения (перед cancel — без миганья к базе). */
  private _holdInline(): void {
    const o = this._o;
    if (o.group === 'transform') {
      const live = new Map<string, number>();
      for (const ch of o.numeric) live.set(ch.key, ch.value);
      o.el.style.setProperty('transform', formatTransform(o.residuals, live));
    } else {
      o.el.style.setProperty(o.group, String(o.numeric[0]!.value));
    }
  }

  private _cancelAnim(): void {
    const anim = this._anim;
    this._anim = undefined;
    if (anim !== undefined && typeof anim.cancel === 'function') {
      try {
        anim.cancel();
      } catch {
        /* duck-цель могла не реализовать cancel — не роняем прерывание */
      }
    }
  }

  private _clearTimer(): void {
    if (this._timerCancel !== undefined) {
      this._timerCancel();
      this._timerCancel = undefined;
    }
  }

  private _settleNatural(): void {
    if (this._done || this._paused) return;
    for (const ch of this._o.numeric) {
      ch.value = ch.to;
      ch.velocity = 0;
    }
    this._writeBack();
    this._finish(true); // Animation с fill:both держит финал — инлайн не нужен
  }

  private _writeBack(): void {
    const rec = this._o.record;
    for (const ch of this._o.numeric) {
      rec.numeric.set(ch.key, { value: ch.value, velocity: 0 });
    }
    this._o.residuals.forEach((v, k) => {
      if (!rec.numeric.has(k)) rec.numeric.set(k, { value: v, velocity: 0 });
    });
  }

  private _finish(natural: boolean): void {
    if (this._done) return;
    this._done = true;
    if (this._o.record.owner === this) this._o.record.owner = undefined;
    this._resolve();
    this._o.onDone(natural);
  }
}

/** Значение канала при прогрессе p; края возвращают ТОЧНЫЕ from/to (без fp-дрейфа). */
function channelAt(ch: NumericChannel, p: number): number {
  if (p <= 0) return ch.from;
  if (p >= 1) return ch.to;
  const v = ch.from + p * (ch.to - ch.from);
  return Number.isFinite(v) ? v : ch.to;
}

/** Канал, перебазированный на снимок (from = текущее значение, v0 группы общий). */
function rebaseChannel(ch: NumericChannel): NumericChannel {
  return {
    kind: 'num',
    key: ch.key,
    from: ch.value,
    to: ch.to,
    v0: 0, // v0 живёт на уровне кривой группы (_v0), канальный не используется
    value: ch.value,
    velocity: ch.velocity,
  };
}

/** v0 прогресса группы по доминантному каналу (максимальный |to − from|). */
function dominantV0(channels: readonly NumericChannel[]): number {
  let dom: NumericChannel | undefined;
  for (const ch of channels) {
    if (dom === undefined || Math.abs(ch.to - ch.from) > Math.abs(dom.to - dom.from)) {
      dom = ch;
    }
  }
  return dom === undefined ? 0 : normalizeV0(dom.velocity, dom.to - dom.from);
}
