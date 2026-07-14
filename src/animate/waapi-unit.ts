/**
 * animate/waapi-unit.ts — compositor-движок одной группы каналов ./animate.
 *
 * Условие маршрута (решает фасад): spring-режим + compositor-eligible группа
 * (transform | opacity) + tier 'compositor' (resolveCompositorTier). Один юнит =
 * ОДНА нативная Animation: Chromium/Firefox получают два кадра + linear(),
 * WebKit — явные кадры той же кривой + обычный linear. Устойчивый режим — ноль
 * работы главного потока; каскад — нативная задержка WAAPI.
 *
 * Прерывания (retarget через фасад / pause / seek) — канон CompositorSpring:
 * serialized snapshot по native currentTime (без style/layout) + cancel +
 * re-emit с правым slope фактического сегмента. cancel()/pause()
 * фиксируют значение инлайн ДО cancel Animation — элемент не мигает к базе.
 *
 * Завершение: representable deadline обслуживает setTimer-шов. Для диапазона
 * больше host timer native Animation.finished — основной clock; duck-цель без
 * finished просыпается bounded timer-ом и сверяется с currentTime/now.
 *
 * Ограничение честно: несколько transform-каналов делят одну кривую
 * (физика WAAPI: одно свойство = одна Animation) — при ретаргете slope точен
 * для доминантного канала (максимальный |range|), остальные C⁰+пропорция.
 * Одиночный affine-канал точен в effect-space вне kink, пока следующая точка
 * представима конечным Number; на числовой границе handoff остаётся fail-closed
 * со старым owner. Rendered clamping, non-affine format и меняющийся underlying
 * лежат за границей гарантии.
 */

import { type SetTimerFn } from '../compositor/core.js';
import {
  DEFAULT_TOLERANCE,
  tryCompileSpringExecutionArtifactTupleUnchecked,
  type SpringExecutionArtifactTuple,
  type SpringSerializedSamples,
} from '../compositor/curve.js';
import { compileSpringRuntimeExecutionTupleUnchecked } from '../compositor/execution.js';
import { MotionParamError } from '../errors.js';
import {
  animationTimeOrFallback,
  sampleSerializedSpring,
  scaleSerializedVelocity,
} from '../compositor/sample.js';
import type { SpringParams } from '../spring.js';
import { buildTransform } from '../value/transform.js';
import {
  channelAt,
  dominantV0,
  rebaseNumericChannels,
  type AnimatableElement,
  type ChannelSnapshot,
  type CssChannel,
  type GroupKey,
  type GroupOwner,
  type GroupRecord,
  type NumericChannel,
} from './channels.js';
import { MainUnit } from './main-unit.js';
import { SurfaceBatch } from './surface-batch.js';

// Sampler синхронен и чист: единый scratch безопасен между unit и не создаёт
// объект на каждый compositor-run.
const SPRING_SAMPLE = { value: 0, velocity: 0 };

// HTML timers clamp delays above signed int32. Это граница платформы, а не
// настраиваемый лимит.
const MAX_TIMER_MS = 2 ** 31 - 1;

interface WaapiAnimation {
  cancel?: () => void;
  currentTime?: number | null;
  finished?: PromiseLike<unknown>;
}

/** Duck-контракт WAAPI-цели фасада (Element.animate → {cancel}). */
export interface WaapiTarget extends AnimatableElement {
  animate(
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ): WaapiAnimation;
}

export interface WaapiUnitOptions {
  readonly _el: WaapiTarget;
  readonly _group: GroupKey; // 'transform' | 'opacity'
  readonly _record: GroupRecord;
  readonly _numeric: NumericChannel[];
  readonly _residuals: Map<string, number>;
  readonly _transform: Record<string, number> | undefined;
  readonly _spring: SpringParams;
  readonly _delayMs: number;
  readonly _now: () => number;
  readonly _setTimer: SetTimerFn;
  /** Один lazy getter: чистый WAAPI не создаёт main kernel. */
  readonly _getBatch: () => SurfaceBatch;
  readonly _onDone: (natural: boolean) => void;
  /** Plan-фаза уже доказала и скомпилировала exact WAAPI-кривую. */
  readonly _artifact: SpringExecutionArtifactTuple;
}

