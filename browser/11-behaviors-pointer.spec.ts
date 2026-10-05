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
 * Отдельный сценарий в конце задаёт виртуальные кадры и проверяет аналитический
 * срок завершения прерванного release. Он не измеряет реальную частоту экрана.
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

test('bottom sheet завершает прерванный release к независимому сроку без оставшихся кадров', async ({ page }) => {
  const frameStepMs = 16;
  const interruptAtMs = 700;
  const target = 300;
  const minReturnFrom = 490;
  const maxReturnVelocity = 1000;

  // Сцена #444, но без копии solver/settleTimeUpperBound. Для m=1,k=170,c=26
  // отклонение z удовлетворяет z'' + 26z' + 170z = 0 (корни -13 ± i).
  // Первый release: x(t)=600-exp(-13t)(340cos(t)+3420sin(t)),
  // v(t)=exp(-13t)(1000cos(t)+44800sin(t)). При t=0.164 s получаем
  // 490 < x < 600 и 0 < v < 1000; эти предпосылки ниже проверяются на consumer.
  // После retarget в 300: u=v/(x-300) <= 1000/190. Огибающие |z|/|z(0)|
  // и |z'|/|z(0)| ограничены exp(-13t) * hypot(1,13+u) и
  // exp(-13t) * hypot(u,170+13u). Допуски: 0.005 и 0.005/s соответственно.
  const maxNormalizedVelocity = maxReturnVelocity / (minReturnFrom - target);
  const positionBoundSec = Math.log(Math.hypot(1, 13 + maxNormalizedVelocity) / 0.005) / 13;
  const velocityBoundSec = Math.log(Math.hypot(maxNormalizedVelocity, 170 + 13 * maxNormalizedVelocity) / 0.005) / 13;
  const settleBoundMs = Math.max(positionBoundSec, velocityBoundSec) * 1000;
  // Первый callback может только закрепить timestamp. Затем нужен кадр строго
  // за границей огибающей: runtime использует строгое сравнение с порогом.
  const terminalAtMs = interruptAtMs + frameStepMs
    + (Math.floor(settleBoundMs / frameStepMs) + 1) * frameStepMs;
  expect(terminalAtMs).toBe(1548);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = await page.evaluate(async ({ frameStepMs, interruptAtMs, terminalAtMs }) => {
    const { createBottomSheet } = await import('/dist/behaviors/index.js');
    let now = 520;
    let handle = 0;
    let queue: Array<(timestamp?: number) => void> = [];
    const advanceTo = (deadline: number): void => {
      while (now < deadline) {
        now = Math.min(deadline, now + frameStepMs);
        const batch = queue;
        queue = [];
        for (const callback of batch) callback(now);
      }
    };
    const sheet = createBottomSheet({
      snapPoints: [0, 300, 600],
      spring: { mass: 1, stiffness: 170, damping: 26 },
      requestFrame: (callback) => {
        queue.push(callback);
        return ++handle;
      },
    });
    try {
      sheet.pointerDown({ x: 0, y: 0, t: 0 });
      sheet.pointerMove({ x: 0, y: 80, t: 0.16 });
      sheet.pointerMove({ x: 0, y: 180, t: 0.32 });
      sheet.pointerMove({ x: 0, y: 260, t: 0.48 });
      sheet.pointerUp({ x: 0, y: 300, t: 0.52 });
      const release = { ...sheet.state };
      advanceTo(520 + frameStepMs);
      const movementBefore = { ...sheet.state };
      advanceTo(520 + frameStepMs * 2);
      const movementAfter = { ...sheet.state };
      advanceTo(interruptAtMs);
      const beforeInterrupt = { ...sheet.state };
      sheet.snapTo(1);
      const afterInterrupt = { ...sheet.state };
      advanceTo(interruptAtMs + frameStepMs);
      const replacementStart = { ...sheet.state };
      advanceTo(terminalAtMs);
      return {
        release,
        movementBefore,
        movementAfter,
        beforeInterrupt,
        afterInterrupt,
        replacementStart,
        terminal: { state: { ...sheet.state }, pending: queue.length, atMs: now },
      };
    } finally {
      // Состояние и очередь сняты до cleanup; после deadline кадры не исполняются.
      sheet.destroy();
    }
  }, { frameStepMs, interruptAtMs, terminalAtMs });

  expect(result.release).toMatchObject({ phase: 'release', value: 260, snapIndex: 2 });
  expect(result.movementBefore.velocity).toBeCloseTo(1000, 9);
  expect(result.movementAfter.value).toBeGreaterThan(result.movementBefore.value);
  expect(result.beforeInterrupt.phase).toBe('release');
  expect(result.beforeInterrupt.value).toBeGreaterThanOrEqual(minReturnFrom);
  expect(result.beforeInterrupt.value).toBeLessThan(600);
  expect(result.beforeInterrupt.velocity).toBeGreaterThan(0);
  expect(result.beforeInterrupt.velocity).toBeLessThanOrEqual(maxReturnVelocity);
  expect(result.afterInterrupt).toMatchObject({
    phase: 'release',
    value: result.beforeInterrupt.value,
    velocity: result.beforeInterrupt.velocity,
    snapIndex: 1,
  });
  // Проверяем скорость уже нового callback, а не только сохранённый public state.
  expect(result.replacementStart).toMatchObject({
    phase: 'release', value: result.afterInterrupt.value, snapIndex: 1,
  });
  // Нормирование скорости и обратное умножение на range допускают округление.
  expect(Math.abs(result.replacementStart.velocity - result.afterInterrupt.velocity))
    .toBeLessThanOrEqual(4 * Number.EPSILON * Math.abs(result.afterInterrupt.velocity));
  expect(result.terminal).toEqual({
    state: { phase: 'settle', value: target, velocity: 0, snapIndex: 1 },
    pending: 0,
    atMs: terminalAtMs,
  });
});
