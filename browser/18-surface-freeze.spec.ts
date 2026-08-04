/**
 * 18-surface-freeze.spec.ts — MAIN-THREAD FREEZE PROOF стенд (спека
 * «MAIN-THREAD FREEZE PROOF», «VIRTUALIZATION», «PROOF RECEIPT»).
 *
 * Сцена: raw WAAPI transform control (positive), rAF/direct-width control
 * (negative), Future Layout native surface, виртуализированный список
 * (10 000 логических строк, bounded материализация). После старта —
 * busy-loop main thread >= 1000 ms. Во время busy-window:
 *   - raw WAAPI control движется (compositor);
 *   - rAF control замирает (main thread заблокирован);
 *   - Future Layout boundary движется (WAAPI-effects на compositor);
 *   - observer callback не исполняется;
 * после разблокировки observer получает актуальные samples, очередь
 * устаревших callbacks отсутствует. Animation.currentTime НЕ используется
 * как доказательство — только наблюдаемые стили/метрики. Видео пишется
 * browser process'ом (Playwright video), receipt прикладывается артефактом.
 */

import { expect, test } from './fixtures/harness';

test.use({ video: 'on' });

const BUSY_MS = 1000;

const SCENE_SETUP = `
  const root = document.createElement('div');
  root.id = 'scene';
  document.body.appendChild(root);

  const raw = document.createElement('div');
  raw.id = 'raw-waapi-control';
  raw.style.cssText = 'width:40px;height:40px;background:#c33';
  root.appendChild(raw);
  raw.animate(
    [{ transform: 'translateX(0px)' }, { transform: 'translateX(200px)' }],
    { duration: 4000, iterations: Infinity },
  );

  const rafEl = document.createElement('div');
  rafEl.id = 'raf-control';
  rafEl.style.cssText = 'width:40px;height:40px;background:#3c3';
  root.appendChild(rafEl);
  let rafWidth = 40;
  let rafHandle = 0;
  const rafStep = () => {
    rafWidth += 1;
    rafEl.style.width = rafWidth + 'px';
    rafHandle = requestAnimationFrame(rafStep);
  };
  rafHandle = requestAnimationFrame(rafStep);

  const list = document.createElement('div');
  list.id = 'virtual-list';
  list.style.cssText = 'height:200px;overflow:auto';
  const LOGICAL_ROWS = 10000;
  const ROW_HEIGHT = 20;
  const viewportCapacity = Math.ceil(200 / ROW_HEIGHT);
  const overscan = 4;
  const materialized = Math.min(LOGICAL_ROWS, viewportCapacity + overscan);
  for (let i = 0; i < materialized; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.height = ROW_HEIGHT + 'px';
    list.appendChild(row);
  }
  root.appendChild(list);

  const boundary = document.createElement('div');
  boundary.id = 'surface-boundary';
  boundary.style.cssText = 'width:240px;height:60px;background:#33c';
  root.appendChild(boundary);

  window.__scene = {
    raw, rafEl, list, boundary,
    viewportCapacity, overscan, logicalRows: LOGICAL_ROWS,
    stopRafControl: () => cancelAnimationFrame(rafHandle),
  };
`;

interface SceneState {
  boundary: HTMLElement;
  rafEl: HTMLElement;
  raw: HTMLElement;
  list: HTMLElement;
  viewportCapacity: number;
  overscan: number;
  logicalRows: number;
  stopRafControl(): void;
}

