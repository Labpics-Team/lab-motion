import { describe, expect, it } from 'vitest';
import { CompositorSpring } from '../src/compositor/index.js';
import { createCompositorHandoffLatencySample } from '../scripts/bench-latency-support.mjs';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

describe('handoff latency fixture lifecycle', () => {
  it('measures one complete compositor-to-live handoff per fresh sample', () => {
    let now = 1_000;
    const makeSample = () => createCompositorHandoffLatencySample({
      CompositorSpring,
      spring: SPRING,
      property: 'x',
      from: 0,
      to: 100,
      now: () => now,
    });

    const first = makeSample();
    now += 16;
    const firstLive = first.controller.handoffToLive();
    expect(first.verify(firstLive)).toEqual({ animations: 1, cancels: 1, frameRequests: 1 });
    firstLive.destroy();

    const second = makeSample();
    now += 16;
    const secondLive = second.controller.handoffToLive();
    expect(secondLive).not.toBe(firstLive);
    expect(second.verify(secondLive)).toEqual({ animations: 1, cancels: 1, frameRequests: 1 });
    secondLive.destroy();
  });

  it('rejects the former reused-controller no-op lifecycle', () => {
    let now = 1_000;
    const sample = createCompositorHandoffLatencySample({
      CompositorSpring,
      spring: SPRING,
      property: 'x',
      from: 0,
      to: 100,
      now: () => now,
    });

    now += 16;
    const firstLive = sample.controller.handoffToLive();
    sample.verify(firstLive);
    firstLive.destroy();

    sample.controller.start();
    now += 16;
    const repeatedLive = sample.controller.handoffToLive();
    expect(repeatedLive).toBe(firstLive);
    expect(() => sample.verify(repeatedLive)).toThrow(/повторно использован/i);
  });
});
