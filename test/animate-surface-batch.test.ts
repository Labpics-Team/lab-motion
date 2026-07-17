/** SurfaceBatch: две phase-подписки и стабильная граница кадра. */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type {
  AnimatableElement,
  BoundGroup,
  GroupRecord,
  NumericChannel,
} from '../src/animate/channels.js';
import { animate } from '../src/animate/index.js';
import { MainUnit } from '../src/animate/main-unit.js';
import {
  surfaceBatchFor,
  SurfaceBatch,
  type SurfaceUnit,
} from '../src/animate/surface-batch.js';
import { WaapiUnit, type WaapiTarget } from '../src/animate/waapi-unit.js';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import type { FrameLoop } from '../src/frame/index.js';
import { settleTimeUpperBound } from '../src/spring.js';
import { fakeEl } from './animate-facade-helpers.js';

function frameHarness(options: { readonly throwRender?: boolean } = {}): {
  readonly frame: FrameLoop;
  readonly subscriptions: { update: number; render: number };
  readonly removals: { update: number; render: number };
  tick(ts: number): void;
} {
  let update: ((ts?: number) => void) | undefined;
  let render: ((ts?: number) => void) | undefined;
  const subscriptions = { update: 0, render: 0 };
  const removals = { update: 0, render: 0 };
  return {
    subscriptions,
    removals,
    frame: {
      read: () => () => {},
      update(cb) {
        subscriptions.update++;
        update = cb;
        return () => {
          removals.update++;
          if (update === cb) update = undefined;
        };
      },
      render(cb) {
        subscriptions.render++;
        if (options.throwRender === true) throw new Error('render subscribe failed');
        render = cb;
        return () => {
          removals.render++;
          if (render === cb) render = undefined;
        };
      },
      cancelAll() {},
    },
    tick(ts) {
      const updateAtBoundary = update;
      const renderAtBoundary = render;
      updateAtBoundary?.(ts);
      renderAtBoundary?.(ts);
    },
  };
}

function slot(id: string, events: string[] = []): {
  readonly input: {
    readonly _el: AnimatableElement;
    readonly _group: 'opacity';
    readonly _record: GroupRecord;
    readonly _bound: BoundGroup;
    readonly _delayMs: 0;
  };
  readonly record: GroupRecord;
} {
  const record: GroupRecord = {
    _owner: undefined,
    _transition: false,
    _numeric: new Map(),
    _cssValue: undefined,
  };
  const channel: NumericChannel = {
    _key: 'opacity',
    _from: 0,
    _to: 1,
    _solverTo: 1,
    _v0: 0,
    _value: 0,
    _velocity: 0,
  };
  return {
    record,
    input: {
      _el: {
        style: {
          getPropertyValue: () => '',
          setProperty: () => { events.push(`write:${id}`); },
        },
      },
      _group: 'opacity',
      _record: record,
      _bound: {
        _numeric: [channel],
        _css: undefined,
        _residuals: new Map(),
        _transform: undefined,
      },
      _delayMs: 0,
    },
  };
}

function batchWithUnits(
  frame: FrameLoop,
  count: number,
  onDone: (natural: boolean) => void = () => {},
): { readonly batch: SurfaceBatch; readonly units: MainUnit[] } {
  const batch = new SurfaceBatch(frame);
  const units = Array.from({ length: count }, (_, i) => {
    const item = slot(String(i));
    const unit = new MainUnit({
      ...item.input,
      _mode: { _type: 'tween', _durationMs: 1_000_000, _ease: (t) => t },
      _batch: batch,
      _onDone: onDone,
    });
    item.record._owner = unit;
    return unit;
  });
  return { batch, units };
}

function mainUnit(
  batch: SurfaceBatch,
  id: string,
  startPaused = false,
  onDone: (natural: boolean) => void = () => {},
): MainUnit {
  const item = slot(id);
  const unit = new MainUnit({
    ...item.input,
    _mode: { _type: 'tween', _durationMs: 1000, _ease: (t) => t },
    _batch: batch,
    _onDone: onDone,
    _startPaused: startPaused,
  });
  item.record._owner = unit;
  return unit;
}

