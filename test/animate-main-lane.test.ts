/** Compact MainUnit: plan-order внутри общего двухфазного scheduler. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate, type AnimatableElement } from '../src/animate/index.js';
import type { BoundGroup, GroupRecord } from '../src/animate/channels.js';
import { MainUnit } from '../src/animate/main-unit.js';
import { SurfaceBatch } from '../src/animate/surface-batch.js';
import type { FrameLoop } from '../src/frame/index.js';
import { makeClock, readTranslateX, translateXSeries } from './animate-facade-helpers.js';

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
  it.each([
    ['1e-7', 1e-7],
    ['-1.25e-7', -1.25e-7],
    ['1e+7', 1e7],
    ['-1.25e+7', -1.25e7],
    ['.5', 0.5],
  ])('test harness принимает CSS-number %s', (serialized, expected) => {
    expect(readTranslateX(`translateX(${serialized}px)`)).toBe(expected);
  });

  it.each(['0x10', ' ', '1e+', '.', '1.', 'Infinity'])
  ('test harness fail-closed отклоняет %s', (serialized) => {
    expect(readTranslateX(`translateX(${serialized}px)`)).toBeNaN();
  });

  it('malformed последняя запись не маскируется предыдущей конечной', () => {
    const values = translateXSeries([
      { prop: 'transform', value: 'translateX(1px)' },
      { prop: 'transform', value: 'translateX(1e+px)' },
    ]);
    expect(values[0]).toBe(1);
    expect(values[1]).toBeNaN();
  });

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
  it('tween MAX ↔ -MAX не телепортируется в цель из-за overflow span', () => {
    const clock = makeClock();
    const writes: number[] = [];
    const controls = animate({
      style: {
        getPropertyValue: () => '',
        setProperty(_name, value) {
          if (value === 'none') writes.push(0);
          else writes.push(readTranslateX(value) ?? Number.NaN);
        },
      },
    }, { x: [Number.MAX_VALUE, -Number.MAX_VALUE] }, {
      duration: 1000,
      ease: (progress) => progress,
      requestFrame: clock.requestFrame,
    });

    clock.step(16);
    clock.step(100);

    expect(writes.every(Number.isFinite)).toBe(true);
    expect(writes.at(-1)).not.toBe(-Number.MAX_VALUE);
    controls.cancel();
  });

  it('устойчиво ведёт и завершает пружину на диапазоне MAX ↔ -MAX', () => {
    const callbacks: Array<(ts?: number) => void> = [];
    const frame: FrameLoop = {
      read: () => () => {},
      update: (cb) => { callbacks.push(cb); return () => {}; },
      render: (cb) => { callbacks.push(cb); return () => {}; },
      cancelAll() {},
    };
    const record: GroupRecord = {
      _owner: undefined,
      _transition: false,
      _numeric: new Map(),
      _cssValue: undefined,
    };
    let natural: boolean | undefined;
    const writes: number[] = [];
    const unit = new MainUnit({
      _el: {
        style: {
          getPropertyValue: () => '',
          setProperty(_name, value) {
            if (value === 'none') {
              writes.push(0);
              return;
            }
            writes.push(readTranslateX(value) ?? Number.NaN);
          },
        },
      },
      _group: 'transform',
      _record: record,
      _bound: {
        _numeric: [{
          _key: 'x',
          _from: Number.MAX_VALUE,
          _to: -Number.MAX_VALUE,
          _solverTo: -Number.MAX_VALUE,
          _v0: 0,
          _value: Number.MAX_VALUE,
          _velocity: 0,
        }],
        _css: undefined,
        _residuals: new Map(),
        _transform: { x: Number.MAX_VALUE },
      },
      _mode: { _type: 'spring', _spring: { mass: 1, stiffness: 170, damping: 26 } },
      _delayMs: 0,
      _batch: new SurfaceBatch(frame),
      _onDone(value) { natural = value; },
    });
    record._owner = unit;

    callbacks[0]?.(16);
    callbacks[1]?.(16);
    callbacks[0]?.(116);
    callbacks[1]?.(116);
    callbacks[0]?.(516);
    callbacks[1]?.(516);

    const pickup = unit._captureNum('x');
    expect(Number.isFinite(pickup?._velocity)).toBe(true);
    expect(pickup?._velocity).not.toBe(0);

    for (let frameIndex = 2; frameIndex < 1000 && record._owner === unit; frameIndex++) {
      const ts = 516 + frameIndex * 16;
      callbacks[0]?.(ts);
      callbacks[1]?.(ts);
    }

    expect(record._owner).toBeUndefined();
    expect(natural).toBe(true);
    expect(writes.every(Number.isFinite)).toBe(true);
    expect(writes.some((value) => value !== Number.MAX_VALUE && value !== -Number.MAX_VALUE))
      .toBe(true);
  });

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

  it('sync resume ждёт tracked trampoline и коммитит aggregate целиком', () => {
    vi.useFakeTimers();
    try {
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
      // Host-нарушитель не вправе вклинить update между активацией двух slots.
      expect({ events, timers: vi.getTimerCount() }).toEqual({ events: [], timers: 1 });
      vi.advanceTimersToNextTimer();
      expect(events).toEqual([
        'compute', 'compute',
        'write:a:transform', 'write:b:transform',
      ]);
      expect(vi.getTimerCount()).toBe(1);
      controls.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
