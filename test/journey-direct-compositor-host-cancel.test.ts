import { describe, expect, it } from 'vitest';
import { createCompositorBottomSheet } from '../src/behaviors/compositor/index.js';

describe('JOURNEY-01 host cancellation boundary', () => {
  it('завершение donor не меняет новое намерение из host cancel', async () => {
    let resolve!: () => void;
    let sheet!: ReturnType<typeof createCompositorBottomSheet>;
    let reentered = false;
    sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      compositor: {
        property: 'translate',
        apply() {},
        target: {
          animate() {
            return {
              currentTime: 0,
              finished: new Promise<void>((done) => { resolve = done; }),
              cancel() {
                if (!reentered) {
                  reentered = true;
                  sheet.pointerDown({ x: 0, y: 300, t: 1 });
                }
              },
            };
          },
        },
      },
    });
    sheet.snapTo(1);
    resolve();
    await Promise.resolve();
    expect(reentered).toBe(true);
    expect(sheet.state.phase).toBe('follow');
    sheet.pointerMove({ x: 0, y: 320, t: 1.1 });
    expect(sheet.state.value).toBe(310);
    sheet.destroy();
  });

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
