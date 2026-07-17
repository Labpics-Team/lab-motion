import { describe, expect, it } from 'vitest';
import { MotionParamError } from '../src/errors.js';
import {
  keyframes,
  type KeyframesControls,
} from '../src/keyframes/index.js';
import {
  compilePreset,
  presetToWaapi,
  runPreset,
  type PresetControls,
} from '../src/presets/index.js';
import { compileWaapi } from '../src/waapi/index.js';

const frozenFrame = (): number => 1;

describe('repeat runtime — canonical public boundaries', () => {
  it('runPreset.progress publishes the next iteration at an exact intermediate boundary', () => {
    const emitted: number[] = [];
    const controls = runPreset({
      duration: 1,
      repeat: 1,
      tracks: [{ property: 'x', values: [0, 100] }],
    }, {
      requestFrame: frozenFrame,
      onUpdate: (values) => emitted.push(values.x!),
    });

    controls.pause();
    controls.seek(1);

    expect(emitted.at(-1)).toBe(0);
    expect(controls.time).toBe(1);
    expect(controls.progress).toBe(0);
    controls.cancel();
  });
});

describe('repeat runtime — reentrant easing is linearizable', () => {
  it.each(['seek', 'cancel'] as const)(
    'bounds always-reentrant %s to one deferred sampling pass',
    (operation) => {
      let keyframeControls!: KeyframesControls;
      let presetControls!: PresetControls;
      let keyframeCalls = 0;
      let presetCalls = 0;
      let keyframeReentry = true;
      let presetReentry = true;
      const keyframeValues: number[] = [];
      const presetValues: number[] = [];

      keyframeControls = keyframes({
        values: [0, 100],
        duration: 1,
        easing(t) {
          keyframeCalls++;
          if (keyframeReentry && keyframeCalls <= 8) {
            if (operation === 'seek') keyframeControls.seek(0.75);
            else keyframeControls.cancel();
          }
          return t;
        },
        requestFrame: frozenFrame,
        onStep: (value) => keyframeValues.push(value),
      });
      presetControls = runPreset({
        duration: 1,
        tracks: [{
          property: 'x',
          values: [0, 100],
          easing(t) {
            presetCalls++;
            if (presetReentry && presetCalls <= 8) {
              if (operation === 'seek') presetControls.seek(0.75);
              else presetControls.cancel();
            }
            return t;
          },
        }],
      }, {
        requestFrame: frozenFrame,
        onUpdate: (values) => presetValues.push(values.x!),
      });
      keyframeControls.pause();
      presetControls.pause();

      expect(() => keyframeControls.seek(0.25)).not.toThrow();
      expect(() => presetControls.seek(0.25)).not.toThrow();

      expect(keyframeCalls).toBe(2);
      expect(presetCalls).toBe(2);
      const expected = operation === 'seek' ? 75 : 25;
      expect(keyframeValues).toEqual([expected]);
      expect(presetValues).toEqual([expected]);

      keyframeReentry = false;
      presetReentry = false;
      keyframeControls.cancel();
      presetControls.cancel();
    },
  );

  it('ignores a deferred complete consistently across both runners', () => {
    let keyframeControls!: KeyframesControls;
    let presetControls!: PresetControls;
    let reenter = true;
    const keyframeValues: number[] = [];
    const presetValues: number[] = [];

    keyframeControls = keyframes({
      values: [0, 100],
      duration: 1,
      easing(t) {
        if (reenter) {
          if (t < 0.5) keyframeControls.seek(0.75);
          else keyframeControls.complete();
        }
        return t;
      },
      requestFrame: frozenFrame,
      onStep: (value) => keyframeValues.push(value),
    });
    presetControls = runPreset({
      duration: 1,
      tracks: [{
        property: 'x',
        values: [0, 100],
        easing(t) {
          if (reenter) {
            if (t < 0.5) presetControls.seek(0.75);
            else presetControls.complete();
          }
          return t;
        },
      }],
    }, {
      requestFrame: frozenFrame,
      onUpdate: (values) => presetValues.push(values.x!),
    });
    keyframeControls.pause();
    presetControls.pause();

    keyframeControls.seek(0.25);
    presetControls.seek(0.25);

    expect(keyframeValues).toEqual([75]);
    expect(presetValues).toEqual([75]);
    expect([keyframeControls.time, keyframeControls.progress]).toEqual([0.75, 0.75]);
    expect([presetControls.time, presetControls.progress]).toEqual([0.75, 0.75]);

    reenter = false;
    keyframeControls.cancel();
    presetControls.cancel();
  });

  it('keeps the operation lease when a proven frame cursor reenters seek', () => {
    const keyframeCallbacks: Array<(timestamp?: number) => void> = [];
    const presetCallbacks: Array<(timestamp?: number) => void> = [];
    const keyframeValues: number[] = [];
    const presetValues: number[] = [];
    let keyframeControls!: KeyframesControls;
    let presetControls!: PresetControls;
    let keyframeFirst = true;
    let presetFirst = true;

    keyframeControls = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: Infinity,
      easing(t) {
        if (keyframeFirst) {
          keyframeFirst = false;
          keyframeControls.seek(0.75);
        }
        return t;
      },
      requestFrame(callback) {
        keyframeCallbacks.push(callback);
        return keyframeCallbacks.length;
      },
      onStep: (value) => keyframeValues.push(value),
    });
    presetControls = runPreset({
      duration: 1,
      repeat: Infinity,
      tracks: [{
        property: 'x',
        values: [0, 100],
        easing(t) {
          if (presetFirst) {
            presetFirst = false;
            presetControls.seek(0.75);
          }
          return t;
        },
      }],
    }, {
      requestFrame(callback) {
        presetCallbacks.push(callback);
        return presetCallbacks.length;
      },
      onUpdate: (values) => presetValues.push(values.x!),
    });

    keyframeCallbacks[0]!(0);
    presetCallbacks[0]!(0);
    expect(keyframeControls.time).toBe(0.75);
    expect(presetControls.time).toBe(0.75);
    expect(keyframeValues).toEqual([75]);
    expect(presetValues).toEqual([75]);
    keyframeControls.cancel();
    presetControls.cancel();
  });

  it('keyframes: a nested seek wins and the stale outer sample is not emitted', () => {
    let controls!: KeyframesControls;
    let first = true;
    let easingDepth = 0;
    let maxEasingDepth = 0;
    const emitted: number[] = [];
    const easing = (t: number): number => {
      easingDepth++;
      maxEasingDepth = Math.max(maxEasingDepth, easingDepth);
      try {
        if (first) {
          first = false;
          controls.seek(0.75);
        }
        return t * t;
      } finally {
        easingDepth--;
      }
    };
    controls = keyframes({
      values: [0, 100],
      duration: 1,
      easing,
      requestFrame: frozenFrame,
      onStep: (value) => emitted.push(value),
    });
    controls.pause();

    controls.seek(0.25);

    expect(controls.time).toBe(0.75);
    expect(controls.progress).toBe(0.75);
    expect(emitted).toEqual([56.25]);
    expect(maxEasingDepth).toBe(1);
    controls.cancel();
  });

  it('keyframes: a nested cancel settles once and suppresses the outer emission', () => {
    let controls!: KeyframesControls;
    let first = true;
    let easingDepth = 0;
    let maxEasingDepth = 0;
    const emitted: number[] = [];
    const easing = (t: number): number => {
      easingDepth++;
      maxEasingDepth = Math.max(maxEasingDepth, easingDepth);
      try {
        if (first) {
          first = false;
          controls.cancel();
        }
        return t * t;
      } finally {
        easingDepth--;
      }
    };
    controls = keyframes({
      values: [0, 100],
      duration: 1,
      easing,
      requestFrame: frozenFrame,
      onStep: (value) => emitted.push(value),
    });
    controls.pause();

    controls.seek(0.25);

    expect(controls.time).toBe(0.25);
    expect(emitted).toEqual([6.25]);
    controls.seek(0.75);
    expect(controls.time).toBe(0.25);
    expect(maxEasingDepth).toBe(1);
  });

  it('runPreset: a nested seek wins atomically across every track', () => {
    let controls!: PresetControls;
    let first = true;
    let easingDepth = 0;
    let maxEasingDepth = 0;
    const emitted: Array<readonly [number, number]> = [];
    const easing = (t: number): number => {
      easingDepth++;
      maxEasingDepth = Math.max(maxEasingDepth, easingDepth);
      try {
        if (first) {
          first = false;
          controls.seek(0.75);
        }
        return t * t;
      } finally {
        easingDepth--;
      }
    };
    controls = runPreset({
      duration: 1,
      tracks: [
        { property: 'x', values: [0, 100], easing },
        { property: 'opacity', values: [0, 1], easing: (t) => t },
      ],
    }, {
      requestFrame: frozenFrame,
      onUpdate: (values) => emitted.push([values.x!, values.opacity!]),
    });
    controls.pause();

    controls.seek(0.25);

    expect(controls.time).toBe(0.75);
    expect(emitted).toEqual([[56.25, 0.75]]);
    expect(maxEasingDepth).toBe(1);
    controls.cancel();
  });

  it('runPreset: a nested cancel settles once and suppresses the outer pose', () => {
    let controls!: PresetControls;
    let first = true;
    let easingDepth = 0;
    let maxEasingDepth = 0;
    const emitted: number[] = [];
    const easing = (t: number): number => {
      easingDepth++;
      maxEasingDepth = Math.max(maxEasingDepth, easingDepth);
      try {
        if (first) {
          first = false;
          controls.cancel();
        }
        return t * t;
      } finally {
        easingDepth--;
      }
    };
    controls = runPreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 100], easing }],
    }, {
      requestFrame: frozenFrame,
      onUpdate: (values) => emitted.push(values.x!),
    });
    controls.pause();

    controls.seek(0.25);

    expect(controls.time).toBe(0.25);
    expect(emitted).toEqual([6.25]);
    controls.seek(0.75);
    expect(controls.time).toBe(0.25);
    expect(maxEasingDepth).toBe(1);
  });
});

