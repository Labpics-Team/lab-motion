import { describe, expect, it } from 'vitest';
import { createBottomSheet, createCarousel } from '../src/behaviors/index.js';
import { MotionParamError } from '../src/errors.js';
import { makeClock, pt } from './behaviors-helpers.js';

/**
 * JOURNEY-01 lower-bound + owner-retarget admission oracle.
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
 * forbids. The arithmetic lower bound below is independent of production code.
 *
 * The second block is deliberately adversarial: it executes the public update()
 * contract against a queued stale frame, invalid input, a live follow anchor and
 * reentrant destroy. These cases are the executable falsifiers for the tempting
 * broken implementations: dropping transferred velocity, removing generation
 * invalidation, mutating geometry before validation, failing to re-anchor follow,
 * or starting a runner after ownership is destroyed.
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

describe('./behaviors JOURNEY resize owner — executable adversarial falsifiers', () => {
  it('sheet release retarget keeps C0/C1 and suppresses the queued stale generation', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({
      snapPoints: [0, 300, 600],
      requestFrame: clock.requestFrame,
    });

    sheet.snapTo(2);
    clock.step(16);
    clock.step(16);
    const before = sheet.state;
    expect(before.phase).toBe('release');
    expect(Math.abs(before.velocity)).toBeGreaterThan(0);

    const pendingBefore = clock.pending();
    sheet.update([0, 200, 400]);

    // update() invalidates the old generation and schedules exactly one live
    // replacement; the old callback remains physically queued as the hostile input.
    expect(clock.pending()).toBe(pendingBefore + 1);
    expect(sheet.state).toMatchObject({
      phase: 'release',
      value: before.value,
      velocity: before.velocity,
      snapIndex: 2,
    });

    const published: number[] = [];
    const stop = sheet.subscribe((state) => published.push(state.value));
    clock.step(16);
    stop();

    // Both queued callbacks are executed by makeClock.step(). Only the current
    // generation may publish; dropping generation-guard or velocity transfer is RED.
    expect(published).toHaveLength(1);
    expect(sheet.state.velocity).toBeCloseTo(before.velocity, 9);
    clock.drain(16);
    expect(sheet.state.value).toBeCloseTo(400, 3);
    expect(clock.pending()).toBe(0);
  });

  it('invalid sheet update is atomic and cannot disturb the live runner', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({
      snapPoints: [0, 300, 600],
      requestFrame: clock.requestFrame,
    });

    sheet.snapTo(2);
    clock.step(16);
    const before = sheet.state;
    const pending = clock.pending();
    const rafCalls = clock.rafCalls();

    expect(() => sheet.update([0, Number.NaN, 400])).toThrowError(MotionParamError);
    expect(sheet.state).toBe(before);
    expect(clock.pending()).toBe(pending);
    expect(clock.rafCalls()).toBe(rafCalls);

    // The pre-existing owner must still settle against the old geometry.
    clock.drain(16);
    expect(sheet.state.value).toBeCloseTo(600, 3);
    expect(sheet.state.snapIndex).toBe(2);
  });

  it('sheet follow resize re-anchors inside the same owner without a repair frame', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({
      snapPoints: [0, 300, 600],
      rubberBand: 0.5,
      requestFrame: clock.requestFrame,
    });

    sheet.pointerDown(pt(0, 0, 0));
    sheet.pointerMove(pt(0, 300, 0.1));
    const before = sheet.state.value;
    const rafCalls = clock.rafCalls();

    sheet.update([0, 200, 400]);
    expect(sheet.state).toMatchObject({ phase: 'follow', value: before });
    expect(clock.rafCalls()).toBe(rafCalls);

    // Same pointer coordinate stays continuous; later movement uses new bounds.
    sheet.pointerMove(pt(0, 300, 0.15));
    expect(sheet.state.value).toBe(before);
    sheet.pointerMove(pt(0, 600, 0.2));
    expect(sheet.state.value).toBeCloseTo(500, 6);
  });

  it('pager release resize uses the same clock and keeps legal state after shrink', () => {
    const clock = makeClock();
    const pager = createCarousel({
      pageCount: 4,
      pageSize: 200,
      index: 3,
      requestFrame: clock.requestFrame,
    });

    pager.goTo(0);
    clock.step(16);
    clock.step(16);
    const before = pager.state;
    const pendingBefore = clock.pending();

    pager.update(2, 120);
    expect(clock.pending()).toBe(pendingBefore + 1);
    expect(pager.state.value).toBe(before.value);
    expect(pager.state.velocity).toBe(before.velocity);
    expect(pager.state.index).toBeLessThan(2);

    clock.drain(16);
    expect(pager.state.index).toBeLessThan(2);
    expect(pager.state.value).toBeCloseTo(0, 3);
    expect(clock.pending()).toBe(0);
  });

  it('reentrant destroy at release publication cannot orphan a new runner', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({
      snapPoints: [0, 300],
      requestFrame: clock.requestFrame,
    });
    let destroyed = false;

    sheet.subscribe((state) => {
      if (state.phase === 'release' && !destroyed) {
        destroyed = true;
        sheet.destroy();
      }
    });

    sheet.snapTo(1);
    expect(destroyed).toBe(true);
    expect(clock.pending()).toBe(0);

    sheet.update([0, 200]);
    sheet.snapTo(0);
    expect(clock.pending()).toBe(0);
  });
});
