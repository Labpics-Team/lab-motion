import { describe, expect, it } from 'vitest';
import { createCompositorBottomSheet } from '../src/behaviors/compositor/index.js';

describe('JOURNEY-01 host cancellation boundary', () => {
  it('keeps newer input authoritative when stale host cancellation throws', () => {
    let sheet!: ReturnType<typeof createCompositorBottomSheet>;
    const target = {
      animate() {
        const animation = {
          currentTime: 0,
          cancel() { throw new Error('host cancel failed'); },
          finished: new Promise<void>(() => {}),
        };
        sheet.pointerDown({ x: 0, y: 20, t: 0.01 });
        return animation;
      },
    };
    sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      compositor: { target, property: 'translate', apply() {} },
    });

    expect(() => sheet.snapTo(1)).not.toThrow();
    expect(sheet.state.phase).toBe('follow');
    sheet.destroy();
  });

  it('completes controller teardown when active host cancellation throws', () => {
    let calls = 0;
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      compositor: {
        target: {
          animate() {
            calls++;
            return {
              currentTime: 0,
              cancel() { throw new Error('host cancel failed'); },
              finished: new Promise<void>(() => {}),
            };
          },
        },
        property: 'translate',
        apply() {},
      },
    });
    sheet.snapTo(1);
    expect(calls).toBe(1);

    expect(() => sheet.destroy()).not.toThrow();
    sheet.snapTo(0);
    expect(calls).toBe(1);
  });
});
