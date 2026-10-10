import type { TransformOrder } from './transform.js';
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
  private _pending: Array<() => void> = [];
  private _draining = false;
  private _offUpdate: (() => void) | undefined;
  private _offRender: (() => void) | undefined;
  private _subscribing = false;

  constructor(private readonly _frame: FrameLoop) {}

  defer(action: () => void): void {
    if (this._pending.length === 0) queueMicrotask(() => this.flush());
    this._pending.push(action);
  }
  flush(): void {
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
  private _runUpdate(ts: number | undefined): void {
    this._end = this._serial;
    for (const unit of this._units) {
      if (unit.slot >= this._end) break;
      try { unit.update(ts); } catch {
        try { unit.abort(); } catch { /* остальные владельцы завершают кадр */ }
      }
    }
    this.flush();
    if (this._active === 0) this._endFrame();
  }
  private _runRender(): void {
    for (const unit of this._units) {
      if (unit.slot >= this._end) break;
      try { unit.render(); } catch {
        try { unit.abort(); } catch { /* остальные владельцы завершают кадр */ }
      }
    }
    this.flush();
    this._endFrame();
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
      offUpdate = this._frame.update(ts => this._runUpdate(ts), { onTeardown: this._frameTeardown });
      if (this._active === 0) { this._subscribing = false; offUpdate(); return; }
      const offRender = this._frame.render(() => this._runRender());
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


export interface ChannelSnapshot { readonly value: number; readonly velocity: number }
export interface CssSnapshot {
  readonly value: string | number;
  readonly velocity: readonly number[];
}

/** Владелец CSS-декларации передаёт состояние до замены эффекта. */
export interface SurfaceOwner {
  release?(): void;
  capture?(): void;
  readNumber(key: string): ChannelSnapshot | undefined;
  readCss(key: string): CssSnapshot | undefined;
  keys(): readonly string[];
  replace(replacement?: () => void): void;
}
export interface SurfaceRecord {
  owner: SurfaceOwner | undefined;
  locked: boolean;
  readonly numbers: Map<string, ChannelSnapshot>;
  css: string | number | undefined;
  order?: TransformOrder;
  transform?: string;
}
const registry = new WeakMap<object, Map<string, SurfaceRecord>>();

export function surfaceRecord(element: object, key: string): SurfaceRecord {
  let groups = registry.get(element);
  if (!groups) { groups = new Map(); registry.set(element, groups); }
  let record = groups.get(key);
  if (!record) {
    record = { owner: undefined, locked: false, numbers: new Map(), css: undefined };
    groups.set(key, record);
  }
  return record;
}

export function releaseSurfaceRecord(element: object, key: string, record: SurfaceRecord): void {
  if (!record.owner && !record.locked && !record.numbers.size && record.css === undefined) {
    const groups = registry.get(element);
    if (groups?.get(key) === record) groups.delete(key);
    if (!groups?.size) registry.delete(element);
  }
}

export function findSurfaceRecord(element: object, key: string): SurfaceRecord | undefined {
  return registry.get(element)?.get(key);
}