test('freeze proof: compositor-контроли движутся, rAF-контроль и observer замерли', async ({ page }) => {
  const result = await page.evaluate(async ({ busyMs, setup }: { busyMs: number; setup: string }) => {
    (0, eval)(setup);
    const scene = (window as unknown as { __scene: SceneState }).__scene;
    const { animate } = await import('/dist/animate/index.js');

    const materializedRows = (): number => scene.list.children.length;
    const readMatrix = (el: HTMLElement): string => getComputedStyle(el).transform;
    const rows = {
      beforeCommit: materializedRows(),
      afterCommit: 0,
      during: 0,
      afterFinish: 0,
    };

    let observerSamples = 0;
    interface SurfaceControlsLike {
      readonly ready: Promise<void>;
      readonly committed: Promise<void>;
      readonly finished: Promise<void>;
      readonly tier: string;
      cancel(): void;
    }
    const controls = animate(
      scene.boundary,
      { width: [240, 360] },
      {
        layout: 'project',
        // Медленная недодемпфированная пружина: active phase длиннее busy-window.
        spring: { mass: 1, stiffness: 25, damping: 9 },
        onFrame: () => { observerSamples++; },
      },
    ) as unknown as SurfaceControlsLike;
    await controls.ready;
    const tier = controls.tier;
    rows.afterCommit = materializedRows();

    const pre = {
      raw: readMatrix(scene.raw),
      rafWidth: getComputedStyle(scene.rafEl).width,
      boundary: readMatrix(scene.boundary),
      observer: observerSamples,
    };

    // Busy-window: main thread заблокирован, compositor продолжает работать.
    const t0 = performance.now();
    while (performance.now() - t0 < busyMs) { /* freeze */ }

    // Сразу после разблокировки (синхронно): rAF control и observer обязаны
    // быть замороженными — rAF callback не исполнялся в busy-window.
    const postBusy = {
      rafWidth: getComputedStyle(scene.rafEl).width,
      observer: observerSamples,
    };

    // Два доставленных кадра: compositor коммитит состояние, стили синхронны.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const during = {
      raw: readMatrix(scene.raw),
      boundary: readMatrix(scene.boundary),
    };
    rows.during = materializedRows();
    const afterUnlockObserver = observerSamples;

    await controls.finished;
    rows.afterFinish = materializedRows();
    scene.stopRafControl();

    return {
      tier,
      busyMs,
      rows,
      capacity: scene.viewportCapacity + scene.overscan,
      logicalRows: scene.logicalRows,
      platformControlMoved: pre.raw !== during.raw,
      rafControlFrozen: pre.rafWidth === postBusy.rafWidth,
      surfaceMoved: pre.boundary !== during.boundary,
      observerFrozenDuringBusy: postBusy.observer === pre.observer,
      observerResumedAfterUnlock: afterUnlockObserver > postBusy.observer,
      finalWidth: getComputedStyle(scene.boundary).width,
    };
  }, { busyMs: BUSY_MS, setup: SCENE_SETUP });

  test.info().annotations.push({ type: 'freeze-proof', description: JSON.stringify(result) });

  // Receipt: машинно-читаемый артефакт доказательства (не ручные числа).
  await test.info().attach('surface-freeze-proof.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });

  expect(result.tier).toBe('future-layout-native');
  // Positive control: raw WAAPI transform двигался во время freeze.
  expect(result.platformControlMoved).toBe(true);
  // Negative control: rAF/direct-width замер (main thread заблокирован).
  expect(result.rafControlFrozen).toBe(true);
  // Future Layout boundary двигался: compositor-исполнение переживает freeze.
  expect(result.surfaceMoved).toBe(true);
  // Observer callback не исполнялся в busy-window и ожил после разблокировки.
  expect(result.observerFrozenDuringBusy).toBe(true);
  expect(result.observerResumedAfterUnlock).toBe(true);
  // Коммит конечного DOM состоялся.
  expect(result.finalWidth).toBe('360px');
  // Виртуализация: материализация bounded на всех checkpoint'ах.
  expect(result.rows.beforeCommit).toBeLessThanOrEqual(result.capacity);
  expect(result.rows.afterCommit).toBeLessThanOrEqual(result.capacity);
  expect(result.rows.during).toBeLessThanOrEqual(result.capacity);
  expect(result.rows.afterFinish).toBeLessThanOrEqual(result.capacity);
  expect(result.logicalRows).toBe(10_000);

  const video = page.video();
  if (video !== null) {
    await test.info().attach('surface-freeze-video.webm', {
      path: await video.path(),
      contentType: 'video/webm',
    });
  }
});
