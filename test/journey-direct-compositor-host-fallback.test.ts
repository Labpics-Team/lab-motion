import { describe, expect, it } from 'vitest';
import { createCompositorBottomSheet } from '../src/behaviors/compositor/index.js';

describe('JOURNEY-01 compositor host rejection', () => {
  it('surfaces native host rejection after publishing one coherent terminal state', () => {
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

    expect(() => sheet.snapTo(1)).toThrow('host rejected native plan');
    expect(sheet.state.phase).toBe('settle');
    expect(sheet.state.value).toBe(300);
    expect(sheet.state.velocity).toBe(0);
    expect(frames).toHaveLength(0);
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

    expect(() => sheet.snapTo(1)).toThrow('host rejected after reentry');

    expect(sheet.state.phase).toBe('follow');
    expect(frames).toHaveLength(0);
    sheet.destroy();
  });

  it.each([
    ['', 'LM010'],
    ['offset', 'LM011'],
    ['easing', 'LM011'],
    ['composite', 'LM011'],
  ])('rejects invalid public compositor property %j before unchecked compilation', (property, code) => {
    let thrown: unknown;
    try {
      createCompositorBottomSheet({
        snapPoints: [0, 300],
        compositor: {
          target: {
            animate() {
              throw new Error('must not reach host');
            },
          },
          property,
          apply() {},
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code });
  });

  it('keeps newer input authoritative when an instantaneous settle reenters through onStep', () => {
    let sheet!: ReturnType<typeof createCompositorBottomSheet>;
    let reentered = false;
    sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      matchMedia: () => ({ matches: true }),
      compositor: {
        target: {
          animate() {
            throw new Error('reduced motion must not animate');
          },
        },
        property: 'translate',
        apply(value) {
          if (!reentered && sheet && value === 300 && sheet.state.phase === 'release') {
            reentered = true;
            sheet.pointerDown({ x: 0, y: 300, t: 0.01 });
          }
        },
      },
    });

    sheet.snapTo(1);
    expect(reentered).toBe(true);
    expect(sheet.state.phase).toBe('follow');

    sheet.pointerMove({ x: 0, y: 320, t: 0.02 });
    expect(sheet.state.value).toBe(310);
    sheet.destroy();
  });

  it('discards a live fallback if requestFrame reenters newer input during handoff', () => {
    const frames: Array<(timestamp?: number) => void> = [];
    let sheet!: ReturnType<typeof createCompositorBottomSheet>;
    let reentered = false;
    sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      requestFrame(callback) {
        frames.push(callback);
        if (!reentered) {
          reentered = true;
          sheet.pointerDown({ x: 0, y: 40, t: 0.01 });
        }
        return frames.length;
      },
      compositor: {
        target: { animate: undefined as never },
        property: 'translate',
        apply() {},
      },
    });

    sheet.snapTo(1);
    expect(reentered).toBe(true);
    expect(sheet.state.phase).toBe('follow');

    sheet.pointerMove({ x: 0, y: 80, t: 0.02 });
    const afterMove = sheet.state.value;
    expect(afterMove).toBe(40);

    frames.shift()?.(16);
    frames.shift()?.(32);
    expect(sheet.state.phase).toBe('follow');
    expect(sheet.state.value).toBe(afterMove);
    sheet.destroy();
  });

  it('finishes the active native owner when the host completion promise rejects', async () => {
    let rejectFinished!: (reason?: unknown) => void;
    let canceled = 0;
    const finished = new Promise<never>((_resolve, reject) => {
      rejectFinished = reject;
    });
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300],
      compositor: {
        target: {
          animate() {
            return {
              currentTime: null,
              finished,
              cancel() {
                canceled++;
              },
            };
          },
        },
        property: 'translate',
        apply() {},
      },
    });

    sheet.snapTo(1);
    expect(sheet.state.phase).toBe('release');

    rejectFinished(new Error('host aborted native animation'));
    await Promise.resolve();

    expect(sheet.state.phase).toBe('settle');
    expect(sheet.state.value).toBe(300);
    expect(sheet.state.velocity).toBe(0);
    expect(canceled).toBe(1);
    sheet.destroy();
  });
});
