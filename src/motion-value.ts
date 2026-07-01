/**
 * motion-value.ts — L3 Headless reactive value driven by spring physics.
 *
 * A MotionValue holds a numeric value and animates it toward a target using
 * a spring solver. When the target changes mid-flight, the current velocity
 * is smoothly injected into the new spring run (no discontinuity / "jank").
 *
 * Invariants (matching the package-level invariants in index.ts):
 *   1. Zero runtime deps — no DOM, no window, no document, no Element.
 *   2. CSS-safe — only finite values emitted via onChange; never NaN/Infinity.
 *   3. Deterministic — clock is injected via requestFrame seam; no global reads.
 *   4. Smooth pickup — setTarget() mid-flight preserves the current velocity as
 *      the initial condition for the new spring run (closed-form solution with
 *      arbitrary initial velocity v0, not just v0=0).
 *   5. Domain purity — requestFrame is the only platform seam; injectable for
 *      tests. No _mockElement, no Element, no querySelector.
 *
 * Physics:
 *   Solves the spring ODE with general initial conditions x(0)=0, x'(0)=v0
 *   (normalized). The standard rest-to-target solution (v0=0) is a special case.
 *   All three regimes (underdamped, critically damped, overdamped) are handled.
 *
 * Frame scheduling:
 *   Reuses the same injectable requestFrame seam as drive.ts. If the injected
 *   clock returns handle=0 (non-draining test step-clock convention), a
 *   setTimeout(0) fallback is installed so the loop always makes progress.
 *   In production, pass `requestAnimationFrame.bind(window)`.
 */

import { type SpringParams, validateSpringParams } from './spring.js';
import { MotionParamError } from './errors.js';

// ─── Physics: spring with arbitrary initial velocity ────────────────────────

/**
 * Evaluate the spring ODE at time t with initial conditions:
 *   x(0) = 0  (normalized: start = 0, target = 1)
 *   x'(0) = v0  (normalized velocity in units of range/s)
 *
 * Returns { value, velocity } in normalized space.
 *
 * Derivation sketch (standard second-order ODE):
 *   m*x'' + c*x' + k*x = k
 *   Let u = x - 1  (shift so equilibrium is 0):
 *   m*u'' + c*u' + k*u = 0,  u(0)=-1, u'(0)=v0
 *   Standard general solution per damping regime.
 */
function springWithV0(params: SpringParams, t: number, v0: number): { value: number; velocity: number } {
  const { mass: m, stiffness: k, damping: c } = params;

  if (t <= 0) {
    return { value: 0, velocity: v0 };
  }

  const omega0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));

  let value: number;
  let velocity: number;

  if (zeta < 1) {
    // Underdamped
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega0 * t);
    // u(0)=-1, u'(0)=v0
    // u(t) = e^{-zeta*omega0*t} * (A*cos(omegaD*t) + B*sin(omegaD*t))
    // A = u(0) = -1
    // B = (u'(0) + zeta*omega0*A) / omegaD = (v0 + zeta*omega0*(-1)) / omegaD
    const A = -1;
    const B = (v0 - zeta * omega0) / omegaD;
    const cosD = Math.cos(omegaD * t);
    const sinD = Math.sin(omegaD * t);
    const u = decay * (A * cosD + B * sinD);
    // x = 1 + u
    value = 1 + u;
    // x' = u' = decay * [(-zeta*omega0)*(A*cosD+B*sinD) + omegaD*(-A*sinD+B*cosD)]
    const uPrime =
      decay * ((-zeta * omega0) * (A * cosD + B * sinD) + omegaD * (-A * sinD + B * cosD));
    velocity = uPrime;
  } else if (zeta === 1) {
    // Critically damped
    // u(t) = (A + B*t)*e^{-omega0*t}, u(0)=-1, u'(0)=v0
    // A = -1, B = u'(0) + omega0*A = v0 - omega0
    const A = -1;
    const B = v0 - omega0;
    const decay = Math.exp(-omega0 * t);
    const u = (A + B * t) * decay;
    value = 1 + u;
    // u' = B*e + (A+B*t)*(-omega0)*e = e*[B - omega0*(A+B*t)]
    velocity = decay * (B - omega0 * (A + B * t));
  } else {
    // Overdamped
    const sqrtTerm = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega0 * (zeta - sqrtTerm);
    const r2 = -omega0 * (zeta + sqrtTerm);
    // u(t) = A1*e^{r1*t} + A2*e^{r2*t}
    // A1 + A2 = u(0) = -1
    // r1*A1 + r2*A2 = u'(0) = v0
    // Solving: A1 = (v0 - r2*(-1)) / (r1 - r2) = (v0 + r2) / (r1 - r2)
    //          A2 = -1 - A1
    const A1 = (v0 + r2) / (r1 - r2);
    const A2 = -1 - A1;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    const u = A1 * e1 + A2 * e2;
    value = 1 + u;
    velocity = A1 * r1 * e1 + A2 * r2 * e2;
  }

  // Guard against floating-point edge cases (e.g. t=Infinity, critical damping limit)
  if (!Number.isFinite(value)) value = 1;
  if (!Number.isFinite(velocity)) velocity = 0;

  return { value, velocity };
}

