import { describe, expect, it } from 'vitest';
import { createBottomSheet, createCarousel } from '../src/behaviors/index.js';
import { flickX, flickY, makeClock } from './behaviors-helpers.js';

/**
 * JOURNEY-01 owner-preserving retarget characterization.
 *
 * The adapter-only resize family is already falsified by the sibling lower-bound
 * oracle. Before adding any mutable-constraint API, prove the existing owners
 * already contain the only lifecycle mechanism the implementation needs:
 * invalidate the old generation, restart the same runner from the exact live
 * (value, velocity), and let stale scheduled callbacks self-suppress.
 *
 * This file intentionally uses only the shipped public controller operations.
 * It is a reuse/admission witness, not a second runner or a proposed API.
 */
describe('./behaviors JOURNEY resize seam — reuse the existing owner', () => {
  it('bottom sheet retarget preserves the live C0/C1 boundary and kills the old generation', () => {
    const clock = makeClock();
    const sheet = createBottomSheet({
      snapPoints: [0, 100, 200],
      requestFrame: clock.requestFrame,
    });

    flickY(sheet, 0, 130, 0.1);
    clock.step(16);
    clock.step(16);

    expect(sheet.state.phase).toBe('release');
    expect(sheet.state.value).not.toBe(0);
    expect(sheet.state.velocity).not.toBe(0);

    const before = { value: sheet.state.value, velocity: sheet.state.velocity };
    expect(clock.pending()).toBe(1);
    let emissions = 0;
    sheet.subscribe(() => emissions++);

    // Existing programmatic retarget is the seam a mutable-constraint update can
    // reuse: no consumer-owned velocity transfer and no second clock/state owner.
    sheet.snapTo(0);

    expect(sheet.state.phase).toBe('release');
    expect(sheet.state.snapIndex).toBe(0);
    expect(sheet.state.value).toBe(before.value);
    expect(sheet.state.velocity).toBe(before.velocity);

    // One stale callback from the old generation is still physically queued and
    // one callback belongs to the new generation. Generation ownership, not an
    // app-side cancel-handle collection, must make the former inert.
    expect(clock.pending()).toBe(2);
    emissions = 0;
    clock.step(16);
    expect(emissions).toBe(1); // stale generation не имеет права публиковать state
    expect(Number.isFinite(sheet.state.value)).toBe(true);
    expect(Number.isFinite(sheet.state.velocity)).toBe(true);

    clock.drain();
    expect(sheet.state.value).toBe(0);
    expect(sheet.state.velocity).toBe(0);
    expect(sheet.state.snapIndex).toBe(0);
    expect(sheet.state.phase).toBe('settle');
    expect(clock.pending()).toBe(0);
  });

  it('pager retarget preserves C0/C1 while publishing the new index only at settle', () => {
    const clock = makeClock();
    const pager = createCarousel({
      pageCount: 3,
      pageSize: 100,
      velocityThreshold: 300,
      requestFrame: clock.requestFrame,
    });

    flickX(pager, 0, -80, 0.1);
    clock.step(16);
    clock.step(16);

    expect(pager.state.phase).toBe('release');
    expect(pager.state.value).not.toBe(0);
    expect(pager.state.velocity).not.toBe(0);

    const before = {
      index: pager.state.index,
      value: pager.state.value,
      velocity: pager.state.velocity,
    };
    expect(clock.pending()).toBe(1);

    pager.goTo(0);

    expect(pager.state.phase).toBe('release');
    // Carousel state.index is the settled/current page, not the active target.
    // A future mutable-constraint path must therefore keep/recompute its target
    // inside the existing owner instead of treating this public field as target state.
    expect(pager.state.index).toBe(before.index);
    expect(pager.state.value).toBe(before.value);
    expect(pager.state.velocity).toBe(before.velocity);

    expect(clock.pending()).toBe(2);
    clock.step(16);
    expect(Number.isFinite(pager.state.value)).toBe(true);
    expect(Number.isFinite(pager.state.velocity)).toBe(true);

    clock.drain();
    expect(pager.state.value).toBe(0);
    expect(pager.state.velocity).toBe(0);
    expect(pager.state.index).toBe(0);
    expect(pager.state.phase).toBe('settle');
    expect(clock.pending()).toBe(0);
  });
});