describe('repeat runtime — binary64 schedule and WAAPI artifacts fail closed', () => {
  const overflowingDuration = Number.MAX_VALUE / 2;

  it('keeps a valid portable repeat distinct from an unrepresentable schedule', () => {
    expect(() => keyframes({
      values: [0, 1],
      duration: overflowingDuration,
      repeat: 3,
      requestFrame: frozenFrame,
    })).toThrowError(/^LM161$/);
    expect(() => compilePreset({
      duration: overflowingDuration,
      repeat: 3,
      tracks: [{ property: 'x', values: [0, 1] }],
    })).toThrowError(/^LM161$/);
  });

  it('compileWaapi never emits infinite milliseconds, collapsed offsets, or iterations', () => {
    expect(() => compileWaapi({
      property: 'x',
      values: [0, 1],
      duration: Number.MAX_VALUE,
    })).toThrowError(/^LM162$/);
    expect(() => compileWaapi({
      property: 'x',
      values: [0, 1],
      duration: Number.MAX_VALUE,
      repeat: 1,
      repeatDelay: Number.MAX_VALUE,
    })).toThrowError(/^LM161$/);
    expect(() => compileWaapi({
      property: 'x',
      values: [0, 1],
      duration: overflowingDuration,
      repeat: 3,
    })).toThrowError(/^LM161$/);
    expect(() => compileWaapi({
      property: 'x',
      values: [0, 1],
      duration: Number.MAX_VALUE / 2000,
      repeat: 3,
    })).toThrowError(/^LM162$/);
  });

  it('presetToWaapi rejects non-finite timing and composed scale before returning data', () => {
    expect(() => presetToWaapi({
      duration: Number.MAX_VALUE,
      tracks: [{ property: 'x', values: [0, 1] }],
    })).toThrowError(/^LM162$/);
    expect(() => presetToWaapi({
      duration: Number.MAX_VALUE / 2000,
      repeat: 3,
      tracks: [{ property: 'x', values: [0, 1] }],
    })).toThrowError(/^LM162$/);
    expect(() => presetToWaapi({
      duration: 1,
      tracks: [
        { property: 'scale', values: [Number.MAX_VALUE, Number.MAX_VALUE] },
        { property: 'scaleX', values: [Number.MAX_VALUE, Number.MAX_VALUE] },
      ],
    })).toThrowError(/^LM162$/);
  });
});

