import { describe, expect, it, vi } from 'vitest';

const work = vi.hoisted(() => ({ builds: 0 }));

vi.mock('../src/compositor/segmenter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compositor/segmenter.js')>();
  return {
    ...actual,
    tryBuildSpringNodes(...args: Parameters<typeof actual.tryBuildSpringNodes>) {
      work.builds++;
      return actual.tryBuildSpringNodes(...args);
    },
  };
});

import * as animateApi from '../src/animate/index.js';
import { DEFAULT_CACHE_CAPACITY } from '../src/compositor/cache.js';
import type { SpringParams } from '../src/spring.js';
import { fakeEl, pickAnimate } from './animate-facade-helpers.js';

const animate = pickAnimate(animateApi as Record<string, unknown>);

function compileThroughAnimate(spring: SpringParams): void {
  const target = fakeEl({}, true);
  const controls = animate(target.el, { opacity: [0, 1] }, {
    spring,
    setTimer: () => () => {},
  });
  expect(target.animateCalls).toHaveLength(1);
  controls.cancel();
}

describe('animate: shared exact-LRU spring compiler', () => {
  it('retains a 17-key working set across repeated rounds', () => {
    const springs = Array.from({ length: 17 }, (_, i) => ({
      mass: 1,
      stiffness: 401 + i,
      damping: 26,
    }));
    const before = work.builds;
    for (let round = 0; round < 10; round++) {
      for (const spring of springs) compileThroughAnimate(spring);
    }

    // Cache capacity, а не небольшой FIFO: все последующие раунды — hot hits.
    expect(work.builds - before).toBe(springs.length);
  });

  it('touches key 0 before insertion 257 and never recompiles it', () => {
    expect(DEFAULT_CACHE_CAPACITY).toBe(256);
    const springs = Array.from({ length: DEFAULT_CACHE_CAPACITY + 1 }, (_, i) => ({
      mass: 1.125,
      stiffness: 701 + i,
      damping: 31,
    }));
    const before = work.builds;
    for (let i = 0; i < DEFAULT_CACHE_CAPACITY; i++) compileThroughAnimate(springs[i]!);

    // Exact legal-dist oracle: hit key0 делает его MRU; cold key256 должен
    // вытеснить key1. FIFO пересобрал бы финальный key0 и дал 258 builds.
    compileThroughAnimate(springs[0]!);
    compileThroughAnimate(springs[DEFAULT_CACHE_CAPACITY]!);
    compileThroughAnimate(springs[0]!);
    expect(work.builds - before).toBe(257);

    // Capacity действительно 256: key1 был LRU и обязан дать один cold miss;
    // повторный key0 после этого всё ещё MRU и не может пересобираться.
    compileThroughAnimate(springs[1]!);
    expect(work.builds - before).toBe(258);
    compileThroughAnimate(springs[0]!);
    expect(work.builds - before).toBe(258);
  });
});