// ─── Public types ────────────────────────────────────────────────────────────

/** Injectable frame scheduler seam — same contract as in drive.ts. */
export type RequestFrameFn = (cb: (ts?: number) => void) => number;

/** Options for constructing a MotionValue. */
export interface MotionValueOptions {
  /** Initial numeric value. Must be finite. */
  readonly initial: number;
  /** Spring physics parameters. */
  readonly spring: SpringParams;
  /**
   * Injectable requestAnimationFrame substitute.
   * Receives a callback, returns a handle (0 = non-draining test step-clock).
   * If omitted, falls back to the global requestAnimationFrame (if available)
   * or a setTimeout(~16ms) shim for Node environments.
   */
  readonly requestFrame?: RequestFrameFn | undefined;
}

// ─── MotionValue ─────────────────────────────────────────────────────────────

/**
 * A headless reactive numeric value that animates toward its target using
 * spring physics with smooth velocity pickup on re-target.
 *
 * Usage:
 *   const mv = new MotionValue({ initial: 0, spring: { mass:1, stiffness:200, damping:20 } });
 *   mv.onChange(v => element.style.opacity = String(v));
 *   mv.setTarget(1);   // starts animating toward 1
 *   mv.setTarget(0.5); // smooth pickup: continues with current velocity
 *   mv.destroy();      // stop and clean up
 */
export class MotionValue {
  // ── Internal state ──────────────────────────────────────────────────────

  /** Current output value (absolute, in caller's units). */
  private _value: number;
  /**
   * Current velocity (units/s, in caller's units).
   * Injected as v0 into the next spring run on setTarget().
   */
  private _velocity: number = 0;

  /** Active spring params. */
  private readonly _spring: SpringParams;

  /** Injected frame scheduler. */
  private readonly _requestFrame: RequestFrameFn;

  /** Registered onChange subscribers. */
  private readonly _listeners: Set<(value: number) => void> = new Set();

  // ── Animation run state (reset on each setTarget) ───────────────────────

  /** Start value of the current run. */
  private _from: number;
  /** Target value of the current run. */
  private _target: number;
  /** Start velocity of the current run (normalized by range, for the solver). */
  private _v0Normalized: number = 0;
  /** Elapsed seconds since the start of the current run. */
  private _elapsed: number = 0;
  /** Timestamp of the first frame in the current run. */
  private _startTs: number | undefined;

  /** Whether a frame loop is currently active. */
  private _running: boolean = false;
  /** Whether destroy() has been called. */
  private _destroyed: boolean = false;
  /** Single-flight re-entrancy guard for the tick body. */
  private _tickActive: boolean = false;
  /** Whether to use setTimeout fallback (handle=0 path). */
  private _useTimeoutFallback: boolean = false;

  /** Fixed timestep fallback (seconds) when no DOMHighResTimeStamp available. */
  private static readonly FIXED_DT_S = 1 / 60;
  /** Convergence threshold (normalized, same as drive.ts). */
  private static readonly CONVERGENCE_THRESHOLD = 0.005;
  /** Hard frame cap per run (prevents infinite loops on pathological params). */
  private static readonly MAX_FRAMES = 2000;
  /** Frame counter for the current run. */
  private _frameCount: number = 0;

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(opts: MotionValueOptions) {
    if (!Number.isFinite(opts.initial)) {
      throw new MotionParamError(
        `MotionValue: 'initial' must be a finite number, got ${opts.initial}`,
      );
    }
    validateSpringParams(opts.spring);

    this._value = opts.initial;
    this._from = opts.initial;
    this._target = opts.initial;
    this._spring = opts.spring;
    this._requestFrame = opts.requestFrame ?? MotionValue._defaultRequestFrame;
  }

