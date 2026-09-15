import { describe, expect, it } from 'vitest';
import {
  bindGroup,
  parseProps,
  type AnimatableElement,
  type ChannelSnapshot,
  type GroupOwner,
  type GroupRecord,
} from '../src/animate/channels.js';

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
  return {
    _owner: owner,
    _transition: false,
    _numeric: new Map<string, ChannelSnapshot>(),
    _cssValue: undefined,
  };
}

describe('bindGroup transform discovery allocations', () => {
  it('positive control detects a direct Set construction', () => {
    const { allocations } = countSetAllocations(() => new Set(['x']));
    expect(allocations).toBe(1);
  });

  it('uses no transient Set when the settled registry is the key authority', () => {
    const rec = record();
    rec._numeric.set('rotate', { _value: 30, _velocity: 0 });

    const { result: bound, allocations } = countSetAllocations(() =>
      bindGroup(element, 'transform', parseProps({ x: [0, 100] }), rec),
    );

    expect(allocations).toBe(0);
    expect(bound._residuals.get('rotate')).toBe(30);
    expect(bound._transform).toMatchObject({ x: 0, rotate: 30 });
  });

  it('uses the live owner as the complete key authority without losing residuals', () => {
    const rec = record();
    rec._numeric.set('rotate', { _value: 30, _velocity: 0 });
    const owner: GroupOwner = {
      _captureNum(key) {
        return key === 'rotate' ? { _value: 42, _velocity: 7 } : undefined;
      },
      _captureCss() { return undefined; },
      _numericKeys() { return ['x', 'rotate']; },
      _supersede() {},
    };
    rec._owner = owner;

    const { result: bound, allocations } = countSetAllocations(() =>
      bindGroup(element, 'transform', parseProps({ x: [0, 100] }), rec),
    );

    expect(allocations).toBe(0);
    expect(bound._residuals.get('rotate')).toBe(42);
    expect(bound._transform).toMatchObject({ x: 0, rotate: 42 });
  });
});
