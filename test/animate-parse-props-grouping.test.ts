import { describe, expect, it, vi } from 'vitest';
import { parseProps, type ChannelSpec } from '../src/animate/channels.js';
import { animate } from '../src/animate/index.js';
import { fakeEl } from './animate-facade-helpers.js';

function channelKeys(specs: readonly ChannelSpec[] | undefined): string[] {
  return specs?.map((spec) => spec._key) ?? [];
}

function countMaps(run: () => void): number {
  const NativeMap = globalThis.Map;
  let allocations = 0;
  class CountingMap<K, V> extends NativeMap<K, V> {
    constructor(entries?: readonly (readonly [K, V])[] | null) {
      super(entries);
      allocations++;
    }
  }
  vi.stubGlobal('Map', CountingMap);
  try {
    run();
  } finally {
    vi.unstubAllGlobals();
  }
  return allocations;
}

describe('animate: владение группировкой parseProps', () => {
  it('сохраняет порядок групп и каналов при смешанных свойствах', () => {
    const groups = parseProps({
      x: [0, 10],
      rotate: [0, 90],
      scale: [1, 2],
      opacity: [0, 1],
      marginLeft: ['0px', '12px'],
    });

    expect([...groups.keys()]).toEqual(['transform', 'opacity', 'margin-left']);
    expect(channelKeys(groups.get('transform'))).toEqual([
      'x',
      'rotate',
      'scaleX',
      'scaleY',
    ]);
    expect(channelKeys(groups.get('opacity'))).toEqual(['opacity']);
    expect(channelKeys(groups.get('margin-left'))).toEqual(['marginLeft']);
    expect(groups.get('margin-left')?.[0]?._kind).toBe('css');
  });

  it('не дублирует явно заданную ось scale', () => {
    const groups = parseProps({ scale: 2, scaleX: 3 });

    expect(channelKeys(groups.get('transform'))).toEqual(['scaleY', 'scaleX']);
  });

  it('не материализует второй Map группировки в публичном animate', () => {
    const target = fakeEl().el;
    const allocations = countMaps(() => {
      void animate(
        target,
        { opacity: [0, 1] },
        { matchMedia: () => ({ matches: true }) },
      );
    });

    // parseProps + registry owner + numeric state + residuals.
    // Любой второй группирующий Map увеличивает этот счётчик.
    expect(allocations).toBe(4);
  });

  it('allocation-oracle различает дополнительную материализацию группы', () => {
    const allocations = countMaps(() => {
      const groups = parseProps({ opacity: [0, 1] });
      void new Map(groups);
    });

    expect(allocations).toBe(2);
  });
});
