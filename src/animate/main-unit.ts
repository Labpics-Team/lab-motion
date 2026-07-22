/** Main-thread executor одной CSS-поверхности внутри общего SurfaceBatch. */

import { scaleSerializedVelocity } from '../compositor/sample.js';
import { CONVERGENCE_THRESHOLD, FIXED_DT_S, MAX_FRAMES } from '../internal/constants.js';
import { finiteOrZero } from '../internal/finite.js';
import { sampleNumericTrack, type SegmentEase, type TrackAt } from './track.js';
import {
  readSpringFromBasisUnchecked,
  sampleSpringFromBasisUnchecked,
} from '../internal/read-spring.js';
import type { RequestFrameFn } from '../motion-value.js';
import type { SpringParams } from '../spring.js';
import { buildTransform } from '../value/transform.js';
import {
  RANGE_EPSILON,
  channelAt,
  cssAt,
  cssTrackAt,
  type AnimatableElement,
  type BoundGroup,
  type ChannelSnapshot,
  type CssChannel,
  type NumericChannel,
  type GroupKey,
  type GroupOwner,
  type GroupRecord,
} from './channels.js';
import { SurfaceBatch, type SurfaceUnit } from './surface-batch.js';

export type MotionMode =
  | { readonly _type: 'spring'; readonly _spring: SpringParams }
  | {
    readonly _type: 'tween';
    readonly _durationMs: number;
    readonly _ease: (t: number) => number;
    /** Per-segment изинги N-keyframe вызова (#205); undefined — scalar. */
    readonly _eases?: readonly ((t: number) => number)[] | undefined;
  };

export type { RequestFrameFn };

export interface MainUnitOptions {
  readonly _el: AnimatableElement;
  readonly _group: GroupKey;
  readonly _record: GroupRecord;
  readonly _bound: BoundGroup;
  readonly _mode: MotionMode;
  readonly _delayMs: number;
  readonly _batch: SurfaceBatch;
  readonly _onDone: (natural: boolean) => void;
  readonly _onRollback?: (() => void) | undefined;
  readonly _startPaused?: boolean | undefined;
}

const FIXED_DT_MS = FIXED_DT_S * 1000;
const EASE_DERIV_H = 1e-3;

/** Unit хранит семантику группы; scheduler и spring-basis принадлежат aggregate. */
export class MainUnit implements GroupOwner, SurfaceUnit {
  _batchSlot = -1;
  private _o: MainUnitOptions | undefined;
  private _done = false;
  private _paused: boolean;
  private _active = false;
  private _converged = false;
  /** Монотонные часы unit; seek двигает только локальную координату. */
  private _logicalMs = 0;
  /** logical − anchor, сохранённое отдельно от больших абсолютных timestamps. */
  private _phaseMs: number;
  private _tMs = 0;
  private _lastTs: number | undefined;
  private _frames = 0;
  private _tweenK = 0;
  private _renderedTweenK = 0;
  private _tweenDpdt = NaN;
  /**
   * Host-write в полёте (#196): применяемые значения — уже опубликованное
   * поколение поверхности для реентрантного capture/writeBack, хотя
   * rendered-снапшот фиксируется только после успешного возврата setter-а.
   */
  private _writing = false;
  private readonly _snap = { value: 0, velocity: 0 };
  /** Изинг сегмента трека (#205): eases[i] либо scalar; один замкнутый объект. */
  private readonly _easeFor: (segment: number) => SegmentEase | undefined;
  /** Переиспользуемый scratch просмотра трека (ноль аллокаций на кадр). */
  private readonly _trackAt: TrackAt = { _segment: 0, _progress: 0 };

  constructor(options: MainUnitOptions) {
    this._o = options;
    this._paused = options._startPaused === true;
    this._phaseMs = -options._delayMs;
    const mode = options._mode;
    this._easeFor = mode._type === 'tween'
      ? (segment) => mode._eases?.[segment] ?? mode._ease
      : () => undefined;
    try {
      options._batch._add(this, this._paused);
    } catch (error) {
      this._done = true;
      this._o = undefined;
      throw error;
    }
  }

