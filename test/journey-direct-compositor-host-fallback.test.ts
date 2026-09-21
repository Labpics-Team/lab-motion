import { describe, expect, it } from 'vitest';
import { createCompositorBottomSheet } from '../src/behaviors/compositor/index.js';

describe('JOURNEY-01 compositor host rejection', () => {
  it('falls back to the live owner when the host rejects the native plan', () => {
    const frames: Array<(timestamp?: number) => void> = [];
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      requestFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
      compositor: {
        target: {
          animate() {
            throw new TypeError('host rejected native plan');
          },
        },
        property: 'translate',
        apply() {},
      },
    });

    expect(() => sheet.snapTo(1)).not.toThrow();
    expect(sheet.state.phase).toBe('release');
    expect(frames).toHaveLength(1);
    sheet.destroy();
  });

  it('does not resurrect the rejected settle after animate reenters newer input', () => {
    const frames: Array<(timestamp?: number) => void> = [];
    let sheet!: ReturnType<typeof createCompositorBottomSheet>;
    const target = {
      animate() {
        sheet.pointerDown({ x: 0, y: 20, t: 0.01 });
        throw new TypeError('host rejected after reentry');
      },
    };
    sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      requestFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
      compositor: { target, property: 'translate', apply() {} },
    });

    sheet.snapTo(1);

    expect(sheet.state.phase).toBe('follow');
    expect(frames).toHaveLength(0);
    sheet.destroy();
  });

});
