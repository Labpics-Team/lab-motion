/**
 * 10-cleanup.spec.ts — матрица #102, пункт (10): cleanup после unmount/destroy.
 *
 * Утечка на реальном движке видна через Element.getAnimations() (нативная
 * анимация, не снятая при destroy, живёт на элементе и держит слой) и через
 * подписки MediaQueryList (слушатель после destroy продолжал бы будиться).
 * Проверяем: (а) CompositorSpring.destroy снимает нативную Animation; (б)
 * animate().stop() снимает её же; (в) createMotionConfig.destroy отписывается —
 * смена системного предпочтения ПОСЛЕ destroy не будит подписчика.
 */

import { expect, test } from './fixtures/harness';

test('CompositorSpring.destroy снимает нативную Animation с элемента', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const compositor = await import('/dist/compositor/index.js');
    const el = document.createElement('div');
    el.style.position = 'absolute';
    document.body.appendChild(el);

    const before = el.getAnimations().length;
    const cs = new compositor.CompositorSpring({
      spring: { mass: 1, stiffness: 200, damping: 20 },
      property: 'transform',
      from: 0,
      to: 100,
      target: el,
      format: (v: number) => `translateX(${v}px)`,
    });
    cs.start();
    const during = el.getAnimations().length;
    cs.destroy();
    const after = el.getAnimations().length;

    el.remove();
    return { before, during, after };
  });

  expect(r.before).toBe(0);
  expect(r.during).toBe(1); // старт создал нативную Animation
  expect(r.after).toBe(0); // destroy её снял — ноль зомби-слоёв
});

test('animate().stop() снимает нативную Animation', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div');
    el.style.position = 'absolute';
    document.body.appendChild(el);

    const controls = animate(el, { x: 150 }, { spring: { mass: 1, stiffness: 180, damping: 18 } });
    const during = el.getAnimations().length;
    controls.stop();
    await controls.finished;
    const after = el.getAnimations().length;

    el.remove();
    return { during, after };
  });

  expect(r.during).toBeGreaterThanOrEqual(1);
  expect(r.after).toBe(0);
});

test('createMotionConfig.destroy отписывает слушателя — смена reduce его не будит', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.evaluate(async () => {
    const { createMotionConfig } = await import('/dist/a11y/index.js');
    const cfg = createMotionConfig({
      reducedMotion: 'system',
      matchMedia: window.matchMedia.bind(window),
    });
    const w = window as unknown as { __cfg: typeof cfg; __changes: number };
    w.__cfg = cfg;
    w.__changes = 0;
    cfg.onChange(() => (w.__changes += 1));
    cfg.destroy(); // немедленный unmount: слушатель снят
  });

  // Смена системного предпочтения ПОСЛЕ destroy не должна будить подписчика.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const changes = await page.evaluate(
    () => (window as unknown as { __changes: number }).__changes,
  );
  expect(changes).toBe(0);
});