  /** Default requestFrame: global rAF or setTimeout(~16ms) shim for Node. */
  private static _defaultRequestFrame(cb: (ts?: number) => void): number {
    if (typeof requestAnimationFrame !== 'undefined') {
      return requestAnimationFrame(cb);
    }
    return setTimeout(cb, MotionValue.FIXED_DT_S * 1000) as unknown as number;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Returns the current value. Always finite. */
  get value(): number {
    return this._value;
  }

  /**
   * Register a listener that receives every emitted value (including the
   * current value immediately on subscription).
   * Returns an unsubscribe function.
   */
  onChange(cb: (value: number) => void): () => void {
    this._listeners.add(cb);
    // Emit current value immediately so the consumer can initialize.
    cb(this._value);
    return () => {
      this._listeners.delete(cb);
    };
  }

  /**
   * Animate the value toward `target` using spring physics.
   *
   * If called while a previous animation is in flight, the current velocity
   * is smoothly carried over as the initial condition for the new run —
   * no discontinuity in the output sequence.
   *
   * @param target - Finite target value.
   */
  setTarget(target: number): void {
    if (this._destroyed) return;
    if (!Number.isFinite(target)) {
      throw new MotionParamError(
        `MotionValue.setTarget: target must be a finite number, got ${target}`,
      );
    }

    // Snap instantly if already at target with negligible velocity.
    if (target === this._value && Math.abs(this._velocity) < 1e-10) {
      this._target = target;
      return;
    }

    // ── Smooth pickup: capture current velocity before resetting run state ──
    const currentVelocity = this._velocity; // units/s
    const range = target - this._value;

    // Normalize velocity by range for the spring solver (which works in
    // normalized [0→1] space). Guard division by zero when range ≈ 0.
    const v0Normalized = Math.abs(range) > 1e-10 ? currentVelocity / range : 0;

    // ── Reset run state ──────────────────────────────────────────────────
    this._from = this._value;
    this._target = target;
    this._v0Normalized = v0Normalized;
    this._elapsed = 0;
    this._startTs = undefined;
    this._frameCount = 0;
    this._useTimeoutFallback = false;

    // ── Start frame loop (idempotent: only one loop runs at a time) ──────
    if (!this._running) {
      this._running = true;
      this._scheduleFirstFrame();
    }
    // If already running, the active loop will pick up the new _target/_from/_v0Normalized
    // on its next tick (because it re-reads these fields). The loop is already scheduled.
  }

  /**
   * Stop the animation and remove all listeners.
   * After destroy(), setTarget() and onChange() are no-ops.
   */
  destroy(): void {
    this._destroyed = true;
    this._running = false;
    this._listeners.clear();
  }

  /**
   * Halt the running frame loop without destroying the instance: no further
   * ticks fire, but `_destroyed` stays false and listeners are kept — unlike
   * destroy(), a later setTarget() resumes animating normally. For consumers
   * whose host can disconnect and reconnect (e.g. Lit hostDisconnected/
   * hostConnected) without permanently killing the value.
   */
  stop(): void {
    this._running = false;
    this._startTs = undefined;
    this._elapsed = 0;
  }

  // ── Private: animation loop ──────────────────────────────────────────────

  private _scheduleFirstFrame(): void {
    const handle = this._requestFrame((ts) => this._tick(ts));
    if (handle === 0) {
      this._useTimeoutFallback = true;
      setTimeout(() => this._tick(undefined), 0);
    }
  }

  private _tick(ts: number | undefined): void {
    if (!this._running || this._destroyed) return;
    if (this._tickActive) return;
    this._tickActive = true;

    // Advance elapsed time.
    if (ts !== undefined) {
      if (this._startTs === undefined) this._startTs = ts;
      this._elapsed = (ts - this._startTs) / 1000;
    } else {
      this._elapsed += MotionValue.FIXED_DT_S;
    }

    this._frameCount++;

    const range = this._target - this._from;
    const absRange = Math.abs(range);

    // Compute new position + velocity from spring solver.
    const { value: normPos, velocity: normVel } = springWithV0(
      this._spring,
      this._elapsed,
      this._v0Normalized,
    );

    // Denormalize: absolute value and velocity.
    const rawValue = this._from + normPos * range;
    const rawVelocity = normVel * range; // units/s

    // Check convergence or hard cap.
    const distToTarget = Math.abs(rawValue - this._target);
    const absVelocity = Math.abs(rawVelocity);
    const converged =
      this._frameCount >= MotionValue.MAX_FRAMES ||
      !Number.isFinite(range) || // unrepresentable span: |from|+|target| overflowed past MAX_VALUE
      (absRange < 1e-10) || // degenerate range
      (distToTarget / Math.max(absRange, 1e-10) < MotionValue.CONVERGENCE_THRESHOLD &&
        absVelocity / Math.max(absRange, 1e-10) < MotionValue.CONVERGENCE_THRESHOLD);

    if (converged) {
      this._value = this._target;
      this._velocity = 0;
      this._running = false;
      this._tickActive = false;
      this._emit(this._target);
      return;
    }

    // Emit clamped value (CSS-safe: clamp to [from, target] or [target, from]).
    const lo = range >= 0 ? this._from : this._target;
    const hi = range >= 0 ? this._target : this._from;
    const clampedValue = Math.max(lo, Math.min(hi, rawValue));

    // Final CSS-safety net (invariant 2): even a finite range can overflow the
    // denormalized product to Inf/NaN at extreme magnitudes. Never emit a
    // non-finite value — the only contract-safe outcome is to snap to the
    // (validated-finite) target. Closes the overflow-NaN class, not one input.
    if (!Number.isFinite(clampedValue) || !Number.isFinite(rawVelocity)) {
      this._value = this._target;
      this._velocity = 0;
      this._running = false;
      this._tickActive = false;
      this._emit(this._target);
      return;
    }

    this._value = clampedValue;
    this._velocity = rawVelocity;
    this._emit(clampedValue);

    this._tickActive = false;

    // Reschedule.
    if (this._useTimeoutFallback) {
      setTimeout(() => this._tick(undefined), 0);
    } else {
      this._requestFrame((t) => this._tick(t));
    }
  }

  private _emit(value: number): void {
    for (const cb of this._listeners) {
      cb(value);
    }
  }
}
