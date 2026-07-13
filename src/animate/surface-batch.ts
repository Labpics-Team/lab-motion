/** Один aggregate scheduler: все compute, затем все DOM-write. */

import { createFrameLoop, frame as defaultFrame, type FrameLoop } from '../frame/index.js';
import type { MutableSpringBasis } from '../internal/solver.js';
import { sampleSpringBasisUnchecked } from '../internal/solver.js';
import type { RequestFrameFn } from '../motion-value.js';
import type { SpringParams } from '../spring.js';

/** Узкий контракт не создаёт обратную runtime-зависимость на MainUnit. */
export interface SurfaceUnit {
  _batchSlot: number;
  _updateStep(ts: number | undefined): void;
  _renderStep(): void;
  _batchAbort(): void;
}

/** Две FrameLoop-подписки независимо от числа поверхностей aggregate. */
export class SurfaceBatch {
  private readonly _frame: FrameLoop;
  private readonly _units: Array<SurfaceUnit | undefined> = [];
  private readonly _basis: MutableSpringBasis = {
    _value: 0,
    _valueV0: 0,
    _velocity: 0,
    _velocityV0: 0,
  };
  private _basisSpring: SpringParams | undefined;
  private _basisTime = NaN;
  private _active = 0;
  private _live = 0;
  private _holes = 0;
  private _betweenPhases = false;
  private _end = 0;
  private _offUpdate: (() => void) | undefined;
  private _offRender: (() => void) | undefined;
  private readonly _frameTeardown = (): void => {
    const end = this._units.length;
    for (let i = 0; i < end; i++) {
      try { this._units[i]?._batchAbort(); } catch { /* teardown siblings обязаны освободиться */ }
    }
    this._teardown();
    if (this._live === 0) this._resetStorage();
  };

  constructor(frame: FrameLoop) {
    this._frame = frame;
  }

  _add(unit: SurfaceUnit, paused: boolean): void {
    // Persistent default-pool не должен расти от churn после peak live.
    if (!this._betweenPhases && this._holes > 0) this._compact();
    const slot = this._units.length;
    this._units.push(unit);
    this._live++;
    unit._batchSlot = slot;
    if (paused) return;
    this._active++;
    try {
      this._subscribe();
    } catch (error) {
      this._active--;
      if (this._units[slot] === unit) {
        this._units[slot] = undefined;
        this._holes++;
        this._live--;
      }
      unit._batchSlot = -1;
      if (this._live === 0) this._resetStorage();
      throw error;
    }
  }

  _activate(unit: SurfaceUnit): void {
    if (unit._batchSlot < 0) return;
    if (!this._betweenPhases && this._holes > 0) this._compact();
    this._active++;
    try {
      this._subscribe();
    } catch (error) {
      this._active--;
      throw error;
    }
  }

  _deactivate(unit: SurfaceUnit): void {
    if (unit._batchSlot < 0) return;
    if (--this._active === 0) this._teardown();
  }

  _remove(unit: SurfaceUnit, paused: boolean): void {
    const slot = unit._batchSlot;
    if (slot < 0 || this._units[slot] !== unit) return;
    this._units[slot] = undefined;
    this._holes++;
    this._live--;
    unit._batchSlot = -1;
    if (!paused && --this._active === 0) this._teardown();
    if (this._live === 0) this._resetStorage();
  }

  _springBasis(spring: SpringParams, t: number): MutableSpringBasis {
    const cached = this._basisSpring;
    if (
      t !== this._basisTime ||
      cached === undefined ||
      (spring !== cached && (
        spring.mass !== cached.mass ||
        spring.stiffness !== cached.stiffness ||
        spring.damping !== cached.damping
      ))
    ) {
      sampleSpringBasisUnchecked(spring, t, this._basis);
    }
    // Следующая группа того же animate попадает в identity-fast-path,
    // а равные snapshot-объекты разных вызовов — в физический ключ.
    this._basisSpring = spring;
    this._basisTime = t;
    return this._basis;
  }

  private _runUpdate(ts: number | undefined): void {
    this._betweenPhases = true;
    this._end = this._units.length;
    for (let i = 0; i < this._end; i++) {
      const unit = this._units[i];
      if (!unit) continue;
      try { unit._updateStep(ts); } catch {
        try { unit._batchAbort(); } catch { /* cleanup одного slot не прерывает кадр */ }
      }
    }
    // Pause/cancel-all в update снимает render-подписку: второй
    // фазы не будет, значит stable compaction уже безопасна.
    if (this._active === 0) {
      this._betweenPhases = false;
      this._compact();
    }
  }

  private _runRender(): void {
    for (let i = 0; i < this._end; i++) {
      const unit = this._units[i];
      if (!unit) continue;
      try { unit._renderStep(); } catch {
        try { unit._batchAbort(); } catch { /* cleanup одного slot не прерывает кадр */ }
      }
    }
    this._betweenPhases = false;
    this._compact();
  }

  private _compact(): void {
    if (this._holes === 0) return;
    let write = 0;
    for (let read = 0; read < this._units.length; read++) {
      const unit = this._units[read];
      if (!unit) continue;
      this._units[write] = unit;
      unit._batchSlot = write++;
    }
    this._units.length = write;
    this._holes = 0;
  }

  private _resetStorage(): void {
    this._units.length = 0;
    this._holes = 0;
    this._end = 0;
  }

  private _subscribe(): void {
    if (this._offUpdate !== undefined || this._active === 0) return;
    let offUpdate: (() => void) | undefined;
    try {
      offUpdate = this._frame.update(
        (ts) => this._runUpdate(ts),
        { onTeardown: this._frameTeardown },
      );
      if (this._active === 0) {
        offUpdate();
        return;
      }
      const offRender = this._frame.render(() => this._runRender());
      this._offUpdate = offUpdate;
      this._offRender = offRender;
      if (this._active === 0) this._teardown();
    } catch (error) {
      offUpdate?.();
      throw error;
    }
  }

  private _teardown(): void {
    const update = this._offUpdate;
    const render = this._offRender;
    this._offUpdate = undefined;
    this._offRender = undefined;
    update?.();
    render?.();
  }
}

// Batch принадлежит scheduler, а не отдельному animate-вызову: так
// любая форма массового API платит за одни update+render на кадр.
const sharedDefaultBatch = new SurfaceBatch(defaultFrame);

export function surfaceBatchFor(requestFrame: RequestFrameFn | undefined): SurfaceBatch {
  return requestFrame === undefined
    ? sharedDefaultBatch
    : new SurfaceBatch(createFrameLoop({ requestFrame }));
}
