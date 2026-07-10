/**
 * 06-gestures-pointer.spec.ts — матрица #102, пункт (6): pointer capture / cancel
 * для жестов.
 *
 * ./gestures — headless-машины состояний, питающиеся {x,y,t}; потребитель
 * транслирует PointerEvent → GesturePoint. Здесь эта связка проверяется на
 * РЕАЛЬНЫХ pointer-событиях движка: настоящий page.mouse даёт активный pointerId,
 * на котором setPointerCapture реально работает (синтетика бросила бы NotFoundError).
 * pointercancel-путь (перехват указателя системой) — через реальное событие,
 * поданное в те же listener'ы: контроллер обязан осесть в клампнутую точку.
 *
 * Детерминизм: позиция drag = grabRaw + (clientX − grabPointerX) — от времени НЕ
 * зависит; t жеста берём из монотонного счётчика (не из стены). Скорость/инерцию
 * точным числом НЕ ассертим (это была бы wall-clock-ассерта).
 */

import { expect, test } from './fixtures/harness';

test('drag следует за РЕАЛЬНЫМ указателем при активном setPointerCapture', async ({ page }) => {
  // Площадка на весь вьюпорт: клиентские координаты = координаты внутри элемента.
  await page.evaluate(async () => {
    const { createDrag } = await import('/dist/gestures/index.js');
    const el = document.createElement('div');
    el.id = 'pad';
    el.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;touch-action:none;';
    document.body.appendChild(el);

    const w = window as unknown as {
      __drag: ReturnType<typeof createDrag>;
      __captured: boolean;
      __hadCapture: boolean;
    };
    const drag = createDrag({ inertia: false });
    w.__drag = drag;
    w.__captured = false;
    w.__hadCapture = false;
    let t = 0;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      w.__captured = el.hasPointerCapture(e.pointerId);
      drag.pointerDown({ x: e.clientX, y: e.clientY, t: t++ });
    });
    el.addEventListener('pointermove', (e) => {
      if (el.hasPointerCapture(e.pointerId)) w.__hadCapture = true;
      drag.pointerMove({ x: e.clientX, y: e.clientY, t: t++ });
    });
    el.addEventListener('pointerup', (e) => {
      drag.pointerUp({ x: e.clientX, y: e.clientY, t: t++ });
    });
  });

  // Реальные pointer-события от движка (активный pointerId → setPointerCapture ок).
  await page.mouse.move(10, 10);
  await page.mouse.down();
  await page.mouse.move(60, 40);
  await page.mouse.move(90, 70);

  const mid = await page.evaluate(() => {
    const w = window as unknown as {
      __drag: { x: number; y: number; dragging: boolean };
      __captured: boolean;
      __hadCapture: boolean;
    };
    return { x: w.__drag.x, y: w.__drag.y, dragging: w.__drag.dragging, captured: w.__captured, hadCapture: w.__hadCapture };
  });

  await page.mouse.up();

  expect(mid.captured).toBe(true); // capture реально установлен на активном указателе
  expect(mid.hadCapture).toBe(true); // события шли через захваченный элемент
  expect(mid.dragging).toBe(true);
  // От (10,10) к (90,70): смещение (80,60) от старта 0.
  expect(Math.abs(mid.x - 80)).toBeLessThanOrEqual(0.001);
  expect(Math.abs(mid.y - 60)).toBeLessThanOrEqual(0.001);
});

test('pointercancel: перехват указателя → drag оседает в клампнутую точку, onRest', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { createDrag } = await import('/dist/gestures/index.js');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;touch-action:none;';
    document.body.appendChild(el);

    let restAt: { x: number; y: number } | null = null;
    const drag = createDrag({
      bounds: { x: { min: 0, max: 100 } },
      rubberBand: 0.5,
      inertia: false,
      onRest: (x, y) => (restAt = { x, y }),
    });
    let t = 0;
    el.addEventListener('pointerdown', (e) =>
      drag.pointerDown({ x: e.clientX, y: e.clientY, t: t++ }),
    );
    el.addEventListener('pointermove', (e) =>
      drag.pointerMove({ x: e.clientX, y: e.clientY, t: t++ }),
    );
    el.addEventListener('pointercancel', () => drag.pointerCancel());

    const fire = (type: string, x: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: 0, bubbles: true }));

    fire('pointerdown', 0);
    fire('pointermove', 150); // тянем ЗА границу (max=100) → rubber-band за 100
    const duringDrag = drag.x;

    // Реальное событие перехвата указателя (скролл/системный жест забрал pointer).
    fire('pointercancel', 150);
    const afterCancel = drag.x;

    el.remove();
    return { duringDrag, afterCancel, restAt, dragging: drag.dragging };
  });

  // Под пальцем за границей — rubber-band выводит дальше max.
  expect(r.duringDrag).toBeGreaterThan(100);
  // После перехвата — жёсткий клэмп на границу и оседание.
  expect(Math.abs(r.afterCancel - 100)).toBeLessThanOrEqual(0.001);
  expect(r.restAt).not.toBeNull();
  expect(Math.abs((r.restAt as unknown as { x: number }).x - 100)).toBeLessThanOrEqual(0.001);
  expect(r.dragging).toBe(false);
});