/** Compositor-прогон группы: Element.animate + piecewise-прерывания. */
export class WaapiUnit implements GroupOwner {
  private readonly _o: WaapiUnitOptions;
  private _done = false;
  private _paused = false;
  /** Блокирует реентрантные controls, пока terminal pose/семантика фиксируются. */
  private _locked = false;
  private _anim: WaapiAnimation | undefined;
  /**
   * Редкий exact-handoff: нормализованная WAAPI-кривая не кодирует абсолютный
   * импульс при нулевой/чрезмерно малой оставшейся амплитуде, live — кодирует.
   * Wrapper остаётся owner и публичным control, поэтому aggregate не меняется.
   */
  private _delegate: MainUnit | undefined;
  private _timerCancel: (() => void) | undefined;
  /** Natural wake может опередить публикацию owner. */
  private _pendingNatural = false;
  /** Прогресс-пространство текущей кривой (пере-сеется при re-emit). */
  private _v0 = 0;
  private _startTime = 0;
  private _startDelay = 0;
  private _durationMs = 0;
  private _samples: SpringSerializedSamples | undefined;
  private readonly _format = (progress: number): string | number =>
    this._valueAt(progress);

  constructor(opts: WaapiUnitOptions) {
    this._o = opts;
    // v0 прогресса кривой группы — по доминантному каналу (max |range|):
    // одиночный affine-канал → effect-space pickup точен.
    this._v0 = dominantV0(opts._numeric);
    this._emit(opts._delayMs, opts._artifact);
  }

  // ── GroupOwner ────────────────────────────────────────────────────────────

  _release(): void {
    this._commit();
  }

  _capture(): void {
    if (this._delegate === undefined && !this._o._record._transition && !this._locked) {
      this._syncSnapshot();
    }
  }

  _captureNum(key: string): ChannelSnapshot | undefined {
    if (this._delegate !== undefined) return this._delegate._captureNum(key);
    const ch = this._o._numeric.find((c) => c._key === key);
    if (ch !== undefined) {
      return { _value: ch._value, _velocity: ch._velocity };
    }
    const frozen = this._o._residuals.get(key);
    return frozen === undefined ? undefined : { _value: frozen, _velocity: 0 };
  }

  _captureCss(): CssChannel | undefined {
    return undefined; // css-каналы на compositor-путь не маршрутизируются
  }

  _numericKeys(): readonly string[] {
    if (this._delegate !== undefined) return this._delegate._numericKeys();
    return [...this._o._numeric.map((c) => c._key), ...this._o._residuals.keys()];
  }

  _supersede(replacement?: () => void): void {
    if (this._done) {
      return;
    }
    if (this._locked) throw new MotionParamError('LM157');
    if (this._delegate !== undefined) {
      this._transaction(() => this._delegate!._supersede(replacement));
      return;
    }
    // Inline hold проходит до destructive cleanup: hostile style не должен
    // уничтожать старый owner/effect при неудачном successor.
    this._transaction(() => {
      this._holdInline();
      replacement?.();
      this._clearTimer();
      this._cancelAnim();
      this._writeBack();
      this._finish(false);
    });
  }

