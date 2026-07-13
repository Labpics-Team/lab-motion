/** Compact MainUnit: plan-order внутри общего двухфазного scheduler. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate, type AnimatableElement } from '../src/animate/index.js';
import type { BoundGroup, GroupRecord } from '../src/animate/channels.js';
import { MainUnit } from '../src/animate/main-unit.js';
import { SurfaceBatch } from '../src/animate/surface-batch.js';
import type { FrameLoop } from '../src/frame/index.js';
import { makeClock } from './animate-facade-helpers.js';

function target(id: string, events: string[]): AnimatableElement {
  const values = new Map<string, string>([['opacity', '1']]);
  return {
    style: {
      getPropertyValue(name) {
        return values.get(name) ?? '';
      },
      setProperty(name, value) {
        events.push(`write:${id}:${name}`);
        values.set(name, value);
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('animate MainUnit: compact executor', () => {
  it('N=2 equal-delay x исполняет два unit в общем scheduler', () => {
    const units = vi.spyOn(MainUnit.prototype, '_updateStep');
    const clock = makeClock();
    const controls = animate(
      [target('a', []), target('b', [])],
      { x: [0, 100] },
      { duration: 1000, ease: (t) => t, requestFrame: clock.requestFrame },
    );

    clock.step(16);
    expect(units).toHaveBeenCalledTimes(2);
    controls.cancel();
  });

  it('N=1 сохраняет тот же executor contract', () => {
    const units = vi.spyOn(MainUnit.prototype, '_updateStep');
    const clock = makeClock();
    const controls = animate(
      target('a', []),
      { x: [0, 100] },
      { duration: 1000, ease: (t) => t, requestFrame: clock.requestFrame },
    );

    clock.step(16);
    expect(units).toHaveBeenCalledTimes(1);
    controls.cancel();
  });

  it('stagger остаётся per-unit delay одного scheduler', () => {
    const units = vi.spyOn(MainUnit.prototype, '_updateStep');
    const clock = makeClock();
    const controls = animate(
      [target('a', []), target('b', [])],
      { x: [0, 100] },
      { duration: 1000, stagger: 10, ease: (t) => t, requestFrame: clock.requestFrame },
    );

    clock.step(16);
    expect(units).toHaveBeenCalledTimes(2);
    controls.cancel();
  });

  it('generic CSS использует тот же широкий executor', () => {
    const units = vi.spyOn(MainUnit.prototype, '_updateStep');
    const clock = makeClock();
    const controls = animate(
      [target('a', []), target('b', [])],
      { x: [0, 100], width: ['0px', '100px'] },
      { duration: 1000, ease: (t) => t, requestFrame: clock.requestFrame },
    );

    clock.step(16);
    expect(units).toHaveBeenCalledTimes(4);
    controls.cancel();
  });
});

describe('animate MainUnit: plan-order и изоляция', () => {
  it('mixed x|opacity сохраняет target-major compute-all → write-all', () => {
    const events: string[] = [];
    const clock = makeClock();
    const controls = animate(
      [target('a', events), target('b', events)],
      { x: [0, 100], opacity: [1, 0] },
      {
        duration: 1000,
        ease: (t) => {
          events.push('compute');
          return t;
        },
        requestFrame: clock.requestFrame,
      },
    );

    events.length = 0;
    clock.step(16);
    expect(events).toEqual([
      'compute', 'compute', 'compute', 'compute',
      'write:a:transform', 'write:a:opacity',
      'write:b:transform', 'write:b:opacity',
    ]);
    controls.cancel();
  });

  it('бросок второго opaque ease гасит только его slot и не меняет порядок siblings', () => {
    const events: string[] = [];
    const clock = makeClock();
    let calls = 0;
    const controls = animate(
      [target('a', events), target('b', events)],
      { x: [0, 100], opacity: [1, 0] },
      {
        duration: 1000,
        ease: (t) => {
          calls++;
          events.push(`compute:${calls}`);
          if (calls === 2) throw new Error('slot failed');
          return t;
        },
        requestFrame: clock.requestFrame,
      },
    );

    expect(() => clock.step(16)).not.toThrow();
    expect(events).toEqual([
      'compute:1', 'compute:2', 'compute:3', 'compute:4',
      'write:a:transform',
      'write:b:transform', 'write:b:opacity',
    ]);
    controls.cancel();
  });

  it('public seek пробрасывает второй ease-сбой и не трогает поздние slots', () => {
    const events: string[] = [];
    let calls = 0;
    const controls = animate(
      [target('a', events), target('b', events)],
      { x: [0, 100], opacity: [1, 0] },
      {
        duration: 1000,
        ease: (t) => {
          calls++;
          events.push(`compute:${calls}`);
          if (calls === 2) throw new Error('seek failed');
          return t;
        },
        requestFrame: () => 1,
      },
    );

    expect(() => controls.seek(100)).toThrow('seek failed');
    expect(events).toEqual([
      'compute:1', 'write:a:transform',
      'compute:2',
    ]);
    controls.cancel();
  });

  it('sync resume публикует первый slot до остальных', () => {
    const events: string[] = [];
    const queued: Array<(ts?: number) => void> = [];
    let synchronous = false;
    const requestFrame = (cb: (ts?: number) => void): number => {
      if (synchronous) {
        synchronous = false;
        cb(32);
      } else queued.push(cb);
      return 1;
    };
    const controls = animate(
      [target('a', events), target('b', events)],
      { x: [0, 100] },
      {
        duration: 1000,
        ease: (t) => {
          events.push('compute');
          return t;
        },
        requestFrame,
      },
    );
    controls.pause();
    queued.splice(0).forEach((cb) => cb(16));
    events.length = 0;

    synchronous = true;
    controls.play();
    expect(events).toEqual(['compute']);
    controls.cancel();
  });

  it('public cancel прекращает fan-out на втором onDone-сбое', () => {
    const callbacks: Array<(ts?: number) => void> = [];
    const frame: FrameLoop = {
      read: () => () => {},
      update: (cb) => { callbacks.push(cb); return () => {}; },
      render: (cb) => { callbacks.push(cb); return () => {}; },
      cancelAll() {},
    };
    let reports = 0;
    const records: GroupRecord[] = [];
    const make = (i: number) => {
      const record: GroupRecord = {
        _owner: undefined,
        _transition: false,
        _numeric: new Map(),
        _cssValue: undefined,
      };
      records.push(record);
      const bound: BoundGroup = {
        _numeric: [{
          _key: 'x', _from: 0, _to: i + 1, _solverTo: i + 1,
          _v0: 0, _value: 0, _velocity: 0,
        }],
        _css: undefined,
        _residuals: new Map(),
        _transform: { x: 0 },
      };
      return {
        _el: target(String(i), []),
        _group: 'transform',
        _record: record,
        _bound: bound,
        _delayMs: 0,
      } as const;
    };
    const batch = new SurfaceBatch(frame);
    const owners = [0, 1, 2].map((i) => {
      const input = make(i);
      const owner = new MainUnit({
        ...input,
        _mode: { _type: 'tween', _durationMs: 1000, _ease: (t) => t },
        _batch: batch,
        _onDone: () => {
          reports++;
          if (reports === 2) throw new Error('report failed');
        },
      });
      input._record._owner = owner;
      return owner;
    });

    const cancel = (): void => { owners.forEach((owner) => owner.cancel()); };
    expect(cancel).toThrow('report failed');
    expect(records[0]!._owner).toBeUndefined();
    expect(records[1]!._owner).toBeUndefined();
    expect(records[2]!._owner).toBe(owners[2]);
  });

  it('superseded slot очищает сильные DOM/record/owner ссылки', () => {
    let firstOwner: MainUnit | undefined;
    const originalSupersede = MainUnit.prototype._supersede;
    const supersede = vi.spyOn(MainUnit.prototype, '_supersede').mockImplementation(function (
      this: MainUnit,
      replacement,
    ) {
      firstOwner ??= this;
      return Reflect.apply(originalSupersede, this, [replacement]);
    });
    const clock = makeClock();
    const a = target('a', []);
    const b = target('b', []);
    const first = animate([a, b], { x: [0, 100] }, {
      duration: 1000,
      requestFrame: clock.requestFrame,
    });
    const next = animate(a, { x: 200 }, { duration: 1000, requestFrame: clock.requestFrame });

    const refs = firstOwner as unknown as { _o: unknown; _batch: unknown };
    expect(refs._o).toBeUndefined();
    expect(refs._batch).toBeUndefined();
    first.cancel();
    next.cancel();
    supersede.mockRestore();
  });

  it('terminal owners отцепляют kernel и DOM из retained controls', () => {
    const owners: MainUnit[] = [];
    const originalCancel = MainUnit.prototype.cancel;
    const cancel = vi.spyOn(MainUnit.prototype, 'cancel').mockImplementation(function (
      this: MainUnit,
    ) {
      owners.push(this);
      return Reflect.apply(originalCancel, this, []);
    });
    const controls = animate(
      [target('a', []), target('b', [])],
      { x: [0, 100], opacity: [1, 0] },
      { duration: 1000, requestFrame: () => 1 },
    );

    controls.cancel();
    expect(owners.every((owner) =>
      (owner as unknown as { _o: unknown })._o === undefined
    )).toBe(true);
    expect(() => controls.play()).not.toThrow();
    cancel.mockRestore();
  });
});
