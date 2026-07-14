import { expect, test } from './fixtures/harness';

// Реальный композитор обязан удалить вытесненный эффект, а не только скрыть устаревший финал.

test('natural finish нового owner не раскрывает старый live-effect', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { springTo } = await import('/dist/animate/native/index.js');
    const el = document.createElement('div');
    document.body.appendChild(el);

    const older = springTo(
      el,
      { x: [0, 100] },
      { spring: { mass: 1, stiffness: 50, damping: 1 } },
    );
    const olderEffect = el.getAnimations()[0]!;
    olderEffect.pause();
    olderEffect.currentTime = 100;

    const newer = springTo(el, { x: [0, 200] });
    const newerEffect = el.getAnimations().find((effect) => effect !== olderEffect)!;
    newerEffect.finish();
    await newer.finished;

    const computed = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    const inline = el.style.transform;
    const effectsAfterNewer = el.getAnimations().length;
    older.cancel();
    el.remove();
    return { computed, inline, effectsAfterNewer };
  });

  console.info('AUDIT natural takeover', result);
  expect(result.inline).toBe('translateX(200px)');
  expect(result.computed).toBeCloseTo(200, 3);
  expect(result.effectsAfterNewer).toBe(0);
});

test('reduced takeover немедленно прекращает старое движение', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { springTo } = await import('/dist/animate/native/index.js');
    const el = document.createElement('div');
    document.body.appendChild(el);

    const older = springTo(
      el,
      { x: [0, 100] },
      { spring: { mass: 1, stiffness: 50, damping: 1 } },
    );
    const olderEffect = el.getAnimations()[0]!;
    olderEffect.pause();
    olderEffect.currentTime = 100;

    await springTo(el, { x: [0, 200] }, { reducedMotion: true }).finished;
    const computed = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    const inline = el.style.transform;
    const activeEffects = el.getAnimations().length;
    older.cancel();
    el.remove();
    return { computed, inline, activeEffects };
  });

  console.info('AUDIT reduced takeover', result);
  expect(result.inline).toBe('translateX(200px)');
  expect(result.computed).toBeCloseTo(200, 3);
  expect(result.activeEffects).toBe(0);
});

test('multi-element pending sibling не удерживает stale-effect вытесненной цели', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { springTo } = await import('/dist/animate/native/index.js');
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);

    const older = springTo(
      [a, b],
      { x: [0, 100] },
      { spring: { mass: 1, stiffness: 50, damping: 1 } },
    );
    const oldA = a.getAnimations()[0]!;
    oldA.finish();
    // b остаётся pending, поэтому aggregate older ещё не материализуется.

    const newer = springTo(a, { x: [0, 200] });
    const newA = a.getAnimations().find((effect) => effect !== oldA)!;
    newA.finish();
    await newer.finished;

    const computed = new DOMMatrixReadOnly(getComputedStyle(a).transform).m41;
    const inline = a.style.transform;
    const effectsOnA = a.getAnimations().length;
    older.cancel();
    a.remove();
    b.remove();
    return { computed, inline, effectsOnA };
  });

  console.info('AUDIT multi-element takeover', result);
  expect(result.inline).toBe('translateX(200px)');
  expect(result.computed).toBeCloseTo(200, 3);
  expect(result.effectsOnA).toBe(0);
});

test('частичный transform takeover сохраняет независимый opacity lane', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { springTo } = await import('/dist/animate/native/index.js');
    const element = document.createElement('div');
    document.body.appendChild(element);

    const older = springTo(
      element,
      { x: [0, 100], opacity: [0, 1] },
      { spring: { mass: 1, stiffness: 50, damping: 1 } },
    );
    const oldEffects = element.getAnimations();
    for (const effect of oldEffects) {
      effect.pause();
      effect.currentTime = 100;
    }
    const opacityBefore = Number(getComputedStyle(element).opacity);

    const newer = springTo(element, { x: [0, 200] });
    const newEffects = element.getAnimations().filter((effect) => !oldEffects.includes(effect));
    for (const effect of newEffects) effect.finish();
    await newer.finished;

    const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
    const opacityAfter = Number(getComputedStyle(element).opacity);
    const liveEffects = element.getAnimations().length;
    older.cancel();
    element.remove();
    return {
      initialEffects: oldEffects.length,
      opacityBefore,
      transform,
      opacityAfter,
      liveEffects,
    };
  });

  console.info('AUDIT independent lanes', result);
  expect.soft(result.initialEffects).toBe(2);
  expect.soft(result.opacityBefore).toBeGreaterThan(0);
  expect.soft(result.transform).toBeCloseTo(200, 3);
  expect.soft(result.opacityAfter).toBeCloseTo(result.opacityBefore, 3);
  expect.soft(result.liveEffects).toBe(1);
});

test('завершённая цель материализуется при вечном соседнем effect', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { springTo } = await import('/dist/animate/native/index.js');
    const completed = document.createElement('div');
    const pending = document.createElement('div');
    document.body.append(completed, pending);

    const controls = springTo([completed, pending], { x: [0, 100] });
    const completedEffect = completed.getAnimations()[0]!;
    completedEffect.finish();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const inline = completed.style.transform;
    const computed = new DOMMatrixReadOnly(getComputedStyle(completed).transform).m41;
    const completedEffects = completed.getAnimations().length;
    const pendingEffects = pending.getAnimations().length;
    controls.cancel();
    completed.remove();
    pending.remove();
    return { inline, computed, completedEffects, pendingEffects };
  });

  expect(result.inline).toBe('translateX(100px)');
  expect(result.computed).toBeCloseTo(100, 3);
  expect(result.completedEffects).toBe(0);
  expect(result.pendingEffects).toBe(1);
});

test('host commit после reduced reentry восстанавливается текущим owner', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { springTo } = await import('/dist/animate/native/index.js');
    const element = document.createElement('div');
    document.body.appendChild(element);
    const prototype = Object.getPrototypeOf(element.style) as CSSStyleDeclaration;
    const original = prototype.setProperty;
    let armed = true;
    prototype.setProperty = function (
      this: CSSStyleDeclaration,
      name: string,
      value: string | null,
      priority?: string,
    ): void {
      if (this === element.style && armed && name === 'transform') {
        armed = false;
        springTo(element, { x: [0, 200] }, { reducedMotion: true });
      }
      original.call(this, name, value, priority);
    };

    try {
      const older = springTo(element, { x: [0, 100] });
      element.getAnimations()[0]!.finish();
      await older.finished;
      const inline = element.style.transform;
      const computed = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
      const effects = element.getAnimations().length;
      return { inline, computed, effects };
    } finally {
      prototype.setProperty = original;
      element.remove();
    }
  });

  expect(result.inline).toBe('translateX(200px)');
  expect(result.computed).toBeCloseTo(200, 3);
  expect(result.effects).toBe(0);
});
