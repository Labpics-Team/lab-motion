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
  private readonly _frame: FrameLoop;
  private readonly _units: Array<SurfaceUnit | undefined> = [];
  private _active = 0;
  declare flush?: () => void;
  declare defer?: (action: () => void) => void;
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

  private _runUpdate(ts: number | undefined): void {
    this._end = this._units.length;
    for (let i = 0; i < this._end; i++) {
      const unit = this._units[i];
      if (!unit) continue;
      try { unit.update(ts); } catch {
        try { unit.abort(); } catch { /* cleanup одного slot не прерывает кадр */ }
      }
    }
    this.flush?.();
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
    this.flush?.();
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
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Frame cleanup failed');
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