function reentrantSubscribeHarness(
  hostError: Error | undefined,
  onFirstUpdateSubscribe: () => void,
): {
  readonly frame: FrameLoop;
  readonly subscriptions: { update: number; render: number };
  readonly removals: { update: number; render: number };
  tick(ts: number): void;
} {
  let update: ((ts?: number) => void) | undefined;
  let render: ((ts?: number) => void) | undefined;
  const subscriptions = { update: 0, render: 0 };
  const removals = { update: 0, render: 0 };
  return {
    subscriptions,
    removals,
    frame: {
      read: () => () => {},
      update(cb) {
        subscriptions.update++;
        if (subscriptions.update === 1) {
          onFirstUpdateSubscribe();
          if (hostError !== undefined) throw hostError;
        }
        update = cb;
        return () => {
          removals.update++;
          if (update === cb) update = undefined;
        };
      },
      render(cb) {
        subscriptions.render++;
        render = cb;
        return () => {
          removals.render++;
          if (render === cb) render = undefined;
        };
      },
      cancelAll() {},
    },
    tick(ts) {
      const updateAtBoundary = update;
      const renderAtBoundary = render;
      updateAtBoundary?.(ts);
      renderAtBoundary?.(ts);
    },
  };
}

function fakeSurface(
  update: () => void,
  render: () => void,
  fail: () => void = () => {},
): SurfaceUnit {
  return {
    _batchSlot: -1,
    _updateStep: update,
    _renderStep: render,
    _batchAbort: fail,
    _batchRollback() {},
  };
}

const HANDOFF_SPRING = { mass: 1, stiffness: 170, damping: 10 };
const HANDOFF_ARTIFACT = compileSpringExecutionArtifactTupleUnchecked(
  HANDOFF_SPRING,
  0,
  DEFAULT_TOLERANCE,
);

function targetCrossingMs(): number {
  const samples = HANDOFF_ARTIFACT[1];
  const durationMs = settleTimeUpperBound(HANDOFF_SPRING, 0) * 1000;
  for (let i = 0; i + 3 < samples.length; i += 2) {
    const a = samples[i + 1]!;
    const b = samples[i + 3]!;
    if (a < 1 && b >= 1) {
      const p = (1 - a) / (b - a);
      return (samples[i]! + p * (samples[i + 2]! - samples[i]!)) / 100 * durationMs;
    }
  }
  throw new Error('target crossing отсутствует');
}

function waapiUnit(getBatch: () => SurfaceBatch): WaapiUnit {
  const record: GroupRecord = {
    _owner: undefined,
    _transition: false,
    _numeric: new Map(),
    _cssValue: undefined,
  };
  const numeric: NumericChannel[] = [{
    _key: 'x', _from: 0, _to: 100, _solverTo: 100,
    _v0: 0, _value: 0, _velocity: 0,
  }];
  const el: WaapiTarget = {
    style: { getPropertyValue: () => '', setProperty() {} },
    animate: () => ({ currentTime: 0, cancel() {} }),
  };
  const unit = new WaapiUnit({
    _el: el,
    _group: 'transform',
    _record: record,
    _numeric: numeric,
    _residuals: new Map(),
    _transform: { x: 0 },
    _spring: HANDOFF_SPRING,
    _delayMs: 0,
    _now: () => 0,
    _setTimer: () => () => {},
    _getBatch: getBatch,
    _onDone() {},
    _artifact: HANDOFF_ARTIFACT,
  });
  record._owner = unit;
  unit._commit();
  return unit;
}