  _captureNum(key: string): ChannelSnapshot | undefined {
    if (this._done) return undefined;
    const o = this._o!;
    const channel = o._bound._numeric.find((item) => item._key === key);
    if (channel !== undefined) {
      // Во время host-write снимок обязан отдать применяемое поколение (#196):
      // hostile setter уже сделал значение видимым до возврата.
      const writing = this._writing;
      // Трек (#205): производная в пространстве значения через семплер;
      // 2-стоповый путь — прежняя формула (to−from)·ease′ бит-в-бит.
      const velocity = !this._active
        ? 0
        : o._mode._type === 'tween'
          ? finiteOrZero(
              channel._stops !== undefined
                ? this._trackDerivative(channel, this._liveTweenK())
                : (channel._to - channel._from) * this._tweenDerivative(this._liveTweenK()),
            )
          : writing ? channel._velocity : channel._renderedVelocity;
      return { _value: writing ? channel._value : channel._renderedValue, _velocity: velocity };
    }
    const frozen = o._bound._residuals.get(key);
    return frozen === undefined ? undefined : { _value: frozen, _velocity: 0 };
  }

  _captureCss(key: string): CssChannel | undefined {
    if (this._done) return undefined;
    const o = this._o!;
    const channel = o._bound._css;
    if (channel === undefined || channel._key !== key) return undefined;
    const writing = this._writing;
    // CSS-трек (#205): значение непрерывно (C⁰), скорость покоя — та же
    // лестница деградации, что var()/смешанные AST в projectCssV0; полный C¹
    // остаётся контрактом числовых каналов и 2-стопового CSS.
    const dpdt = !this._active
      ? 0
      : o._mode._type === 'tween'
        ? channel._stopsAst !== undefined ? 0 : this._tweenDerivative(this._liveTweenK())
        : writing ? channel._dpdt : channel._renderedDpdt;
    return { ...channel, _dpdt: dpdt, _css: writing ? channel._css : channel._renderedCss };
  }

  /** k текущего поколения: во время host-write — применяемый, иначе rendered. */
  private _liveTweenK(): number {
    return this._writing ? this._tweenK : this._renderedTweenK;
  }

  _numericKeys(): readonly string[] {
    if (this._done) return [];
    const bound = this._o!._bound;
    return [...bound._numeric.map((channel) => channel._key), ...bound._residuals.keys()];
  }

  _supersede(replacement?: () => void): void {
    if (this._done) return;
    replacement?.();
    this._writeBack();
    this._finish(false);
  }

  _rollback(): void {
    this._finish(false);
  }

  play(): void {
    if (this._done || !this._paused || this._o!._record._transition) return;
    this._lastTs = undefined;
    this._paused = false;
    try {
      this._o!._batch._activate(this);
    } catch (error) {
      this._paused = true;
      throw error;
    }
  }

  pause(): void {
    if (this._done || this._paused || this._o!._record._transition) return;
    this._paused = true;
    this._o!._batch._deactivate(this);
  }

  seek(tMs: number): void {
    if (this._done || this._o!._record._transition || !Number.isFinite(tMs)) return;
    const localMs = Math.max(0, tMs);
    this._active = true;
    this._tMs = localMs;
    // Seek двигает anchor через локальную координату; logical-часы не откатываются.
    this._phaseMs = localMs;
    this._lastTs = undefined;
    if (this._compute()) this._settle();
    else this._write();
  }

  cancel(): void {
    if (this._done || this._o!._record._transition) return;
    this._batchAbort();
  }

  _updateStep(ts: number | undefined): void {
    if (this._done || this._paused || this._o!._record._transition) return;
    let dt: number;
    if (ts === undefined || !Number.isFinite(ts)) {
      dt = FIXED_DT_MS;
      this._lastTs = undefined;
    } else {
      dt = this._lastTs === undefined ? 0 : ts - this._lastTs;
      this._lastTs = ts;
      if (!Number.isFinite(dt)) {
        dt = FIXED_DT_MS;
        this._lastTs = undefined;
      }
    }
    if (dt < 0) dt = 0;
    this._logicalMs += dt;
    // Signed phase эквивалентна logical-anchor, но не вычитает два почти равных
    // MAX-числа после seek. Пересечение delay сохраняет весь frame-overshoot.
    this._phaseMs += dt;
    if (this._phaseMs >= 0) this._active = true;
    this._tMs = Math.max(0, this._phaseMs);
    if (this._active) {
      this._frames++;
      if (
        this._compute() ||
        (this._frames >= MAX_FRAMES && this._tMs <= 0)
      ) this._converged = true;
    }
  }

