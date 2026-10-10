/** Один aggregate scheduler: все compute, затем все DOM-write. */

import { createFrameLoop, frame as defaultFrame, type FrameLoop } from '../frame/index.js';
import type { MutableSpringBasis } from './solver.js';
import { sampleSpringBasisUnchecked } from './solver.js';
import type { RequestFrameFn } from '../motion-value.js';
import type { SpringParams } from '../spring.js';

/** Узкий контракт не создаёт обратную runtime-зависимость на MainUnit. */
export interface SurfaceUnit {
  _batchSlot: number;
  _updateStep(ts: number | undefined): void;
  _renderStep(): void;
  _batchAbort(): void;
  _batchRollback(error?: unknown): void;
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
  private _pending: Array<() => void> = [];
  private _draining = false;
  private _holes = 0;
  /** -1 вне кадра; иначе зафиксированная граница update→render. */
  private _end = -1;
  private _offUpdate: (() => void) | undefined;
  private _offRender: (() => void) | undefined;
  private _subscribing = false;
  private readonly _frameTeardown = (): void => {
    const end = this._units.length;
    for (let i = 0; i < end; i++) {
      try { this._units[i]?._batchAbort(); } catch { /* teardown siblings обязаны освободиться */ }
    }
    this._teardown();
    if (this._units.length === this._holes) this._resetStorage();
  };

  constructor(frame: FrameLoop) {
    this._frame = frame;
  }

  _after(action: () => void): void {
    if (this._pending.length === 0) queueMicrotask(() => this._flush());
    this._pending.push(action);
  }

  _flush(): void {
    if (this._draining) return;
    this._draining = true;
    const failures: unknown[] = [];
    try {
      while (this._pending.length) {
        const actions = this._pending; this._pending = [];
        for (const action of actions) {
          try { action(); } catch (error) { failures.push(error); }
        }
      }
    } finally { this._draining = false; }
    if (failures.length) throw failures.length === 1 ? failures[0]
      : new AggregateError(failures, 'Ошибка отложенного управления');
  }

  _add(unit: SurfaceUnit, paused: boolean): void {
    // Один проход обслуживает накопившиеся удаления. Порог в половину списка
    // ограничивает пустые slots и сохраняет линейную цену массового retarget.
    if (this._end < 0 && this._holes > 0 && this._holes * 2 >= this._units.length) this._compact();
    const slot = this._units.length;
    this._units.push(unit);
    unit._batchSlot = slot;
    if (paused) return;
    this._active++;
    try {
      this._subscribe();
    } catch (error) {
      // Host reentry мог сдвинуть unit compaction-ом: identity живёт в slot unit.
      const current = unit._batchSlot;
      if (current >= 0 && this._units[current] === unit) {
        this._units[current] = undefined;
        this._holes++;
        unit._batchSlot = -1;
      }
      if (this._units.length === this._holes) this._resetStorage();
      else if (this._end < 0) this._compact();
      throw error;
    }
  }

  _activate(unit: SurfaceUnit): void {
    if (unit._batchSlot < 0) return;
    this._active++;
    this._subscribe();
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
    unit._batchSlot = -1;
    if (!paused && --this._active === 0) this._teardown();
    if (this._units.length === this._holes) this._resetStorage();
  }

  _springBasis(spring: SpringParams, t: number): Readonly<MutableSpringBasis> {
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
    this._end = this._units.length;
    for (let i = 0; i < this._end; i++) {
      const unit = this._units[i];
      if (!unit) continue;
      try { unit._updateStep(ts); } catch {
        try { unit._batchAbort(); } catch { /* cleanup одного slot не прерывает кадр */ }
      }
    }
    this._flush();
    // Pause/cancel-all в update снимает render-подписку: второй
    // фазы не будет, значит stable compaction уже безопасна.
    if (this._active === 0) {
      this._end = -1;
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
    this._flush();
    this._end = -1;
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
    this._end = -1;
  }

  private _subscribe(): void {
    if (this._offUpdate !== undefined || this._active === 0 || this._subscribing) return;
    this._subscribing = true;
    let offUpdate: (() => void) | undefined;
    try {
      offUpdate = this._frame.update(
        (ts) => this._runUpdate(ts),
        { onTeardown: this._frameTeardown },
      );
      if (this._active === 0) {
        this._subscribing = false;
        offUpdate();
        return;
      }
      const offRender = this._frame.render(() => this._runRender());
      this._offUpdate = offUpdate;
      this._offRender = offRender;
      this._subscribing = false;
      if (this._active === 0) this._teardown();
    } catch (error) {
      if (this._subscribing) {
        // Всё, что reentrant host присоединил до commit общей пары, принадлежит
        // той же попытке. Cleanup остаётся внутри неё и не подменяет host-error.
        try { offUpdate?.(); } catch { /* исходная host-ошибка приоритетна */ }
        this._active = 0;
        for (let i = 0; i < this._units.length; i++) {
          try { this._units[i]?._batchRollback(error); } catch { /* sibling rollback продолжается */ }
        }
        this._active = 0;
        this._subscribing = false;
      }
      throw error;
    }
  }

  private _teardown(): void {
    const update = this._offUpdate;
    const render = this._offRender;
    this._offUpdate = undefined;
    this._offRender = undefined;
    const errors: unknown[] = [];
    try { update?.(); } catch (error) { errors.push(error); }
    try { render?.(); } catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0]
      : new AggregateError(errors, 'Frame cleanup failed');
  }
}

// Владелец цикла определяет batch независимо от публичной точки входа.
const batches = new WeakMap<FrameLoop, SurfaceBatch>();

export function surfaceBatchForFrame(frame: FrameLoop): SurfaceBatch {
  let batch = batches.get(frame);
  if (!batch) { batch = new SurfaceBatch(frame); batches.set(frame, batch); }
  return batch;
}

export function surfaceBatchFor(requestFrame: RequestFrameFn | undefined): SurfaceBatch {
  return requestFrame === undefined
    ? surfaceBatchForFrame(defaultFrame)
    : new SurfaceBatch(createFrameLoop({ requestFrame }));
}
