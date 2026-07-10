/**
 * 05-reduced-motion.spec.ts — матрица #102, пункт (5): prefers-reduced-motion +
 * СМЕНА предпочтения во время жизненного цикла.
 *
 * Реальный движок через page.emulateMedia меняет вердикт window.matchMedia — тут
 * это НЕ мок, а настоящий media-эмулятор. Проверяем: (а) при reduce ./animate
 * даёт мгновенный снап к цели (единая снап-политика пакета, tier 'reduced');
 * (б) createMotionConfig ловит СМЕНУ системного предпочтения в полёте через
 * реальное событие 'change' MediaQueryList (не опрос, не тайминг).
 */

import { expect, test } from './fixtures/harness';

test('reduce: animate снапает к финалу мгновенно (tier reduced), onComplete зовётся', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const r = await page.evaluate(async () => {
    const compositor = await import('/dist/compositor/index.js');
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div');
    el.style.position = 'absolute';
    document.body.appendChild(el);

    const tier = compositor.resolveCompositorTier({
      target: el,
      matchMedia: window.matchMedia.bind(window),
    });

    let completed = false;
    const controls = animate(el, { x: 200 }, { onComplete: () => (completed = true) });
    // Снап синхронен: значение уже финальное сразу после вызова, без кадров.
    const immediateTransform = el.style.transform;
    await controls.finished;

    el.remove();
    return { tier, immediateTransform, completed };
  });

  expect(r.tier).toBe('reduced');
  expect(r.immediateTransform).toContain('translateX(200px)');
  expect(r.completed).toBe(true);
});

test('смена предпочтения в полёте: createMotionConfig ловит реальное change-событие', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Детерминизм БЕЗ гонки: подписчик выставляет промис, резолвящийся ИМЕННО на
  // событии change; тест ждёт доставку события, а не «читает сразу после
  // emulateMedia» (это была бы гонка — emulateMedia резолвится до флеша change).
  const initial = await page.evaluate(async () => {
    const { createMotionConfig } = await import('/dist/a11y/index.js');
    const cfg = createMotionConfig({
      reducedMotion: 'system',
      matchMedia: window.matchMedia.bind(window),
    });
    const w = window as unknown as {
      __cfg: typeof cfg;
      __changes: boolean[];
      __arm: () => void;
      __wait: Promise<boolean>;
    };
    w.__cfg = cfg;
    w.__changes = [];
    let resolveNext: ((v: boolean) => void) | null = null;
    cfg.onChange((v) => {
      w.__changes.push(v);
      const r = resolveNext;
      resolveNext = null;
      r?.(v);
    });
    // Арм ДО того как Node вызовет emulateMedia — событие не проскочит мимо.
    w.__arm = () => {
      w.__wait = new Promise<boolean>((res) => {
        resolveNext = res;
      });
    };
    w.__arm();
    return { pref: cfg.prefersReduced() };
  });
  expect(initial.pref).toBe(false);

  // Реальная смена системного предпочтения (эмулятор шлёт change во все MQL).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const afterReduce = await page.evaluate(async () => {
    const w = window as unknown as {
      __cfg: { prefersReduced(): boolean };
      __changes: boolean[];
      __arm: () => void;
      __wait: Promise<boolean>;
    };
    await w.__wait; // резолвится на доставке change — без sleep, без гонки
    w.__arm(); // перевзвести до следующего emulateMedia (restore)
    return { pref: w.__cfg.prefersReduced(), changes: [...w.__changes] };
  });
  expect(afterReduce.pref).toBe(true);
  expect(afterReduce.changes).toContain(true);

  // И обратно — эффект возвращается, подписчик уведомлён снова.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const afterRestore = await page.evaluate(async () => {
    const w = window as unknown as {
      __cfg: { prefersReduced(): boolean; destroy(): void };
      __changes: boolean[];
      __wait: Promise<boolean>;
    };
    await w.__wait;
    const changes = [...w.__changes];
    const pref = w.__cfg.prefersReduced();
    w.__cfg.destroy(); // cleanup: снять системного слушателя (анти-утечка)
    return { pref, changes };
  });
  expect(afterRestore.pref).toBe(false);
  expect(afterRestore.changes[afterRestore.changes.length - 1]).toBe(false);
});