describe('SurfaceBatch: потолок подписок', () => {
  for (const count of [1, 100, 1000]) {
    it(`N=${count}: aggregate создаёт ровно update+render`, () => {
      const host = frameHarness();
      const { batch, units } = batchWithUnits(host.frame, count);

      expect(host.subscriptions).toEqual({ update: 1, render: 1 });
      host.tick(16);
      expect(host.subscriptions).toEqual({ update: 1, render: 1 });

      units.forEach((unit) => unit.cancel());
      expect(host.removals).toEqual({ update: 1, render: 1 });
      expect((batch as unknown as { _units: unknown[] })._units).toHaveLength(0);
      expect((batch as unknown as { _active: number })._active).toBe(0);
    });
  }

  it('pause-all снимает batch; play-all подписывает его один раз', () => {
    const host = frameHarness();
    const { units } = batchWithUnits(host.frame, 100);

    units.forEach((unit) => unit.pause());
    expect(host.removals).toEqual({ update: 1, render: 1 });
    units.forEach((unit) => unit.play());
    expect(host.subscriptions).toEqual({ update: 2, render: 2 });
    units.forEach((unit) => unit.cancel());
    expect(host.removals).toEqual({ update: 2, render: 2 });
  });

  it('N=100 WAAPI→live handoff делит те же две подписки', () => {
    const host = frameHarness();
    let batch: SurfaceBatch | undefined;
    const getBatch = (): SurfaceBatch => batch ??= new SurfaceBatch(host.frame);
    const units = Array.from({ length: 100 }, () => waapiUnit(getBatch));

    units.forEach((unit) => unit.seek(targetCrossingMs()));
    expect(host.subscriptions).toEqual({ update: 1, render: 1 });
    units.forEach((unit) => unit.cancel());
    expect(host.removals).toEqual({ update: 1, render: 1 });
    expect((batch as unknown as { _units: unknown[] })._units).toHaveLength(0);
  });

  it('N=100 paused handoff ленив до play', () => {
    const host = frameHarness();
    let batch: SurfaceBatch | undefined;
    const getBatch = (): SurfaceBatch => batch ??= new SurfaceBatch(host.frame);
    const units = Array.from({ length: 100 }, () => waapiUnit(getBatch));

    units.forEach((unit) => { unit.pause(); unit.seek(targetCrossingMs()); });
    expect(host.subscriptions).toEqual({ update: 0, render: 0 });
    units.forEach((unit) => unit.play());
    expect(host.subscriptions).toEqual({ update: 1, render: 1 });
    units.forEach((unit) => unit.cancel());
    expect(host.removals).toEqual({ update: 1, render: 1 });
  });

  it('ошибка второй phase-подписки откатывает первую и новый unit', () => {
    const host = frameHarness({ throwRender: true });
    const batch = new SurfaceBatch(host.frame);
    const item = slot('0');

    expect(() => new MainUnit({
      ...item.input,
      _mode: { _type: 'tween', _durationMs: 1000, _ease: (t) => t },
      _batch: batch,
      _onDone() {},
    })).toThrow('render subscribe failed');
    expect(host.removals.update).toBe(1);
    expect((batch as unknown as { _units: unknown[] })._units).toHaveLength(0);
    expect((batch as unknown as { _active: number })._active).toBe(0);
  });

  it('cancel A → compaction → B.play → host throw откатывает всю subscribe-транзакцию', () => {
    const hostError = new Error('host update subscribe failed');
    let reenter = (): void => {};
    const host = reentrantSubscribeHarness(hostError, () => reenter());
    const batch = new SurfaceBatch(host.frame);
    const a = mainUnit(batch, 'a', true);
    const completions: boolean[] = [];
    const b = mainUnit(batch, 'b', true, (natural) => completions.push(natural));
    reenter = () => {
      a.cancel();
      b.play();
    };

    let thrown: unknown;
    try {
      mainUnit(batch, 'failed-c');
    } catch (error) {
      thrown = error;
    }

    const state = batch as unknown as {
      _units: Array<SurfaceUnit | undefined>;
      _active: number;
      _offUpdate?: () => void;
      _offRender?: () => void;
    };
    expect(thrown).toBe(hostError);
    expect(state._units).toEqual([b]);
    expect(b._batchSlot).toBe(0);
    expect((b as unknown as { _paused: boolean })._paused).toBe(true);
    expect(state._active).toBe(0);
    expect(state._offUpdate).toBeUndefined();
    expect(state._offRender).toBeUndefined();
    expect(host.subscriptions).toEqual({ update: 1, render: 0 });

    b.play();
    expect(host.subscriptions).toEqual({ update: 2, render: 1 });
    host.tick(0);
    host.tick(1001);
    expect(completions).toEqual([true]);
    expect(state._units).toHaveLength(0);
    expect(state._active).toBe(0);
  });

  it('reentrant B.play при успехе получает ту же update/render-пару', () => {
    let reenter = (): void => {};
    const host = reentrantSubscribeHarness(undefined, () => reenter());
    const batch = new SurfaceBatch(host.frame);
    const completions: string[] = [];
    const b = mainUnit(batch, 'b', true, (natural) => completions.push(`b:${natural}`));
    reenter = () => b.play();

    const c = mainUnit(batch, 'c', false, (natural) => completions.push(`c:${natural}`));

    expect(host.subscriptions).toEqual({ update: 1, render: 1 });
    expect((batch as unknown as { _active: number })._active).toBe(2);
    expect((b as unknown as { _paused: boolean })._paused).toBe(false);
    expect(b._batchSlot).toBe(0);
    expect(c._batchSlot).toBe(1);

    host.tick(0);
    host.tick(1001);
    expect(completions).toEqual(['b:true', 'c:true']);
    expect(host.removals).toEqual({ update: 1, render: 1 });
    expect((batch as unknown as { _units: unknown[] })._units).toHaveLength(0);
  });

  it('WAAPI-wrapper остаётся paused/retryable вместе с откатившимся live delegate', () => {
    const hostError = new Error('host update subscribe failed');
    let reenter = (): void => {};
    const host = reentrantSubscribeHarness(hostError, () => reenter());
    const batch = new SurfaceBatch(host.frame);
    const wrapper = waapiUnit(() => batch);
    wrapper.pause();
    wrapper.seek(targetCrossingMs());
    const delegate = (wrapper as unknown as { _delegate: MainUnit })._delegate;
    reenter = () => wrapper.play();

    let thrown: unknown;
    try {
      mainUnit(batch, 'failed-outer');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(hostError);
    expect((wrapper as unknown as { _paused: boolean })._paused).toBe(true);
    expect((delegate as unknown as { _paused: boolean })._paused).toBe(true);
    expect((batch as unknown as { _active: number })._active).toBe(0);
    expect((batch as unknown as { _units: unknown[] })._units).toEqual([delegate]);
    expect(host.subscriptions).toEqual({ update: 1, render: 0 });

    wrapper.play();
    expect(host.subscriptions).toEqual({ update: 2, render: 1 });
    wrapper.cancel();
    expect((batch as unknown as { _units: unknown[] })._units).toHaveLength(0);
  });

  it.each([
    ['add/cancel', ['cancel'], false],
    ['add/pause', ['pause'], true],
    ['add/pause-play', ['pause', 'play'], true],
  ] as const)(
    'hostile property: nested %s не оставляет active/ghost slots',
    (_name, operations, retained) => {
      const hostError = new Error('host update subscribe failed');
      let reenter = (): void => {};
      const host = reentrantSubscribeHarness(hostError, () => reenter());
      const batch = new SurfaceBatch(host.frame);
      let nested!: MainUnit;
      reenter = () => {
        nested = mainUnit(batch, 'nested');
        for (const operation of operations) nested[operation]();
      };

      let thrown: unknown;
      try {
        mainUnit(batch, 'failed-outer');
      } catch (error) {
        thrown = error;
      }

      const state = batch as unknown as {
        _units: Array<SurfaceUnit | undefined>;
        _active: number;
        _offUpdate?: () => void;
        _offRender?: () => void;
      };
      expect(thrown).toBe(hostError);
      expect(state._active).toBe(0);
      expect(state._offUpdate).toBeUndefined();
      expect(state._offRender).toBeUndefined();
      expect(host.subscriptions).toEqual({ update: 1, render: 0 });
      expect(state._units).toEqual(retained ? [nested] : []);
      for (let index = 0; index < state._units.length; index++) {
        expect(state._units[index]!._batchSlot).toBe(index);
      }

      if (retained) {
        expect((nested as unknown as { _paused: boolean })._paused).toBe(true);
        nested.play();
        expect(host.subscriptions).toEqual({ update: 2, render: 1 });
        nested.cancel();
      }
      expect(state._units).toHaveLength(0);
      expect(state._active).toBe(0);
    },
  );

  it('исходную host-ошибку не заменяет бросок cleanup', () => {
    const hostError = new Error('render subscribe failed');
    const cleanupError = new Error('update cleanup failed');
    const batch = new SurfaceBatch({
      read: () => () => {},
      update: () => () => { throw cleanupError; },
      render: () => { throw hostError; },
      cancelAll() {},
    });
    const unit = fakeSurface(() => {}, () => {});

    let thrown: unknown;
    try {
      batch._add(unit, false);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(hostError);
    expect(unit._batchSlot).toBe(-1);
    expect((batch as unknown as { _units: unknown[] })._units).toHaveLength(0);
    expect((batch as unknown as { _active: number })._active).toBe(0);
  });
});

describe('SurfaceBatch: граница кадра и lifecycle', () => {
  it('бросок cleanup в update не лишает кадра поздние slots', () => {
    const host = frameHarness();
    const batch = new SurfaceBatch(host.frame);
    const events: string[] = [];
    const first = fakeSurface(
      () => { events.push('u1'); throw new Error('update failed'); },
      () => events.push('r1'),
      () => { events.push('f1'); throw new Error('cleanup failed'); },
    );
    const second = fakeSurface(
      () => events.push('u2'),
      () => events.push('r2'),
    );
    batch._add(first, false);
    batch._add(second, false);

    expect(() => host.tick(16)).not.toThrow();
    expect(events).toEqual(['u1', 'f1', 'u2', 'r1', 'r2']);
    batch._remove(first, false);
    batch._remove(second, false);
  });

  it('бросок cleanup в render не лишает кадра поздние slots', () => {
    const host = frameHarness();
    const batch = new SurfaceBatch(host.frame);
    const events: string[] = [];
    const first = fakeSurface(
      () => events.push('u1'),
      () => { events.push('r1'); throw new Error('render failed'); },
      () => { events.push('f1'); throw new Error('cleanup failed'); },
    );
    const second = fakeSurface(
      () => events.push('u2'),
      () => events.push('r2'),
    );
    batch._add(first, false);
    batch._add(second, false);

    expect(() => host.tick(16)).not.toThrow();
    expect(events).toEqual(['u1', 'u2', 'r1', 'f1', 'r2']);
    batch._remove(first, false);
    batch._remove(second, false);
  });

  it('бросок teardown одного slot не удерживает остальные и scheduler', () => {
    const host = frameHarness();
    const batch = new SurfaceBatch(host.frame);
    const events: string[] = [];
    const first = fakeSurface(
      () => {},
      () => {},
      () => { events.push('t1'); throw new Error('teardown failed'); },
    );
    const second = fakeSurface(
      () => {},
      () => {},
      () => events.push('t2'),
    );
    batch._add(first, false);
    batch._add(second, false);

    const teardown = (batch as unknown as { _frameTeardown(): void })._frameTeardown;
    expect(() => teardown()).not.toThrow();
    expect(events).toEqual(['t1', 't2']);
    expect(host.removals).toEqual({ update: 1, render: 1 });
  });

  it('добавление из update ждёт следующего кадра', () => {
    const host = frameHarness();
    const batch = new SurfaceBatch(host.frame);
    const events: string[] = [];
    const second = fakeSurface(
      () => events.push('u2'),
      () => events.push('r2'),
    );
    const first = fakeSurface(
      () => {
        events.push('u1');
        if (second._batchSlot < 0) batch._add(second, false);
      },
      () => events.push('r1'),
    );
    batch._add(first, false);

    host.tick(16);
    expect(events).toEqual(['u1', 'r1']);
    host.tick(32);
    expect(events).toEqual(['u1', 'r1', 'u1', 'u2', 'r1', 'r2']);
    batch._remove(first, false);
    batch._remove(second, false);
  });

  it('удаление unit внутри update не пропускает sibling', () => {
    const host = frameHarness();
    const batch = new SurfaceBatch(host.frame);
    const events: string[] = [];
    let first!: SurfaceUnit;
    first = fakeSurface(
      () => {
        events.push('u1');
        batch._remove(first, false);
      },
      () => events.push('r1'),
    );
    const second = fakeSurface(
      () => events.push('u2'),
      () => events.push('r2'),
    );
    batch._add(first, false);
    batch._add(second, false);

    host.tick(16);
    expect(events).toEqual(['u1', 'u2', 'r2']);
    batch._remove(second, false);
    expect((batch as unknown as { _units: unknown[] })._units).toHaveLength(0);
    expect(host.removals).toEqual({ update: 1, render: 1 });
  });

  it('host scheduler failure successor сохраняет старого owner', async () => {
    const target = fakeEl();
    const source = animate(target.el, { x: [0, 100] }, {
      duration: 1000,
      requestFrame: () => 1,
    });
    let finished = false;
    void source.finished.then(() => { finished = true; });

    expect(() => animate(target.el, { x: 200 }, {
      duration: 1000,
      requestFrame: () => { throw new Error('schedule failed'); },
    })).toThrow('schedule failed');
    await Promise.resolve();
    expect(finished).toBe(false);
    source.cancel();
    await source.finished;
  });

  it('индивидуальный supersede не останавливает sibling старого aggregate', () => {
    const a = fakeEl();
    const b = fakeEl();
    const queue: Array<(ts?: number) => void> = [];
    const requestFrame = (cb: (ts?: number) => void): number => {
      queue.push(cb);
      return queue.length;
    };
    const first = animate([a.el, b.el], { x: [0, 100] }, {
      duration: 1000,
      requestFrame,
    });
    const next = animate(a.el, { x: 200 }, { duration: 1000, requestFrame });
    queue.splice(0).forEach((cb) => cb(16));

    expect(b.writes.length).toBeGreaterThan(0);
    first.cancel();
    next.cancel();
  });
});

describe('SurfaceBatch: физический ключ spring-basis', () => {
  it('не решает повторно равные m/k/c и t из разных animate-вызовов', () => {
    const batch = new SurfaceBatch(frameHarness().frame);
    const spring = { mass: 1, stiffness: 170, damping: 26 };
    batch._springBasis(spring, 0.1);
    const exp = vi.spyOn(Math, 'exp');
    try {
      batch._springBasis({ ...spring }, 0.1);
      expect(exp).not.toHaveBeenCalled();
    } finally {
      exp.mockRestore();
    }
  });
});

describe('SurfaceBatch: retention общего default-pool', () => {
  it('churn не растёт выше peak live, idle освобождает targets/options', () => {
    vi.useFakeTimers();
    try {
      const first = Array.from({ length: 100 }, () =>
        animate(fakeEl().el, { x: [0, 1] }, { duration: 1000, ease: (t) => t }),
      );
      const batch = surfaceBatchFor(undefined);
      const storage = (): Array<MainUnit | undefined> =>
        (batch as unknown as { _units: Array<MainUnit | undefined> })._units;
      const retained = storage().filter((unit): unit is MainUnit => unit !== undefined);
      const peakLive = retained.length;

      first.forEach((control, index) => { if (index % 2 === 0) control.cancel(); });
      const second = Array.from({ length: peakLive / 2 }, () =>
        animate(fakeEl().el, { x: [0, 1] }, { duration: 1000, ease: (t) => t }),
      );
      retained.push(...storage().filter(
        (unit): unit is MainUnit => unit !== undefined && !retained.includes(unit),
      ));
      expect(storage().length).toBeLessThanOrEqual(peakLive);

      first.forEach((control) => control.cancel());
      second.forEach((control) => control.cancel());
      expect(storage()).toHaveLength(0);
      for (const unit of retained) {
        expect((unit as unknown as { _o?: unknown })._o).toBeUndefined();
        expect((unit as unknown as { _batch?: unknown })._batch).toBeUndefined();
      }
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SurfaceBatch: структура горячих методов', () => {
  it('update/render не создают per-frame arrays или closures', () => {
    const path = 'src/animate/surface-batch.ts';
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const name of ['_runUpdate', '_runRender']) {
      const method = nodes.find((node) =>
        ts.isMethodDeclaration(node) && node.name.getText(file) === name,
      );
      expect(method, name).toBeDefined();
      const body: ts.Node[] = [];
      const collect = (node: ts.Node): void => {
        body.push(node);
        ts.forEachChild(node, collect);
      };
      collect(method!);
      expect(body.some(ts.isArrayLiteralExpression), name).toBe(false);
      expect(body.some(ts.isArrowFunction), name).toBe(false);
      expect(body.some((node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['map', 'filter', 'flatMap', 'slice'].includes(node.expression.name.text),
      ), name).toBe(false);
    }
  });
});
