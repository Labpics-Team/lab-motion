import { MotionParamError } from '../errors.js';
import type { MotionValue } from '../motion-value.js';
import { createInputVelocityTracker, DEFAULT_VELOCITY_WINDOW_S, type InputVelocityTracker } from '../internal/velocity-tracker.js';
import { CompositorSpring, type CompositorSpringOptions } from './core.js';

/** Один spring-owner для прямого ввода и автономного продолжения. */
export interface CompositorFollow extends Pick<CompositorSpring,
  'tier' | 'mode' | 'value' | 'start' | 'retarget' | 'handoffToLive' | 'stop' | 'destroy'> {
  /** Захватить текущее значение и скорость; timestamp входного потока в секундах. */
  beginFollow(tSeconds: number): number;
  /** Передать абсолютное значение и неубывающий timestamp того же потока. */
  follow(value: number, tSeconds: number): void;
  /** Отпустить ввод в target; timestamp учитывает неподвижное удержание. */
  settle(target: number, tSeconds: number): void;
}

/** Универсальный input-протокол; UI определяет координаты, ограничения и конечную цель. */
export function createCompositorFollow(options: CompositorSpringOptions): CompositorFollow {
  return new InputSpring(options);
}

class InputSpring extends CompositorSpring implements CompositorFollow {
  private _following: {
    tracker: InputVelocityTracker;
    t: number;
    at: number;
    origin: number;
    velocity: number;
  } | undefined;

  beginFollow(tSeconds: number): number {
    if (!this._now || this._cleaning) return this._from;
    this._validateInputTime(tSeconds);
    if (!this._apply) throw new MotionParamError('LM182');
    const generation = ++this._epoch;
    const previous = this._from;
    const following = this._following;
    const mv = this._mv;
    let value = previous;
    let velocity = following ? this._inputVelocity() : mv?.velocity ?? 0;
    if (this._host && !mv && !following) {
      const read = this._snapshot(generation);
      if (!read) return this._from;
      value = read.value;
      velocity = read.velocity;
    }
    const tracker = createInputVelocityTracker();
    if (velocity !== 0) {
      const dt = DEFAULT_VELOCITY_WINDOW_S / 2;
      tracker.push(-velocity * dt, -dt);
    }
    tracker.push(0, 0);
    // Live callback теряет право записи до вызова пользовательского writer.
    // При ошибке writer сохранённый MotionValue остаётся остановленным и повторяемым.
    mv?.stop();
    this._following = { tracker, t: tSeconds, at: tSeconds, origin: value, velocity };
    this._mv = undefined;
    try {
      // Reentry видит новый ввод; native donor снимается после underlying-записи.
      this._onLiveFrame(value);
    } catch (error) {
      if (this._epoch === generation) {
        this._from = previous;
        this._following = following;
        this._mv = mv;
      } else mv?.destroy();
      throw error;
    }
    mv?.destroy();
    if (this._epoch === generation) this._releaseHost();
    return this._from;
  }

  follow(value: number, tSeconds: number): void {
    if (!this._now || this._cleaning) return;
    this._validateValue(value);
    this._trackInput(value, tSeconds);
    this._epoch++;
    this._onLiveFrame(value);
  }

  settle(target: number, tSeconds: number): void {
    if (!this._now || this._cleaning) return;
    this._validateValue(target);
    this._trackInput(this._from, tSeconds);
    this.retarget(target);
  }

  override start(): void {
    if (this._following) this.retarget(this._to);
    else super.start();
  }

  override retarget(target: number): void {
    if (!this._following) return super.retarget(target);
    if (!this._now || this._cleaning) return;
    this._validateValue(target);
    if (this._tier === 3) {
      this._following = undefined;
      super.retarget(target);
    } else {
      this._retargetFrom(this._from, this._inputVelocity(), target, ++this._epoch);
    }
  }

  override handoffToLive(target?: number): MotionValue {
    if (!this._following || !this._now || this._cleaning) return super.handoffToLive(target);
    if (target !== undefined) this._validateValue(target);
    const generation = ++this._epoch;
    const to = target ?? this._to;
    const mv = this._liveCandidate(
      this._tier === 3 ? to : this._from,
      this._tier === 3 ? 0 : this._inputVelocity(),
      generation,
    );
    this._adoptLive(mv, to, generation);
    return mv;
  }

  override stop(): void {
    if (!this._cleaning) this._following = undefined;
    super.stop();
  }

  override destroy(): void {
    this._following = undefined;
    super.destroy();
  }

  protected override _commitOwner(): void { this._following = undefined; }

  private _validateValue(value: number): void {
    if (!Number.isFinite(value)) throw new MotionParamError('LM009');
  }

  private _validateInputTime(t: number): void {
    if (!Number.isFinite(t) || (this._following && t < this._following.t)) {
      throw new MotionParamError('LM183');
    }
  }

  private _trackInput(value: number, t: number): void {
    this._validateInputTime(t);
    if (!this._following) throw new MotionParamError('LM184');
    const input = this._following;
    input.t = t;
    input.tracker.push(value - input.origin, t - input.at);
  }

  private _inputVelocity(): number {
    const input = this._following!;
    // При немедленном re-release prior не проходит через вычитание больших координат/часов.
    return input.t === input.at && this._from === input.origin
      ? input.velocity : input.tracker.velocity();
  }
}
