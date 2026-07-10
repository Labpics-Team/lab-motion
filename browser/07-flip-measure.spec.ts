/**
 * 07-flip-measure.spec.ts — матрица #102, пункт (7): layout/FLIP-замер БЕЗ
 * layout-thrash.
 *
 * FLIP-граница ./projection: getBoundingClientRect возвращает бокс ПОСЛЕ
 * transform, поэтому замер обязан идти одним батчем (clear-записи → measure-чтения),
 * иначе — многократный принудительный reflow (thrash). Проверяем на реальном
 * движке: (а) элемент, уехавший в layout, после play визуально ОСТАЁТСЯ на первом
 * месте (FLIP-инвариант, «нет прыжка»); (б) во время play getBoundingClientRect
 * элемента вызывается РОВНО один раз (единственный reflow, батч не разорван);
 * (в) transform-origin выставлен в '0 0' (контракт формул).
 *
 * Детерминизм: инжектируемый requestFrame замораживает полёт на кадре 0 (первый
 * кадр — синхронный), замер визуальной позиции — на нём. Стену времени не трогаем.
 */

import { expect, test } from './fixtures/harness';

test('FLIP: уехавший в layout элемент визуально не прыгает; замер — один reflow', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { createDomProjection } = await import('/dist/projection/index.js');
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:0px;top:0px;width:100px;height:50px;background:#ccc;';
    document.body.appendChild(el);

    const scheduled: ((ts?: number) => void)[] = [];
    const proj = createDomProjection({
      radius: false, // изолируем gBCR-батч (радиусы читают getComputedStyle отдельно)
      requestFrame: (cb: (ts?: number) => void): number => {
        scheduled.push(cb);
        return 1; // ненулевой handle → без setTimeout, полёт заморожен на кадре 0
      },
    });

    const firstX = el.getBoundingClientRect().x;

    proj.capture([el]);

    // Потребитель меняет layout.
    el.style.left = '200px';
    const shiftedX = el.getBoundingClientRect().x;

    // Считаем принудительные reflow (gBCR) ровно во время play.
    let gbcrCalls = 0;
    const nativeGBCR = el.getBoundingClientRect.bind(el);
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => {
      gbcrCalls++;
      return nativeGBCR();
    };

    proj.play();

    // Вернуть нативный метод для честного визуального замера.
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = nativeGBCR;

    const originAfter = el.style.transformOrigin;
    const frame0Transform = el.style.transform;
    const visualFrame0X = el.getBoundingClientRect().x; // FLIP: ≈ firstX

    // Догоняем полёт до оседания: сливаем кадры с большим шагом времени.
    let ts = 0;
    let guard = 0;
    while (scheduled.length > 0 && guard++ < 5000) {
      const cb = scheduled.shift()!;
      ts += 500;
      cb(ts);
    }
    const finalTransform = el.style.transform; // restore после onRest
    const visualFinalX = el.getBoundingClientRect().x;

    el.remove();
    return {
      firstX,
      shiftedX,
      gbcrCalls,
      originAfter,
      frame0Transform,
      visualFrame0X,
      finalTransform,
      visualFinalX,
    };
  });

  // Элемент реально уехал в layout.
  expect(Math.abs(r.shiftedX - r.firstX - 200)).toBeLessThanOrEqual(0.5);
  // (б) единственный принудительный reflow за play — батч не разорван (нет thrash).
  expect(r.gbcrCalls).toBe(1);
  // (в) контракт формул: origin в верхнем-левом углу (движок нормализует
  // инлайн-геттер '0 0' → '0px 0px' — принимаем обе формы).
  expect(r.originAfter).toMatch(/^0(px)? 0(px)?$/);
  // (а) FLIP держит элемент визуально на первом месте (нет прыжка на кадре 0).
  expect(r.frame0Transform).toMatch(/translate/);
  expect(Math.abs(r.visualFrame0X - r.firstX)).toBeLessThanOrEqual(1);
  // По оседании — снап в новый layout, наши инлайны сняты.
  expect(r.finalTransform).toBe('');
  expect(Math.abs(r.visualFinalX - r.shiftedX)).toBeLessThanOrEqual(1);
});