describe('repeat runtime — hostile injectable boundaries', () => {
  it.each([NaN, Infinity, -Infinity])(
    'treats hostile timestamp %s as a missing frame in both runners',
    async (hostileTimestamp) => {
      const keyframeCallbacks: Array<(timestamp?: number) => void> = [];
      const presetCallbacks: Array<(timestamp?: number) => void> = [];
      const keyframeControls = keyframes({
        values: [0, 1],
        repeat: Infinity,
        requestFrame(callback) {
          keyframeCallbacks.push(callback);
          return keyframeCallbacks.length;
        },
      });
      const presetControls = runPreset({
        duration: 1,
        repeat: Infinity,
        tracks: [{ property: 'x', values: [0, 1] }],
      }, {
        requestFrame(callback) {
          presetCallbacks.push(callback);
          return presetCallbacks.length;
        },
      });

      keyframeCallbacks[0]!(0);
      presetCallbacks[0]!(0);
      const keyframeStep = keyframeControls.time;
      const presetStep = presetControls.time;

      expect(() => keyframeCallbacks[1]!(hostileTimestamp)).not.toThrow();
      expect(() => presetCallbacks[1]!(hostileTimestamp)).not.toThrow();
      expect(keyframeControls.time).toBeCloseTo(keyframeStep * 2, 14);
      expect(presetControls.time).toBeCloseTo(presetStep * 2, 14);
      expect(Number.isFinite(keyframeControls.progress)).toBe(true);
      expect(Number.isFinite(presetControls.progress)).toBe(true);

      // Invalid input resets the real-time anchor. A later finite timestamp is
      // a fresh first frame, not a subtraction from poisoned host state.
      keyframeCallbacks[2]!(16);
      presetCallbacks[2]!(16);
      expect(keyframeControls.time).toBeCloseTo(keyframeStep * 3, 14);
      expect(presetControls.time).toBeCloseTo(presetStep * 3, 14);
      expect(keyframeCallbacks).toHaveLength(4);
      expect(presetCallbacks).toHaveLength(4);

      expect(() => keyframeControls.cancel()).not.toThrow();
      expect(() => presetControls.cancel()).not.toThrow();
      await Promise.all([keyframeControls, presetControls]);
    },
  );

  it('recovers from backward and overflowing finite timestamp deltas', () => {
    const keyframeCallbacks: Array<(timestamp?: number) => void> = [];
    const presetCallbacks: Array<(timestamp?: number) => void> = [];
    const keyframeControls = keyframes({
      values: [0, 1],
      repeat: Infinity,
      requestFrame(callback) {
        keyframeCallbacks.push(callback);
        return keyframeCallbacks.length;
      },
    });
    const presetControls = runPreset({
      duration: 1,
      repeat: Infinity,
      tracks: [{ property: 'x', values: [0, 1] }],
    }, {
      requestFrame(callback) {
        presetCallbacks.push(callback);
        return presetCallbacks.length;
      },
    });

    for (const timestamp of [-Number.MAX_VALUE, Number.MAX_VALUE, 32, 16, 48]) {
      const keyframeCallback = keyframeCallbacks.shift()!;
      const presetCallback = presetCallbacks.shift()!;
      expect(() => keyframeCallback(timestamp)).not.toThrow();
      expect(() => presetCallback(timestamp)).not.toThrow();
      expect(Number.isFinite(keyframeControls.time)).toBe(true);
      expect(Number.isFinite(presetControls.time)).toBe(true);
    }
    expect(keyframeControls.time).toBeCloseTo(4 / 60 + 0.032, 14);
    expect(presetControls.time).toBeCloseTo(4 / 60 + 0.032, 14);
    keyframeControls.cancel();
    presetControls.cancel();
  });

  it('rejects an unsafe next virtual time before committing clock or scheduler ownership', async () => {
    const keyframeCallbacks: Array<(timestamp?: number) => void> = [];
    const presetCallbacks: Array<(timestamp?: number) => void> = [];
    const keyframeControls = keyframes({
      values: [0, 1],
      duration: 1,
      repeat: Infinity,
      requestFrame(callback) {
        keyframeCallbacks.push(callback);
        return keyframeCallbacks.length;
      },
    });
    const presetControls = runPreset({
      duration: 1,
      repeat: Infinity,
      tracks: [{ property: 'x', values: [0, 1] }],
    }, {
      requestFrame(callback) {
        presetCallbacks.push(callback);
        return presetCallbacks.length;
      },
    });

    keyframeCallbacks[0]!(0);
    presetCallbacks[0]!(0);
    const keyframeBefore = keyframeControls.time;
    const presetBefore = presetControls.time;

    expect(() => keyframeCallbacks[1]!(1e20)).toThrowError(/^LM166$/);
    expect(() => presetCallbacks[1]!(1e20)).toThrowError(/^LM166$/);
    expect(keyframeControls.time).toBe(keyframeBefore);
    expect(presetControls.time).toBe(presetBefore);
    expect(() => keyframeControls.progress).not.toThrow();
    expect(() => presetControls.progress).not.toThrow();

    // The consumed/failed host callback stays stale even when invoked again.
    expect(() => keyframeCallbacks[1]!(16)).not.toThrow();
    expect(() => presetCallbacks[1]!(16)).not.toThrow();
    expect(keyframeCallbacks).toHaveLength(2);
    expect(presetCallbacks).toHaveLength(2);

    // play() explicitly re-arms a stopped non-paused owner after the failure.
    keyframeControls.play();
    presetControls.play();
    expect(keyframeCallbacks).toHaveLength(3);
    expect(presetCallbacks).toHaveLength(3);
    keyframeCallbacks[1]!(32);
    presetCallbacks[1]!(32);
    keyframeCallbacks[2]!(16);
    presetCallbacks[2]!(16);
    expect(keyframeControls.time).toBeCloseTo(keyframeBefore + 0.016, 14);
    expect(presetControls.time).toBeCloseTo(presetBefore + 0.016, 14);
    expect(keyframeCallbacks).toHaveLength(4);
    expect(presetCallbacks).toHaveLength(4);

    keyframeControls.cancel();
    presetControls.cancel();
    await Promise.all([keyframeControls, presetControls]);
  });

  it('keeps a tiny valid infinite cycle cancellable after its first frame crosses the horizon', async () => {
    const keyframeCallbacks: Array<(timestamp?: number) => void> = [];
    const presetCallbacks: Array<(timestamp?: number) => void> = [];
    const keyframeControls = keyframes({
      values: [0, 1],
      duration: Number.MIN_VALUE,
      repeat: Infinity,
      repeatDelay: Number.MIN_VALUE,
      requestFrame(callback) {
        keyframeCallbacks.push(callback);
        return 1;
      },
    });
    const presetControls = runPreset({
      duration: Number.MIN_VALUE,
      repeat: Infinity,
      repeatDelay: Number.MIN_VALUE,
      tracks: [{ property: 'x', values: [0, 1] }],
    }, {
      requestFrame(callback) {
        presetCallbacks.push(callback);
        return 1;
      },
    });

    expect(() => keyframeCallbacks[0]!(0)).toThrowError(/^LM166$/);
    expect(() => presetCallbacks[0]!(0)).toThrowError(/^LM166$/);
    expect(keyframeControls.time).toBe(0);
    expect(presetControls.time).toBe(0);
    expect(() => keyframeCallbacks[0]!(1)).not.toThrow();
    expect(() => presetCallbacks[0]!(1)).not.toThrow();

    expect(() => keyframeControls.complete()).not.toThrow();
    expect(() => presetControls.complete()).not.toThrow();
    await Promise.all([keyframeControls, presetControls]);
  });

  it('snapshots each requestFrame capability exactly once', () => {
    let keyframesReads = 0;
    const keyframeCallbacks: Array<(timestamp?: number) => void> = [];
    const keyframeControls = keyframes({
      values: [0, 1],
      get requestFrame() {
        keyframesReads++;
        return (callback: (timestamp?: number) => void): number => {
          keyframeCallbacks.push(callback);
          return keyframeCallbacks.length;
        };
      },
    });
    expect(keyframesReads).toBe(1);
    expect(keyframeCallbacks).toHaveLength(1);
    keyframeControls.cancel();

    let presetReads = 0;
    const presetCallbacks: Array<(timestamp?: number) => void> = [];
    const presetControls = runPreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 1] }],
    }, {
      get requestFrame() {
        presetReads++;
        return (callback: (timestamp?: number) => void): number => {
          presetCallbacks.push(callback);
          return presetCallbacks.length;
        };
      },
    });
    expect(presetReads).toBe(1);
    expect(presetCallbacks).toHaveLength(1);
    presetControls.cancel();
  });

  it('keyframes ignores a stale callback after a normal async reschedule', () => {
    const callbacks: Array<(timestamp?: number) => void> = [];
    const emitted: number[] = [];
    const controls = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: Infinity,
      requestFrame: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      onStep: (value) => emitted.push(value),
    });

    callbacks[0]!(0);
    expect(callbacks).toHaveLength(2);
    const timeAfterFirst = controls.time;
    const emissionsAfterFirst = emitted.length;

    callbacks[0]!(1000);
    expect(controls.time).toBe(timeAfterFirst);
    expect(emitted).toHaveLength(emissionsAfterFirst);
    expect(callbacks).toHaveLength(2);

    callbacks[1]!(16);
    expect(controls.time).toBeGreaterThan(timeAfterFirst);
    controls.cancel();
  });

  it('trampolines synchronous requestFrame in both public runners', () => {
    let keyframeCalls = 0;
    let presetCalls = 0;
    let keyframeControls: KeyframesControls | undefined;
    let presetControls: PresetControls | undefined;

    expect(() => {
      keyframeControls = keyframes({
        values: [0, 1],
        repeat: Infinity,
        requestFrame: (callback) => {
          keyframeCalls++;
          callback();
          return 1;
        },
      });
    }).not.toThrow();
    expect(() => {
      presetControls = runPreset({
        duration: 1,
        repeat: Infinity,
        tracks: [{ property: 'x', values: [0, 1] }],
      }, {
        requestFrame: (callback) => {
          presetCalls++;
          callback();
          return 1;
        },
      });
    }).not.toThrow();

    expect(keyframeCalls).toBe(1);
    expect(presetCalls).toBe(1);
    keyframeControls!.cancel();
    presetControls!.cancel();
  });

  it('does not turn repeat=Infinity into a finite animation at MAX_FRAMES', () => {
    let keyframeTick: ((timestamp?: number) => void) | undefined;
    let presetTick: ((timestamp?: number) => void) | undefined;
    const keyframeControls = keyframes({
      values: [0, 1],
      repeat: Infinity,
      requestFrame: (callback) => {
        keyframeTick = callback;
        return 1;
      },
    });
    const presetControls = runPreset({
      duration: 1,
      repeat: Infinity,
      tracks: [{ property: 'x', values: [0, 1] }],
    }, {
      requestFrame: (callback) => {
        presetTick = callback;
        return 1;
      },
    });

    for (let i = 0; i < 100_000; i++) {
      const keyframeCallback = keyframeTick!;
      const presetCallback = presetTick!;
      keyframeTick = undefined;
      presetTick = undefined;
      keyframeCallback();
      presetCallback();
    }

    expect(keyframeTick).toBeTypeOf('function');
    expect(presetTick).toBeTypeOf('function');
    expect(keyframeControls.progress).not.toBe(1);
    expect(presetControls.progress).not.toBe(1);
    keyframeControls.cancel();
    presetControls.cancel();
  });

  it('rejects non-callable easing entries and requestFrame with stable errors', () => {
    expect(() => keyframes({
      values: [0, 1],
      easing: [42 as never],
      requestFrame: frozenFrame,
    })).toThrowError(/^LM163$/);
    expect(() => compilePreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 1], easing: [42 as never] }],
    })).toThrowError(/^LM164$/);

    expect(() => keyframes({
      values: [0, 1],
      requestFrame: 42 as never,
    })).toThrowError(/^LM165$/);
    expect(() => runPreset({
      duration: 1,
      tracks: [{ property: 'x', values: [0, 1] }],
    }, {
      requestFrame: 42 as never,
    })).toThrowError(/^LM165$/);
  });
});

it('new public failures remain MotionParamError instances', () => {
  try {
    compileWaapi({ property: 'x', values: [0, 1], duration: Number.MAX_VALUE });
    expect.unreachable('must reject non-finite WAAPI milliseconds');
  } catch (error) {
    expect(error).toBeInstanceOf(MotionParamError);
  }
});
