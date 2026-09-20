import { expect, test } from './fixtures/harness';

/**
 * JOURNEY-01: реальный browser handoff для direct-control.
 * Release обязан жить в WAAPI без main-thread frame-loop, а новый input
 * подхватывает ту же serialized траекторию по value+velocity без layout-read.
 */
test('sheet: native release и C¹ pickup используют одного physical owner', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createCompositorBottomSheet } = await import('/dist/behaviors/compositor/index.js');
    document.body.innerHTML = '<div id="sheet" style="position:absolute;transform:translateY(0px);width:80px;height:80px"></div>';
    const element = document.querySelector<HTMLElement>('#sheet')!;
    let frameRequests = 0;
    const sheet = createCompositorBottomSheet({
      snapPoints: [0, 300, 600],
      requestFrame() {
        frameRequests++;
        throw new Error('native release scheduled a main-thread frame');
      },
      compositor: {
        target: element,
        property: 'transform',
        format: (value: number) => `translateY(${value}px)`,
        apply: (value: string | number) => { element.style.transform = String(value); },
      },
    });

    sheet.pointerDown({ x: 0, y: 0, t: 0 });
    sheet.pointerMove({ x: 0, y: 180, t: 0.05 });
    sheet.pointerUp({ x: 0, y: 180, t: 0.05 });
    const release = {
      phase: sheet.state.phase,
      velocity: sheet.state.velocity,
      nativeAnimations: element.getAnimations().length,
    };

    const stale = element.getAnimations()[0]!;
    stale.pause();
    stale.currentTime = 16;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    const renderedBeforePickup = matrix.m42;

    sheet.pointerDown({ x: 0, y: renderedBeforePickup, t: 0.1 });
    const pickup = {
      phase: sheet.state.phase,
      value: sheet.state.value,
      velocity: sheet.state.velocity,
      nativeAnimations: element.getAnimations().length,
    };

    await Promise.resolve();
    const afterStale = { phase: sheet.state.phase, value: sheet.state.value };

    // Немедленный re-release без движения пальца обязан унаследовать sampled
    // compositor velocity через тот же tracker. Public follow-state при этом
    // намеренно показывает velocity=0: prior живёт в input tracker, не во втором store.
    sheet.pointerUp({ x: 0, y: renderedBeforePickup, t: 0.1 });
    const resumed = {
      phase: sheet.state.phase,
      velocity: sheet.state.velocity,
      nativeAnimations: element.getAnimations().length,
    };
    sheet.destroy();

    return {
      frameRequests,
      release,
      renderedBeforePickup,
      pickup,
      afterStale,
      resumed,
      afterDestroyAnimations: element.getAnimations().length,
    };
  });

  expect(result.frameRequests).toBe(0);
  expect(result.release.phase).toBe('release');
  expect(result.release.velocity).not.toBe(0);
  expect(result.release.nativeAnimations).toBe(1);
  expect(result.renderedBeforePickup).not.toBe(180);
  expect(result.pickup.phase).toBe('follow');
  expect(result.pickup.nativeAnimations).toBe(0);
  expect(Math.abs(result.pickup.value - result.renderedBeforePickup)).toBeLessThanOrEqual(2);
  expect(result.pickup.velocity).toBe(0);
  expect(result.afterStale.phase).toBe('follow');
  expect(result.afterStale.value).toBe(result.pickup.value);
  expect(result.resumed.phase).toBe('release');
  expect(result.resumed.velocity).not.toBe(0);
  expect(result.resumed.nativeAnimations).toBe(1);
  expect(result.afterDestroyAnimations).toBe(0);
});
