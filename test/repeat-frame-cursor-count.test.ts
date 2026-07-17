import { describe, expect, it, vi } from 'vitest';

const work = vi.hoisted(() => ({ cursorCalls: 0 }));

vi.mock('../src/internal/repeat-cursor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/internal/repeat-cursor.js')>();
  return {
    ...actual,
    repeatCursor(...args: Parameters<typeof actual.repeatCursor>): number {
      work.cursorCalls++;
      return actual.repeatCursor(...args);
    },
  };
});

import { keyframes } from '../src/keyframes/index.js';
import { runPreset } from '../src/presets/index.js';

describe('repeat frame cursor — one schedule evaluation per attempted frame', () => {
  it('reuses the proven cursor for sampling and keeps failed horizon work single-pass', () => {
    const keyframeCallbacks: Array<(timestamp?: number) => void> = [];
    const presetCallbacks: Array<(timestamp?: number) => void> = [];
    const keyframeControls = keyframes({
      values: [0, 1],
      duration: 1,
      repeat: Infinity,
      repeatType: 'mirror',
      requestFrame(callback) {
        keyframeCallbacks.push(callback);
        return keyframeCallbacks.length;
      },
    });
    const presetControls = runPreset({
      duration: 1,
      repeat: Infinity,
      repeatType: 'mirror',
      tracks: [{ property: 'x', values: [0, 1] }],
    }, {
      requestFrame(callback) {
        presetCallbacks.push(callback);
        return presetCallbacks.length;
      },
    });

    work.cursorCalls = 0;
    keyframeCallbacks[0]!(0);
    presetCallbacks[0]!(0);
    expect(work.cursorCalls).toBe(2);

    expect(() => keyframeCallbacks[1]!(1e20)).toThrowError(/^LM166$/);
    expect(() => presetCallbacks[1]!(1e20)).toThrowError(/^LM166$/);
    expect(work.cursorCalls).toBe(4);

    keyframeControls.complete();
    presetControls.complete();
  });
});
