import { describe, expect, it } from 'vitest';
import { createTimeline } from '../src/timeline/index.js';

const NativeMap = Map;

function countConstructionMaps(withLabels: boolean, positiveControl = false): number {
  let count = 0;
  class CountingMap<K, V> extends NativeMap<K, V> {
    constructor(iterable?: Iterable<readonly [K, V]> | null) {
      super(iterable as Iterable<readonly [K, V]> | undefined);
      count++;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Map')!;
  Object.defineProperty(globalThis, 'Map', { ...descriptor, value: CountingMap });
  try {
    if (positiveControl) new Map();
    const tl = createTimeline({
      segments: [{ from: 0, to: 1, duration: 1, ...(withLabels ? { at: 'origin' } : {}) }],
      ...(withLabels ? { labels: { origin: 0 } } : {}),
      requestFrame: () => 1,
    });
    tl.cancel();
  } finally {
    Object.defineProperty(globalThis, 'Map', descriptor);
  }
  return count;
}

describe('timeline label ownership allocation ceiling', () => {
  it('keeps construction to one Map with and without initial labels', () => {
    expect(countConstructionMaps(false)).toBeLessThanOrEqual(1);
    expect(countConstructionMaps(true)).toBeLessThanOrEqual(1);
  });

  it('runtime label mutation does not rewrite compiled segment positions', () => {
    let value = Number.NaN;
    const tl = createTimeline({
      segments: [{ from: 0, to: 1, duration: 1, at: 'origin', onStep: (next) => { value = next; } }],
      labels: { origin: 2 },
      requestFrame: () => 1,
    });
    expect(tl.totalDuration).toBe(3);
    tl.label('origin', 0);
    expect(tl.totalDuration).toBe(3);
    tl.seek(1);
    expect(tl.time).toBe(1);
    expect(value).toBe(0);
    tl.seek('origin');
    expect(tl.time).toBe(0);
    tl.cancel();
  });

  it('keeps the public label control non-constructable', () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 1, duration: 1 }],
      requestFrame: () => 1,
    });
    expect(Object.hasOwn(tl.label, 'prototype')).toBe(false);
    expect(() => Reflect.construct(tl.label as unknown as Function, [])).toThrow(TypeError);
    tl.cancel();
  });

  it('detects a deliberate extra retained-shape Map', () => {
    const normal = countConstructionMaps(false);
    expect(countConstructionMaps(false, true)).toBe(normal + 1);
  });
});
