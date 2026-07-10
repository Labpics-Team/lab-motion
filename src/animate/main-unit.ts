/**
 * animate/main-unit.ts — main-thread движок одной группы каналов ./animate.
 *
 * Один юнит = одна CSS-декларация одного элемента (transform | opacity |
 * произвольное свойство) в одном вызове animate(). Свой rAF-микроцикл:
 * значение каждого кадра — ЗАМКНУТАЯ ФОРМА (readCompositorSpring), не
 * пошаговая симуляция — та же аналитика, что у compositor-пути, поэтому
 * C¹-семантика прерывания едина на обоих путях (класс, не совпадение).
 *
 * Почему не буквально createDriver: он spring-only и seek у него в секундах
 * пружинного времени; контракт фасада требует tween-режим (duration+ease),
 * seek в мс и семантику кадра drive.ts («первый кадр = elapsed 0» — bit-exact
 * контрольная точка ретаргета). Здесь оба режима в одном цикле.
 *
 * Часы: только инжектируемый requestFrame (детерминизм, инвариант 3);
 * ts-less вызов колбэка двигает время на FIXED_DT_S (канон drive).
 * Конвенция delay: отсчёт от ВЫЗОВА animate(); зазор вызов→первый кадр
 * не наблюдаем из rAF-шва и оценивается одним кадром FIXED_DT_S.
 */