  _renderStep(): void {
    if (this._done || this._paused || this._o!._record._transition) return;
    if (this._converged) this._settle();
    else if (this._active) this._write();
  }

  _batchAbort(): void {
    if (this._done) return;
    this._writeBack();
    this._finish(false);
  }

  _batchRollback(): void {
    if (this._done) return;
    this._paused = true;
    this._o!._onRollback?.();
  }

  private _compute(): boolean {
    const o = this._o!;
    const bound = o._bound;
    if (o._mode._type === 'tween') {
      if (this._tMs >= o._mode._durationMs) return true;
      const k = this._tMs / o._mode._durationMs;
      const eased = o._mode._ease(k);
      const progress = Number.isFinite(eased) ? eased : k;
      this._tweenK = k;
      this._tweenDpdt = NaN;
      for (const channel of bound._numeric) {
        // N-keyframe трек (#205) семплируется по сырому k (изинг per-segment);
        // 2-стоповый канал сохраняет прежний глобально-eased путь бит-в-бит.
        channel._value = channel._stops !== undefined
          ? sampleNumericTrack(channel._stops, channel._offsets!, k, this._easeFor, this._trackAt)
          : channelAt(channel, progress);
      }
      const css = bound._css;
      if (css !== undefined) {
        css._css = css._stopsAst !== undefined
          ? cssTrackAt(css, k, this._easeFor, this._trackAt)
          : cssAt(css, progress);
      }
      return false;
    }

    const basis = o._batch._springBasis(o._mode._spring, this._tMs / 1000);
    let converged = true;
    for (const channel of bound._numeric) {
      const range = channel._solverTo - channel._from;
      if (!Number.isFinite(range)) {
        // Нормализованный базис остаётся конечным даже когда физический span
        // переполняется; взвешенная позиция сохраняет представимый MAX ↔ -MAX.
        sampleSpringFromBasisUnchecked(basis, channel._v0, this._snap);
        channel._value = channelAt(channel, this._snap.value);
        channel._velocity = scaleSerializedVelocity(
          this._snap.velocity,
          channel._from,
          channel._solverTo,
        );
        converged = converged &&
          Math.abs(this._snap.value - 1) < CONVERGENCE_THRESHOLD &&
          Math.abs(this._snap.velocity) < CONVERGENCE_THRESHOLD;
        continue;
      }
      readSpringFromBasisUnchecked(
        basis,
        channel._from,
        channel._solverTo,
        channel._v0,
        this._snap,
      );
      channel._value = this._snap.value;
      channel._velocity = this._snap.velocity;
      const scale = Math.max(Math.abs(range), RANGE_EPSILON);
      converged = converged &&
        Math.abs(this._snap.value - channel._solverTo) / scale < CONVERGENCE_THRESHOLD &&
        Math.abs(this._snap.velocity) / scale < CONVERGENCE_THRESHOLD;
    }
    const css = bound._css;
    if (css !== undefined) {
      sampleSpringFromBasisUnchecked(basis, css._v0, this._snap);
      css._dpdt = this._snap.velocity;
      css._css = cssAt(css, this._snap.value);
      converged = converged &&
        Math.abs(this._snap.value - 1) < CONVERGENCE_THRESHOLD &&
        Math.abs(this._snap.velocity) < CONVERGENCE_THRESHOLD;
    }
    return converged;
  }

  /**
   * Производная трека в пространстве значения (units/s, #205): численный
   * дифференциал семплера тем же шагом, что _tweenDerivative. Right-biased
   * скачок нулевой ширины даёт конечную секущую — finiteOrZero страхует край.
   */
  private _trackDerivative(channel: NumericChannel, k: number): number {
    const mode = this._o!._mode;
    if (mode._type !== 'tween') return 0;
    const k0 = k > EASE_DERIV_H ? k - EASE_DERIV_H : 0;
    const k1 = k + EASE_DERIV_H < 1 ? k + EASE_DERIV_H : 1;
    const stops = channel._stops!;
    const offsets = channel._offsets!;
    const raw = ((sampleNumericTrack(stops, offsets, k1, this._easeFor, this._trackAt) -
      sampleNumericTrack(stops, offsets, k0, this._easeFor, this._trackAt)) * 1000) /
      ((k1 - k0) * mode._durationMs);
    return finiteOrZero(raw);
  }

