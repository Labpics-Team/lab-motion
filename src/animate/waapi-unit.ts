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
 * Завершение: WAAPI Animation.finished недетерминируем в тестах и отсутствует
 * у duck-целей — Unit сообщает aggregate-вызову по setTimer-шву на
 * АНАЛИТИЧЕСКОЕ время оседания (delay + duration плана).
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

/** Duck-контракт WAAPI-цели фасада (Element.animate → {cancel}). */
export interface WaapiTarget extends AnimatableElement {
  animate(
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ): { cancel?: () => void; currentTime?: number | null };
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
  private _anim: { cancel?: () => void; currentTime?: number | null } | undefined;
  /**
   * Редкий exact-handoff: нормализованная WAAPI-кривая не кодирует абсолютный
   * импульс при нулевой/чрезмерно малой оставшейся амплитуде, live — кодирует.
   * Wrapper остаётся owner и публичным control, поэтому aggregate не меняется.
   */
  private _delegate: MainUnit | undefined;
  private _timerCancel: (() => void) | undefined;
  /** Внутренний ticket отличает прогоны даже при общем host cancel-handle. */
  private _timerGeneration = 0;
  /** Timer может быть синхронным: публикация owner должна предшествовать settle. */
  private _pendingNatural = false;
  /** Прогресс-пространство текущей кривой (пере-сеется при re-emit). */
  private _v0 = 0;
  private _startTime = 0;
  private _startDelay = 0;
  private _durationMs = 0;
  private _samples: SpringSerializedSamples | undefined;
  private readonly _sample = { value: 0, velocity: 0 };
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
    this._flushNatural();
  }

  _capture(): void {
    if (this._delegate !== undefined) this._delegate._capture();
    else if (!this._o._record._transition && !this._locked) this._syncSnapshot();
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
      this._locked = true;
      try {
        this._delegate._supersede(replacement);
      } catch (error) {
        this._locked = false;
        throw error;
      }
      return;
    }
    // Inline hold проходит до destructive cleanup: hostile style не должен
    // уничтожать старый owner/effect при неудачном successor.
    this._locked = true;
    try {
      this._holdInline();
      replacement?.();
    } catch (error) {
      this._locked = false;
      throw error;
    }
    this._clearTimer();
    this._cancelAnim();
    this._writeBack();
    this._finish(false);
  }

  /** Публикует подготовленный unit и выпускает отложенный synchronous timer. */
  _commit(): void {
    if (this._done) return;
    this._flushNatural();
  }

  /** Откат ещё не опубликованного successor без inline-записи. */
  _rollback(): void {
    if (this._done) return;
    this._clearTimer();
    this._cancelAnim();
    this._finish(false);
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  pause(): void {
    if (this._done || this._o._record._transition || this._locked || this._paused) return;
    if (this._delegate !== undefined) {
      this._paused = true;
      this._delegate.pause();
      return;
    }
    this._locked = true;
    try {
      this._syncSnapshot();
      this._holdInline();
      this._clearTimer();
      this._cancelAnim();
      this._paused = true;
      this._pendingNatural = false;
    } catch (error) {
      this._locked = false;
      throw error;
    }
    this._locked = false;
  }

  play(): void {
    if (this._done || this._o._record._transition || this._locked || !this._paused) return;
    if (this._delegate !== undefined) {
      // Wrapper меняет состояние только после успешной подписки delegate:
      // бросок оставляет оба уровня повторяемо paused.
      this._locked = true;
      try {
        this._delegate.play();
        this._paused = false;
      } catch (error) {
        this._locked = false;
        throw error;
      }
      if (!this._done) this._locked = false;
      return;
    }
    const artifact = this._tryReseedFromSnapshot();
    if (artifact === undefined) {
      this._handoffToLive(false);
      return;
    }
    this._locked = true;
    try {
      // До успешной установки effect wrapper остаётся paused: это отличает
      // повторяемый replay от active seek, уже снявшего прежний effect.
      this._emit(0, artifact);
    } catch (error) {
      this._locked = false;
      throw error;
    }
    this._paused = false;
    this._locked = false;
    this._flushNatural();
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
      this._locked = true;
      try {
        this._delegate.seek(tMs);
      } catch (error) {
        this._locked = false;
        throw error;
      }
      if (!this._done) this._locked = false;
      return;
    }
    const wasPaused = this._paused;
    this._snapshotAt(Math.max(0, tMs));
    const artifact = this._tryReseedFromSnapshot();
    if (artifact === undefined) {
      this._handoffToLive(wasPaused);
      return;
    }
    this._locked = true;
    try {
      // Paused effect уже снят, но hold всё равно предшествует любому cleanup:
      // hostile style не должен терминализировать wrapper реентрантно.
      if (wasPaused) this._holdInline();
      this._clearTimer();
      this._cancelAnim();
      if (!wasPaused) this._emit(0, artifact);
    } catch (error) {
      this._locked = false;
      throw error;
    }
    if (wasPaused) {
      this._pendingNatural = false;
      this._locked = false;
      return;
    }
    this._locked = false;
    this._flushNatural();
  }

  /** Стоп в текущей позиции: инлайн-фиксация ДО cancel (без отката к базе). */
  cancel(): void {
    if (this._done || this._o._record._transition || this._locked) return;
    if (this._delegate !== undefined) {
      this._delegate.cancel();
      return;
    }
    this._locked = true;
    try {
      this._syncSnapshot();
      this._holdInline();
    } catch (error) {
      this._locked = false;
      throw error;
    }
    this._clearTimer();
    this._cancelAnim();
    this._writeBack();
    this._finish(false);
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
    const timerGeneration = ++this._timerGeneration;
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
      // Завершение привязано к аналитическому времени оседания. Шов вправе
      // вызвать callback до возврата: тогда cancel нельзя сохранить как живой.
      const cancelTimer = o._setTimer(() => {
        // Поздний callback уже снятого/неудачного прогона не имеет права
        // обнулить cancel-handle и завершить более новый replay.
        if (timerGeneration !== this._timerGeneration) return;
        this._timerCancel = undefined;
        if (
          this._o._record._owner === this &&
          !this._o._record._transition &&
          !this._locked
        ) {
          this._settleNatural();
        } else this._pendingNatural = true;
      }, delayMs + plan[2]);
      if (this._done) {
        safeCancelTimer(cancelTimer);
      } else {
        this._timerCancel = cancelTimer;
      }
    } catch (error) {
      // Element.animate уже мог запустить compositor-прогон, а setTimer —
      // бросить после частичного планирования. В обоих случаях снимаем effect;
      // опубликованный paused-wrapper остаётся owner для повторного play, тогда
      // как не опубликованный constructor обязан терминализировать aggregate.
      this._clearTimer();
      this._cancelAnim();
      this._pendingNatural = false;
      if (this._o._record._owner !== this || !this._paused) this._finish(false);
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
      this._sample,
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
    // NaN — ленивый sentinel: валидный native currentTime не вызывает now().
    // Host-clock нужен лишь при реально отсутствующем/невалидном native времени.
    let currentTime = animationTimeOrFallback(this._anim, NaN);
    if (!Number.isFinite(currentTime)) {
      let elapsed = -1;
      try {
        const now = this._o._now();
        if (Number.isFinite(now) && Number.isFinite(this._startTime)) {
          elapsed = now - this._startTime;
        }
      } catch {
        // Отказ fallback-clock означает безопасный pre-start, не потерю owner.
      }
      currentTime = Number.isFinite(elapsed) ? elapsed : -1;
    }
    this._snapshotAt(currentTime, this._startDelay);
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
    this._locked = true;
    try {
      this._holdInline();
      this._clearTimer();
      this._cancelAnim();
      this._pendingNatural = false;
    } catch (error) {
      this._locked = false;
      throw error;
    }
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
    if (!this._done) this._locked = false;
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
    const wasLocked = this._locked;
    this._locked = true;
    try {
      if (typeof anim?.cancel === 'function') anim.cancel();
    } catch {
      /* duck-цель могла не реализовать cancel — не роняем прерывание */
    } finally {
      this._locked = wasLocked;
    }
  }

  private _clearTimer(): void {
    this._timerGeneration++;
    const cancel = this._timerCancel;
    this._timerCancel = undefined;
    if (cancel !== undefined) safeCancelTimer(cancel);
  }

  /** Выпускает sync timer только вне host-транзакции и ровно один раз. */
  private _flushNatural(): void {
    if (
      this._o._record._owner !== this ||
      !this._pendingNatural ||
      this._done ||
      this._o._record._transition ||
      this._locked
    ) return;
    this._pendingNatural = false;
    this._locked = true;
    this._clearTimer();
    // Hostile cancel-timer мог повторно вызвать callback под lock.
    this._pendingNatural = false;
    this._locked = false;
    this._settleNatural();
  }

  private _settleNatural(): void {
    if (this._done || this._o._record._transition || this._locked || this._paused) return;
    for (const ch of this._o._numeric) {
      ch._value = ch._to;
      ch._velocity = 0;
    }
    // Успешный inline hold позволяет снять fill:both effect и освободить host.
    // При hostile style сам effect остаётся визуальным fallback, но логическая
    // ссылка отпускается и aggregate продолжает терминализацию.
    this._locked = true;
    try {
      this._holdInline();
      this._cancelAnim();
    } catch {
      this._anim = undefined;
    }
    this._writeBack();
    this._finish(true);
  }

  private _writeBack(): void {
    const rec = this._o._record;
    for (const ch of this._o._numeric) {
      rec._numeric.set(ch._key, { _value: ch._value, _velocity: 0 });
    }
    this._o._residuals.forEach((v, k) => {
      if (!rec._numeric.has(k)) rec._numeric.set(k, { _value: v, _velocity: 0 });
    });
  }

  private _finish(natural: boolean): void {
    if (this._done) return;
    this._done = true;
    if (this._o._record._owner === this) this._o._record._owner = undefined;
    this._o._onDone(natural);
  }
}

/** Значение канала при прогрессе p; края возвращают ТОЧНЫЕ from/to (без fp-дрейфа). */
function channelAt(ch: NumericChannel, p: number): number {
  if (p === 0) return ch._from;
  if (p === 1) return ch._to;
  // Взвешенная форма не переполняется на конечном интервале MAX ↔ -MAX;
  // за его пределами сохраняет реальный overshoot, пока он представим.
  const v = (1 - p) * ch._from + p * ch._to;
  return Number.isFinite(v) ? v : ch._to;
}

function safeCancelTimer(cancel: () => void): void {
  try {
    cancel();
  } catch {
    /* отказ host-cleanup не должен блокировать остальную терминализацию */
  }
}