  /** Откат ещё не опубликованного successor без inline-записи. */
  _rollback(): void {
    this._transaction(() => {
      this._clearTimer();
      this._cancelAnim();
      this._finish(false);
    });
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  pause(): void {
    if (this._done || this._o._record._transition || this._locked || this._paused) return;
    if (this._delegate !== undefined) {
      this._transaction(() => {
        this._delegate!.pause();
        this._paused = true;
      });
      return;
    }
    this._transaction(() => {
      this._syncSnapshot();
      this._holdInline();
      this._clearTimer();
      this._cancelAnim();
      this._paused = true;
    });
  }

  play(): void {
    if (this._done || this._o._record._transition || this._locked || !this._paused) return;
    if (this._delegate !== undefined) {
      // Wrapper меняет состояние только после успешной подписки delegate:
      // бросок оставляет оба уровня повторяемо paused.
      this._transaction(() => {
        this._delegate!.play();
        this._paused = false;
      });
      return;
    }
    const artifact = this._tryReseedFromSnapshot();
    if (artifact === undefined) {
      this._handoffToLive(false);
      return;
    }
    this._transaction(() => {
      // До успешной установки effect wrapper остаётся paused: это отличает
      // повторяемый replay от active seek, уже снявшего прежний effect.
      this._emit(0, artifact);
      this._paused = false;
    });
    this._commit();
  }

  /** Перемотка к времени прогона: на паузе фиксирует позу, иначе продолжает. */
  seek(tMs: number): void {
    if (
      this._done ||
      this._o._record._transition ||
      this._locked ||
      !Number.isFinite(tMs)
    ) return;
    if (this._delegate !== undefined) {
      this._transaction(() => this._delegate!.seek(tMs));
      return;
    }
    const wasPaused = this._paused;
    this._snapshotAt(Math.max(0, tMs));
    const artifact = this._tryReseedFromSnapshot();
    if (artifact === undefined) {
      this._handoffToLive(wasPaused);
      return;
    }
    this._transaction(() => {
      // Paused effect уже снят, но hold всё равно предшествует любому cleanup:
      // hostile style не должен терминализировать wrapper реентрантно.
      if (wasPaused) this._holdInline();
      this._clearTimer();
      this._cancelAnim();
      if (!wasPaused) this._emit(0, artifact);
    });
    if (wasPaused) return;
    this._commit();
  }

  /** Стоп в текущей позиции: инлайн-фиксация ДО cancel (без отката к базе). */
  cancel(): void {
    if (this._done || this._o._record._transition || this._locked) return;
    if (this._delegate !== undefined) {
      this._transaction(() => this._delegate!.cancel());
      return;
    }
    this._transaction(() => {
      this._syncSnapshot();
      this._holdInline();
      this._clearTimer();
      this._cancelAnim();
      this._writeBack();
      this._finish(false);
    });
  }

  // ── Приватное ─────────────────────────────────────────────────────────────

  /** Коммит плана в Element.animate (канон _emitCompositor CompositorSpring). */
  private _emit(delayMs: number, artifact: SpringExecutionArtifactTuple): void {
    const o = this._o;
    const plan = compileSpringRuntimeExecutionTupleUnchecked(
      o._spring,
      o._group,
      0,
      1,
      this._v0,
      DEFAULT_TOLERANCE,
      undefined,
      undefined,
      this._format,
      artifact,
    );
    this._startDelay = delayMs;
    this._durationMs = plan[2];
    this._samples = plan[5];
    try {
      this._startTime = o._now();
      this._anim = o._el.animate(plan[0], {
        duration: plan[2],
        easing: plan[1],
        iterations: 1,
        fill: plan[3],
        composite: plan[4],
        ...(delayMs > 0 ? { delay: delayMs } : {}),
      });
      const deadline = delayMs + plan[2];
      const verify = deadline > MAX_TIMER_MS;
      const finished = verify && this._anim.finished;
      if (finished) {
        const token = (): void => {
          if (this._timerCancel === token) this._rollback();
        };
        this._timerCancel = token;
        Promise.resolve(finished).then(
          () => this._wake(token, -1),
          token,
        );
      } else {
        this._armCompletion(deadline, verify ? 0 : -1);
      }
    } catch (error) {
      // Element.animate уже мог запустить compositor-прогон, а setTimer —
      // бросить после частичного планирования. В обоих случаях снимаем effect;
      // опубликованный paused-wrapper остаётся owner для повторного play, тогда
      // как не опубликованный constructor обязан терминализировать aggregate.
      this._transaction(() => {
        this._clearTimer();
        this._cancelAnim();
        if (this._o._record._owner !== this || !this._paused) this._finish(false);
      });
      throw error;
    }
  }

  /** Строка/число группы при прогрессе p (края — точные from/to каналов). */
  private _valueAt(p: number): string | number {
    const o = this._o;
    if (o._group === 'transform') {
      const state = o._transform!;
      for (const ch of o._numeric) state[ch._key] = channelAt(ch, p);
      return buildTransform(state);
    }
    return channelAt(o._numeric[0]!, p);
  }

  /** Снимок каналов при времени WAAPI (мс) из actual serialized curve. */
  private _snapshotAt(currentTimeMs: number, delayMs = 0): void {
    const r = sampleSerializedSpring(
      this._samples!,
      this._durationMs,
      currentTimeMs,
      delayMs,
      SPRING_SAMPLE,
    );
    for (const ch of this._o._numeric) {
      // Та же устойчивая интерполяция, что у кадров WebKit: снимок MAX ↔
      // -MAX не должен телепортироваться в цель из-за переполнения.
      ch._value = channelAt(ch, r.value);
      ch._velocity = scaleSerializedVelocity(r.velocity, ch._from, ch._to);
    }
  }

  /** Нативный currentTime побеждает drifted JS clock, но не требует layout. */
  private _syncSnapshot(): void {
    this._snapshotAt(this._elapsed(false), this._startDelay);
  }

  /** Native local time, затем injected clock; -1 = pre-start/unavailable. */
  private _elapsed(fallbackPending: boolean): number {
    // NaN — ленивый sentinel: валидный native currentTime не вызывает now().
    let current = animationTimeOrFallback(this._anim, NaN);
    if (Number.isNaN(current) || (fallbackPending && current < 0)) {
      try {
        current = this._o._now() - this._startTime;
      } catch {
        // Отказ clock означает безопасный pre-start либо fail-closed wake.
      }
    }
    // Для числового clock x-x равен нулю только при конечном x; это сохраняет
    // NaN/±Infinity как fail-closed sentinel без coercive global isFinite.
    return current - current === 0 ? current : -1;
  }

  /**
   * Пере-сев кривой из снимка: каналы продолжают from=значение снимка;
   * v0 прогресса — по доминантному каналу (максимальный |range|), slope для него
   * точен, одиночный канал — всегда точен.
   */
  private _tryReseedFromSnapshot(): SpringExecutionArtifactTuple | undefined {
    const o = this._o;
    const v0 = dominantV0(o._numeric);
    const artifact = tryCompileSpringExecutionArtifactTupleUnchecked(
      o._spring,
      v0,
      DEFAULT_TOLERANCE,
    );
    if (artifact === undefined) return undefined;
    const rebased = rebaseNumericChannels(o._numeric);
    o._numeric.length = 0;
    o._numeric.push(...rebased);
    this._v0 = v0;
    return artifact;
  }

  /**
   * Атомарно переносит текущий абсолютный снимок в live. Batch берётся лениво
   * и общий для всех юнитов aggregate; inline hold предшествует cancel,
   * поэтому смена движка не раскрывает underlying style ни на один кадр.
   */
  private _handoffToLive(paused: boolean): void {
    const o = this._o;
    const batch = o._getBatch();
    const rebased = rebaseNumericChannels(o._numeric);
    this._transaction(() => {
      this._holdInline();
      this._clearTimer();
      this._cancelAnim();
      o._numeric.length = 0;
      o._numeric.push(...rebased);
      this._paused = paused;
      try {
        this._delegate = new MainUnit({
          _el: o._el,
          _group: o._group,
          _record: o._record,
          _bound: {
            _numeric: o._numeric,
            _css: undefined,
            _residuals: o._residuals,
            _transform: o._transform,
          },
          _mode: { _type: 'spring', _spring: o._spring },
          _delayMs: 0,
          _batch: batch,
          _onDone: (natural) => this._finish(natural),
          _startPaused: paused,
        });
      } catch (error) {
        // Старый compositor уже снят: терминализируем wrapper, чтобы aggregate и
        // registry не удерживали полусозданный handoff.
        this._writeBack();
        this._finish(false);
        throw error;
      }
    });
  }

  /** Инлайн-фиксация текущего значения (перед cancel — без миганья к базе). */
  private _holdInline(): void {
    const o = this._o;
    if (o._group === 'transform') {
      const state = o._transform!;
      for (const ch of o._numeric) state[ch._key] = ch._value;
      o._el.style.setProperty('transform', buildTransform(state));
    } else {
      o._el.style.setProperty(o._group, String(o._numeric[0]!._value));
    }
  }

  private _cancelAnim(): void {
    const anim = this._anim;
    this._anim = undefined;
    try {
      anim?.cancel?.();
    } catch {
      /* duck-цель могла не реализовать cancel — не роняем прерывание */
    }
  }

  /** Единая граница реентрантных host/delegate-вызовов. */
  private _transaction(action: () => void): void {
    this._locked = true;
    try {
      action();
    } finally {
      this._locked = false;
    }
  }

  private _wake(token: () => void, last: number): void {
    const elapsed = last < 0
      ? animationTimeOrFallback(this._anim, -1)
      : this._elapsed(true);
    if (this._timerCancel !== token) return;
    const activeMs = elapsed - this._startDelay;
    if ((last < 0 && elapsed < 0) || activeMs >= this._durationMs) this._complete();
    else if (!elapsed || elapsed <= last) this._rollback();
    else {
      this._armCompletion(this._durationMs - activeMs, elapsed);
    }
  }

  private _armCompletion(
    wait: number,
    last: number,
  ): void {
    let sync = true;
    let active = true;
    let hostCancel: (() => void) | undefined;
    const cancel = (): void => {
      if (!active) return;
      active = false;
      try { hostCancel?.(); } catch { /* host cleanup не блокирует lifecycle */ }
    };
    this._timerCancel = cancel;
    try {
      hostCancel = this._o._setTimer(() => {
        if (!active || this._timerCancel !== cancel) return;
        active = false;
        if (sync) {
          if (last >= 0) queueMicrotask(() => {
            if (this._timerCancel === cancel) this._rollback();
          });
          return;
        }
        if (last < 0) {
          this._complete();
          return;
        }
        this._wake(cancel, last);
      }, Math.min(wait, MAX_TIMER_MS));
    } catch (error) {
      cancel();
      if (this._timerCancel !== cancel) return;
      if (last <= 0) {
        this._timerCancel = undefined;
        throw error;
      }
      this._rollback();
    }
    sync = false;
    if (!active) {
      active = true;
      cancel();
      if (last < 0) this._complete();
    }
  }

  private _complete(): void {
    this._pendingNatural = true;
    this._commit();
  }

  private _clearTimer(): void {
    const cancel = this._timerCancel;
    this._timerCancel = undefined;
    this._pendingNatural = false;
    cancel?.();
  }

  /** Публикует unit: выпускает sync timer только вне host-транзакции и ровно один раз. */
  _commit(): void {
    if (
      this._o._record._owner !== this ||
      !this._pendingNatural ||
      this._o._record._transition ||
      this._locked
    ) return;
    this._transaction(() => {
      this._clearTimer();
      for (const ch of this._o._numeric) {
        ch._value = ch._to;
        ch._velocity = 0;
      }
      // Успешный inline hold позволяет снять fill:both effect и освободить host.
      // При hostile style сам effect остаётся визуальным fallback, но логическая
      // ссылка отпускается и aggregate продолжает терминализацию.
      try {
        this._holdInline();
        this._cancelAnim();
      } catch {
        this._anim = undefined;
      }
      this._writeBack();
      this._finish(true);
    });
  }

  private _writeBack(): void {
    const rec = this._o._record;
    for (const ch of this._o._numeric) {
      rec._numeric.set(ch._key, { _value: ch._value, _velocity: 0 });
    }
  }

  private _finish(natural: boolean): void {
    if (this._done) return;
    this._done = true;
    if (this._o._record._owner === this) this._o._record._owner = undefined;
    this._o._onDone(natural);
  }
}
