import { describe, expect, it } from 'vitest';
import {
  bindGroup,
  parseProps,
  type AnimatableElement,
  type ChannelSnapshot,
  type GroupOwner,
  type GroupRecord,
} from '../src/animate/channels.js';
import { MainUnit } from '../src/animate/main-unit.js';
import { SurfaceBatch } from '../src/animate/surface-batch.js';
import type { FrameLoop } from '../src/frame/index.js';

function countSetAllocations<T>(run: () => T): { readonly result: T; readonly allocations: number } {
  const NativeSet = globalThis.Set;
  let allocations = 0;
  class CountingSet<V> extends NativeSet<V> {
    constructor(values?: readonly V[] | null) {
      super(values);
      allocations++;
    }
  }
  (globalThis as { Set: SetConstructor }).Set = CountingSet as SetConstructor;
  try {
    return { result: run(), allocations };
  } finally {
    (globalThis as { Set: SetConstructor }).Set = NativeSet;
  }
}

const element: AnimatableElement = {
  style: {
    getPropertyValue: () => '',
    setProperty() {},
  },
};

function record(owner?: GroupOwner): GroupRecord {
  const numeric = new Map<string, ChannelSnapshot>();
  numeric.set('rotate', { _value: 30, _velocity: 0 });
  numeric.set('skewX', { _value: 5, _velocity: 0 });
  return {
    _owner: owner,
    _transition: false,
    _numeric: numeric,
    _cssValue: undefined,
  };
}

function inertFrame(): FrameLoop {
  const subscribe = (_cb: (ts?: number) => void): (() => void) => () => {};
  return {
    read: subscribe,
    update: subscribe,
    render: subscribe,
    cancelAll() {},
  };
}

describe('bindGroup transform key authority', () => {
  it('positive control detects a direct Set construction', () => {
    expect(countSetAllocations(() => new Set(['x'])).allocations).toBe(1);
  });

  it('does not materialize a second key Set for settled state', () => {
    const { result: bound, allocations } = countSetAllocations(() =>
      bindGroup(element, 'transform', parseProps({ x: [0, 100] }), record()),
    );

    expect(allocations).toBe(1);
    expect(bound._residuals.get('rotate')).toBe(30);
    expect(bound._residuals.get('skewX')).toBe(5);
    expect(bound._transform).toMatchObject({ x: 0, rotate: 30, skewX: 5 });
  });

  it('uses the live owner as complete key authority without a union Set', () => {
    const owner: GroupOwner = {
      _captureNum(key) {
        if (key === 'rotate') return { _value: 42, _velocity: 7 };
        if (key === 'skewX') return { _value: 9, _velocity: 3 };
        return undefined;
      },
      _captureCss() {
        return undefined;
      },
      _numericKeys() {
        return ['x', 'rotate', 'skewX'];
      },
      _supersede() {},
    };

    const { result: bound, allocations } = countSetAllocations(() =>
      bindGroup(element, 'transform', parseProps({ x: [0, 100] }), record(owner)),
    );

    expect(allocations).toBe(1);
    expect(bound._residuals.get('rotate')).toBe(42);
    expect(bound._residuals.get('skewX')).toBe(9);
    expect(bound._transform).toMatchObject({ x: 0, rotate: 42, skewX: 9 });
  });

  it('preserves a real MainUnit numeric and residual key surface', () => {
    const rec = record();
    const ownerBound = bindGroup(
      element,
      'transform',
      parseProps({ x: [0, 100] }),
      rec,
    );
    const owner = new MainUnit({
      _el: element,
      _group: 'transform',
      _record: rec,
      _bound: ownerBound,
      _mode: { _type: 'tween', _durationMs: 1000, _ease: (t) => t },
      _delayMs: 0,
      _batch: new SurfaceBatch(inertFrame()),
      _onDone() {},
      _startPaused: true,
    });
    rec._owner = owner;

    try {
      const { result: bound, allocations } = countSetAllocations(() =>
        bindGroup(element, 'transform', parseProps({ y: [0, 50] }), rec),
      );

      expect(allocations).toBe(1);
      expect(bound._residuals.get('x')).toBe(0);
      expect(bound._residuals.get('rotate')).toBe(30);
      expect(bound._residuals.get('skewX')).toBe(5);
      expect(bound._transform).toMatchObject({ y: 0, x: 0, rotate: 30, skewX: 5 });
    } finally {
      owner.cancel();
    }
  });
});