  private _tweenDerivative(k = this._tweenK): number {
    if (k === this._tweenK && !Number.isNaN(this._tweenDpdt)) return this._tweenDpdt;
    const mode = this._o!._mode;
    if (mode._type !== 'tween') return 0;
    const k0 = k > EASE_DERIV_H ? k - EASE_DERIV_H : 0;
    const k1 = k + EASE_DERIV_H < 1 ? k + EASE_DERIV_H : 1;
    const raw = ((mode._ease(k1) - mode._ease(k0)) * 1000) /
      ((k1 - k0) * mode._durationMs);
    const value = finiteOrZero(raw);
    if (k === this._tweenK) this._tweenDpdt = value;
    return value;
  }

  private _write(): void {
    const o = this._o!;
    const bound = o._bound;
    // Host-write и снапшот — одно поколение поверхности (#196): реентрантный
    // successor внутри setter-а видит применяемые значения через _writing,
    // а бросок хоста откатывает поколение (rendered остаётся последним
    // успешным) без stale repair-записи после потери lease.
    this._writing = true;
    try {
      if (o._group === 'transform') {
        const state = bound._transform!;
        for (const channel of bound._numeric) state[channel._key] = channel._value;
        o._el.style.setProperty('transform', buildTransform(state));
      } else if (bound._css !== undefined) {
        o._el.style.setProperty(o._group, String(bound._css._css));
      } else o._el.style.setProperty(o._group, String(bound._numeric[0]!._value));
    } finally {
      this._writing = false;
    }
    for (const channel of bound._numeric) {
      channel._renderedValue = channel._value;
      channel._renderedVelocity = channel._velocity;
    }
    if (bound._css !== undefined) {
      bound._css._renderedCss = bound._css._css;
      bound._css._renderedDpdt = bound._css._dpdt;
    }
    this._renderedTweenK = this._tweenK;
  }

  private _settle(): void {
    if (this._done) return;
    const bound = this._o!._bound;
    for (const channel of bound._numeric) {
      channel._value = channel._to;
      channel._velocity = 0;
    }
    if (bound._css !== undefined) {
      bound._css._css = cssAt(bound._css, 1);
      // Поколение покоя целиком: финальный css без live-производной (#196) —
      // симметрия с занулением _velocity числовых каналов выше.
      bound._css._dpdt = 0;
    }
    // Терминальная ветвь _compute выходит до обновления _tweenK: реентрантный
    // capture на settle-записи считал бы производную ПРОШЛОГО поколения при
    // финальном значении. Ноль в кэше производной (ключ — текущий _tweenK,
    // который capture и запросит) публикует скорость покоя без второй записи.
    this._tweenDpdt = 0;
    this._write();
    // Реентрантный successor внутри settle-записи уже потребил финальное
    // поколение и терминализировал unit: старый owner молча уступает (#196).
    if (this._done) return;
    this._writeBack();
    this._finish(true);
  }

  private _writeBack(): void {
    const o = this._o!;
    const record = o._record;
    const bound = o._bound;
    // Supersede во время host-write фиксирует применяемое поколение (#196),
    // а не rendered-снапшот прошлого кадра.
    const writing = this._writing;
    for (const channel of bound._numeric) {
      record._numeric.set(channel._key, {
        _value: writing ? channel._value : channel._renderedValue,
        _velocity: 0,
      });
    }
    // css без writing-ветки: у css-группы один канал, поэтому successor
    // (live-capture либо его собственный writeBack) всегда перекрывает эту
    // запись до любого чтения rec._cssValue — ветка была бы ненаблюдаемой
    // (эквивалентный мутант) и не оправдывает байтов под size-гейтом.
    if (bound._css !== undefined) record._cssValue = bound._css._renderedCss;
  }

  private _finish(natural: boolean): void {
    if (this._done) return;
    this._done = true;
    const o = this._o!;
    o._batch._remove(this, this._paused);
    if (o._record._owner === this) o._record._owner = undefined;
    const done = o._onDone;
    this._o = undefined;
    done(natural);
  }
}
