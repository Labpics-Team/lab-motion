import type { TransformOrder } from './transform.js';
import type { ValueAST } from '../value/parse.js';
/** Один aggregate scheduler: все compute, затем все DOM-write. */

import { createFrameLoop, frame as defaultFrame, type FrameLoop } from '../frame/index.js';
import type { MutableSpringBasis } from './solver.js';
import { sampleSpringBasisUnchecked } from './solver.js';
import type { RequestFrameFn } from '../motion-value.js';
import type { SpringParams } from '../spring.js';

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
      try { this._units[i]?.abort(); } catch { /* teardown siblings обязаны освободиться */ }
    }
    this._teardown();
    if (this._units.length === this._holes) this._resetStorage();
  };

  constructor(frame: FrameLoop) {
    this._frame = frame;
  }

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
    // Один проход обслуживает накопившиеся удаления. Порог в половину списка
    // ограничивает пустые slots и сохраняет линейную цену массового retarget.
    if (this._end < 0 && this._holes > 0 && this._holes * 2 >= this._units.length) this._compact();
    const slot = this._units.length;
    this._units.push(unit);
    unit.slot = slot;
    if (paused) return;
    this._active++;
    try {
      this._subscribe();
    } catch (error) {
      // Host reentry мог сдвинуть unit compaction-ом: identity живёт в slot unit.
      const current = unit.slot;
      if (current >= 0 && this._units[current] === unit) {
        this._units[current] = undefined;
        this._holes++;
        unit.slot = -1;
      }
      if (this._units.length === this._holes) this._resetStorage();
      else if (this._end < 0) this._compact();
      throw error;
    }
  }

  activate(unit: SurfaceUnit): void {
    if (unit.slot < 0) return;
    this._active++;
    this._subscribe();
  }

  deactivate(unit: SurfaceUnit): void {
    if (unit.slot < 0) return;
    if (--this._active === 0) this._teardown();
  }

  remove(unit: SurfaceUnit, paused: boolean): void {
    const slot = unit.slot;
    if (slot < 0 || this._units[slot] !== unit) return;
    this._units[slot] = undefined;
    this._holes++;
    unit.slot = -1;
    if (!paused && --this._active === 0) this._teardown();
    if (this._units.length === this._holes) this._resetStorage();
  }

  basis(spring: SpringParams, t: number): Readonly<MutableSpringBasis> {
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
      try { unit.update(ts); } catch {
        try { unit.abort(); } catch { /* cleanup одного slot не прерывает кадр */ }
      }
    }
    this.flush();
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
      try { unit.render(); } catch {
        try { unit.abort(); } catch { /* cleanup одного slot не прерывает кадр */ }
      }
    }
    this.flush();
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
      unit.slot = write++;
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
          try { this._units[i]?.rollback(error); } catch { /* sibling rollback продолжается */ }
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


export interface ChannelSnapshot { readonly value: number; readonly velocity: number }
export interface CssSnapshot {
  readonly key: string;
  readonly from: ValueAST;
  readonly to: ValueAST;
  readonly rate: number;
  readonly value: string | number;
  readonly velocity?: readonly number[];
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

export { readSpringFromBasisUnchecked, sampleSpringFromBasisUnchecked } from './read-spring.js';
