/**
 * 11-behaviors-pointer.spec.ts — матрица #102: pointer capture / cancel для
 * ./behaviors на РЕАЛЬНОМ движке (расширение 06-gestures-pointer.spec.ts).
 *
 * ./behaviors — headless state machines, питающиеся {x,y,t}; потребитель
 * транслирует PointerEvent → BehaviorPoint. Здесь связка проверяется на
 * настоящих pointer-событиях: активный pointerId (setPointerCapture реально
 * работает), реальный pointercancel (системный перехват) и реальный rAF-clock
 * (доводка к snap живёт на движке, не на инжекции).
 *
 * Детерминизм follow: value = grab + (clientY − grabPointerY) — от времени НЕ
 * зависит; t берём из монотонного счётчика. Точную инерцию числом НЕ ассертим —
 * только терминальное оседание в snap (аналитический purpose пружины).
 */

import { expect, test } from './fixtures/harness';

test('bottom sheet следует за РЕАЛЬНЫМ указателем при активном setPointerCapture', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { createBottomSheet } = await import('/dist/behaviors/index.js');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;touch-action:none;';
    document.body.appendChild(el);

    const w = window as unknown as {
      __sheet: ReturnType<typeof createBottomSheet>;
      __captured: boolean;
    };
    const sheet = createBottomSheet({ snapPoints: [0, 300, 600] });
    w.__sheet = sheet;
    w.__captured = false;
    let t = 0;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      w.__captured = el.hasPointerCapture(e.pointerId);
      sheet.pointerDown({ x: e.clientX, y: e.clientY, t: t++ });
    });
    el.addEventListener('pointermove', (e) =>
      sheet.pointerMove({ x: e.clientX, y: e.clientY, t: t++ }),
    );
  });

  await page.mouse.move(20, 20);
  await page.mouse.down();
  await page.mouse.move(20, 120);
  await page.mouse.move(20, 220);

  const r = await page.evaluate(() => {
    const w = window as unknown as {
      __sheet: { state: { value: number; phase: string } };
      __captured: boolean;
    };
    return { value: w.__sheet.state.value, phase: w.__sheet.state.phase, captured: w.__captured };
  });
  await page.mouse.up();

  expect(r.captured).toBe(true);
  expect(r.phase).toBe('follow');
  // От y=20 к y=220: смещение +200 от старта 0.
  expect(Math.abs(r.value - 200)).toBeLessThanOrEqual(0.001);
});

test('pointercancel: системный перехват → carousel детерминированно оседает на странице', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { createCarousel } = await import('/dist/behaviors/index.js');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;touch-action:none;';
    document.body.appendChild(el);

    const w = window as unknown as { __c: ReturnType<typeof createCarousel> };
    // Реальный rAF-clock: доводка живёт на движке.
    const c = createCarousel({
      pageCount: 3,
      pageSize: 200,
      requestFrame: (cb) => requestAnimationFrame(() => cb(performance.now())),
    });
    w.__c = c;
    let t = 0;
    el.addEventListener('pointerdown', (e) => c.pointerDown({ x: e.clientX, y: e.clientY, t: t++ }));
    el.addEventListener('pointermove', (e) => c.pointerMove({ x: e.clientX, y: e.clientY, t: t++ }));
    el.addEventListener('pointercancel', () => c.pointerCancel());

    const fire = (type: string, x: number): void => {
      el.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: 0, bubbles: true }));
    };
    fire('pointerdown', 300);
    fire('pointermove', 200); // немного потянули влево (LTR → вперёд)
    fire('pointercancel', 200); // системный перехват указателя
  });

  // Ждём терминального оседания на странице (index стабилен, phase settle).
  await page.waitForFunction(() => {
    const w = window as unknown as { __c: { state: { phase: string; value: number } } };
    return w.__c.state.phase === 'settle';
  });

  const r = await page.evaluate(() => {
    const w = window as unknown as { __c: { state: { index: number; value: number } } };
    return { index: w.__c.state.index, value: w.__c.state.value };
  });
  // Детерминизм: осел РОВНО на кратной pageSize позиции (целая страница).
  expect(Number.isInteger(r.index)).toBe(true);
  expect(Math.abs(r.value - r.index * 200)).toBeLessThanOrEqual(0.5);
});

test('mutable sheet/pager constraints retarget the same real-browser owner without a boundary jump', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createBottomSheet, createCarousel } = await import('/dist/behaviors/index.js');
    const frame = (cb: (ts?: number) => void): number => requestAnimationFrame((ts) => cb(ts));

    const sheet = createBottomSheet({ snapPoints: [0, 300, 600], requestFrame: frame });
    sheet.snapTo(2);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const sheetBefore = { value: sheet.state.value, velocity: sheet.state.velocity };
    sheet.update([0, 200, 400]);
    const sheetBoundary = {
      value: sheet.state.value,
      velocity: sheet.state.velocity,
      phase: sheet.state.phase,
    };

    const pager = createCarousel({ pageCount: 4, pageSize: 200, requestFrame: frame, rtl: true });
    pager.goTo(3);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const pagerBefore = { value: pager.state.value, velocity: pager.state.velocity };
    pager.update(4, 120);
    const pagerBoundary = {
      value: pager.state.value,
      velocity: pager.state.velocity,
      phase: pager.state.phase,
    };

    return { sheetBefore, sheetBoundary, pagerBefore, pagerBoundary };
  });

  expect(result.sheetBoundary.phase).toBe('release');
  expect(result.sheetBoundary.value).toBe(result.sheetBefore.value);
  expect(result.sheetBoundary.velocity).toBe(result.sheetBefore.velocity);
  expect(Math.abs(result.sheetBefore.velocity)).toBeGreaterThan(0);
  expect(result.pagerBoundary.phase).toBe('release');
  expect(result.pagerBoundary.value).toBe(result.pagerBefore.value);
  expect(result.pagerBoundary.velocity).toBe(result.pagerBefore.velocity);
  expect(Math.abs(result.pagerBefore.velocity)).toBeGreaterThan(0);
});
