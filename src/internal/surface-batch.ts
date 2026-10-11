/** Один aggregate scheduler: все compute, затем все DOM-write. */

import { createFrameLoop, frame as defaultFrame, type FrameLoop } from '../frame/index.js';
import type { RequestFrameFn } from '../motion-value.js';

/** Узкий контракт не создаёт обратную runtime-зависимость на MainUnit. */
export interface SurfaceUnit {
  slot: number;
  update(ts: number | undefined): void;
  render(): void;
  abort(): void;
  rollback(error?: unknown): void;
}

/** Две FrameLoop-подписки независимо от числа поверхностей aggregate. */
export class SurfaceBatch {
  private readonly _units = new Set<SurfaceUnit>();
  private _serial = 0;
  private _end = -1;
  private _active = 0;
  declare defer?: (action: () => void) => void;
  declare flush?: () => void;
  private _offUpdate: (() => void) | undefined;
  private _offRender: (() => void) | undefined;
  private _subscribing = false;

  constructor(private readonly _frame: FrameLoop) {}

  add(unit: SurfaceUnit, paused: boolean): void {
    unit.slot = this._serial++;
    this._units.add(unit);
    if (paused) return;
    this._active++;
    try { this._subscribe(); }
    catch (error) { this.remove(unit, true); throw error; }
  }
  activate(unit: SurfaceUnit): void {
    if (unit.slot < 0) return;
    this._active++;
    this._subscribe();
  }
  deactivate(unit: SurfaceUnit): void {
    if (unit.slot >= 0 && --this._active === 0) this._teardown();
  }
  remove(unit: SurfaceUnit, paused: boolean): void {
    if (!this._units.delete(unit)) return;
    unit.slot = -1;
    if (!paused && --this._active === 0) this._teardown();
    if (!this._units.size && this._end < 0) this._serial = 0;
  }
  private _run(phase: 'update' | 'render', ts?: number): void {
    if (phase === 'update') this._end = this._serial;
    for (const unit of this._units) {
      if (unit.slot >= this._end) break;
      try { unit[phase](ts); } catch {
        try { unit.abort(); } catch { /* ошибка владельца не удерживает соседей */ }
      }
    }
    this.flush?.();
    if (phase === 'render' || this._active === 0) this._endFrame();
  }
  private _endFrame(): void {
    this._end = -1;
    if (!this._units.size) this._serial = 0;
  }
  private readonly _frameTeardown = (): void => {
    const previous = this._end;
    this._end = this._serial;
    for (const unit of this._units) {
      if (unit.slot >= this._end) break;
      try { unit.abort(); } catch { /* ошибка одного владельца не удерживает соседей */ }
    }
    this._end = previous;
    this._teardown();
    if (!this._units.size && this._end < 0) this._serial = 0;
  };
  private _subscribe(): void {
    if (this._offUpdate !== undefined || this._active === 0 || this._subscribing) return;
    this._subscribing = true;
    let offUpdate: (() => void) | undefined;
    try {
      offUpdate = this._frame.update(ts => this._run('update', ts), { onTeardown: this._frameTeardown });
      if (this._active === 0) { this._subscribing = false; offUpdate(); return; }
      const offRender = this._frame.render(() => this._run('render'));
      this._offUpdate = offUpdate; this._offRender = offRender;
      this._subscribing = false;
      if (this._active === 0) this._teardown();
    } catch (error) {
      if (this._subscribing) {
        try { offUpdate?.(); } catch { /* исходная ошибка остаётся причиной */ }
        this._active = 0;
        for (const unit of this._units) {
          try { unit.rollback(error); } catch { /* откат остальных владельцев обязателен */ }
        }
        this._active = 0; this._subscribing = false;
      }
      throw error;
    }
  }
  private _teardown(): void {
    const update = this._offUpdate, render = this._offRender;
    this._offUpdate = this._offRender = undefined;
    const errors: unknown[] = [];
    try { update?.(); } catch (error) { errors.push(error); }
    try { render?.(); } catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0]
      : new AggregateError(errors, 'Frame cleanup failed');
  }
}

const batches = new WeakMap<FrameLoop, SurfaceBatch>();

export function surfaceBatchForFrame(frame: FrameLoop): SurfaceBatch {
  let batch = batches.get(frame);
  if (!batch) { batch = new SurfaceBatch(frame); batches.set(frame, batch); }
  return batch;
}

export function surfaceBatchFor(requestFrame: RequestFrameFn | undefined): SurfaceBatch {
  return surfaceBatchForFrame(requestFrame === undefined ? defaultFrame : createFrameLoop({ requestFrame }));
}