import { readCompositorSpring } from '../compositor/index.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from '../internal/constants.js';
import type { SpringParams } from '../spring.js';
import {
  RANGE_EPSILON,
  cssAt,
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

/** Режим движения прогона (spring и tween взаимоисключающие — гейт в фасаде). */
export type MotionMode =
  | { readonly type: 'spring'; readonly spring: SpringParams }
  | { readonly type: 'tween'; readonly durationMs: number; readonly ease: (t: number) => number };

/** Шов кадра (контракт drive/MotionValue: handle 0 = non-draining step-clock). */
export type RequestFrameFn = (cb: (ts?: number) => void) => number;

export interface MainUnitOptions {
  readonly el: AnimatableElement;
  readonly group: GroupKey;
  readonly record: GroupRecord;
  readonly numeric: NumericChannel[];
  readonly css: CssChannel | undefined;
  /** Замороженные transform-каналы прежних прогонов (полная проекция состояния). */
  readonly residuals: Map<string, number>;
  readonly mode: MotionMode;
  readonly delayMs: number;
  readonly requestFrame: RequestFrameFn;
  /** natural=true — естественное оседание (для семантики onComplete). */
  readonly onDone: (natural: boolean) => void;
}

const FIXED_DT_MS = FIXED_DT_S * 1000;

/**
 * Фиксированный шаг центральной разности производной изинга (в прогресс-
 * пространстве k∈[0,1]). Фиксированный — детерминизм (инвариант 3); численный,
 * а не аналитический — ease в контракте opaque `(t)=>number` (cubicBezier —
 * небрендированное замыкание, дешёвого аналитического пути без смены
 * публичного контракта фабрик изинга нет). Ошибка на гладких кривых O(h²).
 */
const EASE_DERIV_H = 1e-3;

/** Main-thread прогон группы: rAF-цикл с pause/play/seek/cancel и подхватом. */
export class MainUnit implements GroupOwner {
  readonly finished: Promise<void>;

  private readonly _o: MainUnitOptions;
  private _resolve!: () => void;
  private _done = false;
  private _paused = false;
  private _active = false;
  /** Смена поколения инвалидирует уже запланированные кадры (канон MotionValue). */
  private _gen = 0;
  private _wallMs = 0;
  private _tMs = 0;
  private _lastTs: number | undefined;
  private _frames = 0;
  private _useTimeoutFallback = false;

  /**
   * Переиспользуемый буфер live-каналов transform: заводится один раз на юнит,
   * чтобы не аллоцировать Map на каждый кадр в _write (цель этой оптимизации).
   * Именно Map, а не Record: formatTransform принимает ReadonlyMap, и очистка
   * через clear() сохраняет ссылку — переприсваивание readonly-поля не нужно.
   */
  private readonly _lt = new Map<string, number>();
  private readonly _ss = { value: 0, velocity: 0 };

  constructor(opts: MainUnitOptions) {
    this._o = opts;
    this.finished = new Promise<void>((res) => {
      this._resolve = res;
    });
    this._schedule(true);
  }

  // ── GroupOwner (подхват при повторном animate) ────────────────────────────

  captureNum(key: string): ChannelSnapshot | undefined {
    const ch = this._o.numeric.find((c) => c.key === key);
    if (ch !== undefined) return { value: ch.value, velocity: ch.velocity };
    const frozen = this._o.residuals.get(key);
    return frozen === undefined ? undefined : { value: frozen, velocity: 0 };
  }

  captureCss(key: string): string | number | undefined {
    const ch = this._o.css;
    return ch !== undefined && ch.key === key ? ch.css : undefined;
  }

  numericKeys(): readonly string[] {
    return [...this._o.numeric.map((c) => c.key), ...this._o.residuals.keys()];
  }

  supersede(): void {
    this._finish(false);
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  pause(): void {
    if (this._done || this._paused) return;
    this._paused = true;
    this._gen++; // уже запланированный кадр — инертен
  }

  play(): void {
    if (this._done || !this._paused) return;
    this._paused = false;
    this._lastTs = undefined; // без скачка dt за время паузы
    this._schedule(false);
  }

  /** Перемотка к виртуальному времени анимации (мс) с немедленным эмитом. */
  seek(tMs: number): void {
    if (this._done || Number.isNaN(tMs)) return;
    this._active = true;
    this._tMs = Math.max(0, tMs);
    this._lastTs = undefined;
    if (this._emitAt(this._tMs)) this._settle();
  }

  /** Стоп в текущей позиции: без записи, finished резолвится. */
  cancel(): void {
    if (this._done) return;
    this._writeBack(false);
    this._finish(false);
  }

  // ── Кадровый цикл ─────────────────────────────────────────────────────────

  private _schedule(bootstrap: boolean): void {
    const gen = this._gen;
    if (this._useTimeoutFallback) {
      setTimeout(() => this._tick(undefined, gen), 0);
      return;
    }
    const handle = this._o.requestFrame((ts) => this._tick(ts, gen));
    if (bootstrap && handle === 0) {
      // Non-draining step-clock (канон drive): страховка от дедлока finished.
      this._useTimeoutFallback = true;
      setTimeout(() => this._tick(undefined, gen), 0);
    }
  }

  private _tick(ts: number | undefined, gen: number): void {
    if (gen !== this._gen || this._done || this._paused) return;

    let dt: number;
    if (ts !== undefined) {
      dt = this._lastTs !== undefined ? ts - this._lastTs : 0;
      this._lastTs = ts;
    } else {
      dt = FIXED_DT_MS;
    }
    if (dt < 0) dt = 0;
    this._wallMs += dt;

    if (!this._active) {
      // Зазор вызов→первый кадр ≈ один кадр: конвенция отсчёта delay.
      if (this._wallMs + FIXED_DT_MS >= this._o.delayMs) {
        this._active = true;
        this._tMs = 0;
      }
    } else {
      this._tMs += dt;
    }

    if (this._active) {
      this._frames++;
      if (this._emitAt(this._tMs) || this._frames >= MAX_FRAMES) {
        this._settle();
        return;
      }
    }
    this._schedule(false);
  }

  /**
   * Эмит состояния при виртуальном времени tMs. Возвращает true, когда прогон
   * сошёлся (пороги ядра, range-независимые) — вызывающий пишет точный финал.
   */
  private _emitAt(tMs: number): boolean {
    const o = this._o;
    if (o.mode.type === 'tween') {
      if (tMs >= o.mode.durationMs) return true;
      const k = tMs / o.mode.durationMs;
      const eased = o.mode.ease(k);
      const p = Number.isFinite(eased) ? eased : k; // враждебный ease → линейный кадр
      // Аналитическая скорость tween (C¹-контракт #93): v = range·ease′(k)/duration —
      // captureNum отдаёт её при прерывании, и spring-ран наследует импульс
      // (перехват tween→spring стал C¹, как spring→spring). Окно разности
      // поджимается в [0,1]: изинги клампят снаружи диапазона (endpoint-
      // дисциплина ядра), сэмпл за краем дал бы ложный слом производной.
      let dpdt = 0;
      if (o.numeric.length > 0) {
        // Скорость нужна только числовым каналам — css-only группа не платит
        // двумя лишними вызовами ease на кадр (и не расширяет его домен).
        const k0 = k > EASE_DERIV_H ? k - EASE_DERIV_H : 0;
        const k1 = k + EASE_DERIV_H < 1 ? k + EASE_DERIV_H : 1;
        const slope = (o.mode.ease(k1) - o.mode.ease(k0)) / (k1 - k0);
        // Прогресс/с; non-finite (враждебный ease) → 0: NaN не сеется в подхват.
        dpdt = Number.isFinite(slope) ? (slope * 1000) / o.mode.durationMs : 0;
      }
      for (const ch of o.numeric) {
        const range = ch.to - ch.from;
        const v = ch.from + range * p;
        if (!Number.isFinite(v)) return true; // непредставимый спан → снап к цели
        ch.value = v;
        // `+ 0` схлопывает −0 (range<0 при нулевом наклоне ease).
        const vel = range * dpdt;
        ch.velocity = Number.isFinite(vel) ? vel + 0 : 0;
      }
      if (o.css !== undefined) {
        o.css.p = p;
        o.css.css = cssAt(o.css, p);
      }
      this._write();
      return false;
    }

    // Spring: замкнутая форма на канал — та же аналитика, что compositor-путь.
    const t = tMs / 1000;
    let converged = true;
    const snap = this._ss;
    for (const ch of o.numeric) {
      readCompositorSpring(o.mode.spring, { from: ch.from, to: ch.to, v0: ch.v0, t }, snap);
      ch.value = snap.value;
      ch.velocity = snap.velocity;
      const range = ch.to - ch.from;
      if (Number.isFinite(range)) {
        const ar = Math.max(Math.abs(range), RANGE_EPSILON);
        converged =
          converged &&
          Math.abs(snap.value - ch.to) / ar < CONVERGENCE_THRESHOLD &&
          Math.abs(snap.velocity) / ar < CONVERGENCE_THRESHOLD;
      } // непредставимый спан: канал считается сошедшимся (снап-политика ядра)
    }
    const css = o.css;
    if (css !== undefined) {
      readCompositorSpring(o.mode.spring, { from: 0, to: 1, v0: css.v0, t }, snap);
      css.p = snap.value;
      css.css = cssAt(css, snap.value);
      converged =
        converged &&
        Math.abs(snap.value - 1) < CONVERGENCE_THRESHOLD &&
        Math.abs(snap.velocity) < CONVERGENCE_THRESHOLD;
    }
    if (converged) return true;
    this._write();
    return false;
  }

  /** Запись текущего состояния группы одной CSS-декларацией. */
  private _write(): void {
    const o = this._o;
    if (o.group === 'transform') {
      this._lt.clear();
      for (const ch of o.numeric) this._lt.set(ch.key, ch.value);
      o.el.style.setProperty('transform', formatTransform(o.residuals, this._lt));
    } else if (o.css !== undefined) {
      o.el.style.setProperty(o.group, String(o.css.css));
    } else {
      o.el.style.setProperty(o.group, String(o.numeric[0]!.value));
    }
  }

  /** Естественное оседание: точный финал в стиль + finished. */
  private _settle(): void {
    if (this._done) return;
    const o = this._o;
    for (const ch of o.numeric) {
      ch.value = ch.to;
      ch.velocity = 0;
    }
    if (o.css !== undefined) {
      o.css.p = 1;
      o.css.css = cssAt(o.css, 1);
    }
    this._write();
    this._writeBack(true);
    this._finish(true);
  }

  /** Фиксация состояния в реестре (natural: скорости обнулены — покой). */
  private _writeBack(_natural: boolean): void {
    const rec = this._o.record;
    for (const ch of this._o.numeric) {
      rec.numeric.set(ch.key, { value: ch.value, velocity: 0 });
    }
    this._o.residuals.forEach((v, k) => {
      if (!rec.numeric.has(k)) rec.numeric.set(k, { value: v, velocity: 0 });
    });
    if (this._o.css !== undefined) rec.cssValue = this._o.css.css;
  }

  private _finish(natural: boolean): void {
    if (this._done) return;
    this._done = true;
    this._gen++;
    if (this._o.record.owner === this) this._o.record.owner = undefined;
    this._resolve();
    this._o.onDone(natural);
  }
}
