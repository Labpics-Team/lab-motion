import { describe, expect, it } from 'vitest';
import { createBottomSheet, createCarousel } from '../src/behaviors/index.js';
import { makeClock, pt } from './behaviors-helpers.js';

/**
 * JOURNEY-01 lower-bound oracle.
 *
 * Tempting zero-byte workaround for mutable constraints: keep the behavior in a
 * normalized coordinate domain and let a DOM adapter multiply state by current
 * geometry. That preserves the controller identity, but not observable C0/C1
 * when geometry changes while the owner is live:
 *
 *   y = S x,  y' = S x'  (for constant S)
 *
 * A discrete S0 -> S1 with the same live (x, x') therefore changes y whenever
 * x != 0 and changes y' whenever x' != 0. Hiding that requires consumer-owned
 * correction/velocity transfer, exactly the app-side service protocol r11/M-09
 * forbids. The production behavior is only the witness that x/x' are genuinely
 * live; the oracle below is independent arithmetic, not a production helper.
 */
const project = (value: number, scale: number): number => value * scale;

describe('./behaviors JOURNEY resize lower bound — adapter-only normalization', () => {
  it('bottom sheet: geometry-only resize breaks position in follow and position+velocity in release', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({ snapPoints: [0, 1, 2], requestFrame: clock.requestFrame });

    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 0.75, 0.1));
    expect(sheet.state.phase).toBe('follow');
    expect(sheet.state.value).not.toBe(0);

    const follow = sheet.state.value;
    const oldScale = 300;
    const newScale = 180;
    expect(project(follow, oldScale)).not.toBe(project(follow, newScale));

    sheet.pointerUp(pt(0, 0.75, 0.12));
    clock.step(16);
    clock.step(16);
    expect(sheet.state.phase).toBe('release');
    expect(sheet.state.value).not.toBe(0);
    expect(sheet.state.velocity).not.toBe(0);

    const { value, velocity } = sheet.state;
    expect(project(value, oldScale)).not.toBe(project(value, newScale));
    expect(project(velocity, oldScale)).not.toBe(project(velocity, newScale));

    // A/A control: unchanged geometry produces no artificial discontinuity.
    expect(project(value, oldScale)).toBe(project(value, oldScale));
    expect(project(velocity, oldScale)).toBe(project(velocity, oldScale));
  });

  it('pager: geometry-only resize has the same lower bound while preserving the one owner', () => {
    const clock = makeClock();
    const pager = createCarousel({
      pageCount: 3,
      pageSize: 1,
      velocityThreshold: 2,
      requestFrame: clock.requestFrame,
    });

    pager.pointerDown(pt(0, 0, 0));
    pager.pointerMove(pt(-0.6, 0, 0.1));
    expect(pager.state.phase).toBe('follow');
    expect(pager.state.value).not.toBe(0);

    const follow = pager.state.value;
    const oldScale = 240;
    const newScale = 144;
    expect(project(follow, oldScale)).not.toBe(project(follow, newScale));

    pager.pointerUp(pt(-0.8, 0, 0.12));
    clock.step(16);
    clock.step(16);
    expect(pager.state.phase).toBe('release');
    expect(pager.state.value).not.toBe(0);
    expect(pager.state.velocity).not.toBe(0);

    const { value, velocity } = pager.state;
    expect(project(value, oldScale)).not.toBe(project(value, newScale));
    expect(project(velocity, oldScale)).not.toBe(project(velocity, newScale));

    expect(project(value, oldScale)).toBe(project(value, oldScale));
    expect(project(velocity, oldScale)).toBe(project(velocity, oldScale));
  });
});
