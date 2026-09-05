import { describe, expect, it } from 'vitest';
import { animateCompiled } from '../src/compiler/runtime/index.js';

type AnimateCall = {
  readonly frame: Keyframe[] | PropertyIndexedKeyframes | null;
  readonly timing: number | KeyframeAnimationOptions | undefined;
};

function fakeAnimation(): Animation {
  return {
    finished: Promise.resolve(undefined as unknown as Animation),
    addEventListener() {},
  } as unknown as Animation;
}

function target(calls: AnimateCall[]): Element {
  return {
    animate(frame: Keyframe[] | PropertyIndexedKeyframes | null, timing?: number | KeyframeAnimationOptions) {
      calls.push({ frame, timing });
      return fakeAnimation();
    },
  } as unknown as Element;
}

describe('compiled Nano runtime — call-scoped allocation contract', () => {
  it('переиспользует frame/timing внутри вызова и не делит snapshots между вызовами', () => {
    const artifact = { o: 0.5, d: 120, e: 'linear' } as const;
    const firstCalls: AnimateCall[] = [];
    const secondCalls: AnimateCall[] = [];
    const firstTargets = Array.from({ length: 1_000 }, () => target(firstCalls));
    const secondTargets = Array.from({ length: 1_000 }, () => target(secondCalls));

    animateCompiled(firstTargets as unknown as Parameters<typeof animateCompiled>[0], artifact);
    animateCompiled(secondTargets as unknown as Parameters<typeof animateCompiled>[0], artifact);

    expect(firstCalls).toHaveLength(1_000);
    expect(secondCalls).toHaveLength(1_000);
    expect(new Set(firstCalls.map(({ frame }) => frame)).size).toBe(1);
    expect(new Set(firstCalls.map(({ timing }) => timing)).size).toBe(1);
    expect(new Set(secondCalls.map(({ frame }) => frame)).size).toBe(1);
    expect(new Set(secondCalls.map(({ timing }) => timing)).size).toBe(1);
    expect(firstCalls[0]!.frame).not.toBe(secondCalls[0]!.frame);
    expect(firstCalls[0]!.timing).not.toBe(secondCalls[0]!.timing);
  });
});
