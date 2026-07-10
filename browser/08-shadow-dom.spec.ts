/**
 * 08-shadow-dom.spec.ts — матрица #102, пункт (8): composed-обход Shadow DOM.
 *
 * ./projection ищет ближайшего проецирующего предка composed-подъёмом
 * (assignedSlot → parentElement → getRootNode().host) — границы ОТКРЫТЫХ shadow
 * root прозрачны. Проверяем на реальном движке: элемент внутри open shadow root,
 * чей проецирующий предок — host СНАРУЖИ теневого корня, при сдвиге host в layout
 * визуально ОСТАЁТСЯ на месте (transform родителя не искажает ребёнка). Если бы
 * подъём не пересёк теневую границу, ребёнок посчитался бы корнем и получил
 * двойной сдвиг — тест это ловит числом.
 *
 * Детерминизм: инжектируемый requestFrame морозит полёт на кадре 0.
 */

import { expect, test } from './fixtures/harness';

test('composed traversal: ребёнок в open shadow не искажается transform-ом host', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { createDomProjection } = await import('/dist/projection/index.js');

    // host снаружи, ребёнок — внутри его ОТКРЫТОГО shadow root.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0px;top:0px;width:120px;height:120px;';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.style.cssText = 'position:absolute;left:10px;top:10px;width:30px;height:30px;';
    root.appendChild(inner);

    const scheduled: ((ts?: number) => void)[] = [];
    const proj = createDomProjection({
      radius: false,
      requestFrame: (cb: (ts?: number) => void): number => {
        scheduled.push(cb);
        return 1;
      },
    });

    const innerFirstX = inner.getBoundingClientRect().x; // page-space до сдвига

    // Захватываем host и ребёнка (ребёнок — проецирующий потомок host).
    proj.capture([host, inner]);

    // Сдвигаем ТОЛЬКО host в layout: ребёнок как статический потомок едет с ним.
    host.style.left = '200px';
    const innerShiftedX = inner.getBoundingClientRect().x; // уехал вместе с host (≈ +200)

    proj.play();

    const hostTransform = host.style.transform;
    const innerTransform = inner.style.transform;
    const innerVisualX = inner.getBoundingClientRect().x; // должен ≈ innerFirstX

    // Слить полёт.
    let ts = 0;
    let guard = 0;
    while (scheduled.length > 0 && guard++ < 5000) {
      const cb = scheduled.shift()!;
      ts += 500;
      cb(ts);
    }

    host.remove();
    return { innerFirstX, innerShiftedX, hostTransform, innerTransform, innerVisualX };
  });

  // Ребёнок реально уехал в layout вместе с host.
  expect(Math.abs(r.innerShiftedX - r.innerFirstX - 200)).toBeLessThanOrEqual(1);
  // host получил FLIP-инверсию.
  expect(r.hostTransform).toMatch(/translate/);
  // Ключевое: ребёнок визуально ОСТАЛСЯ на первом месте — подъём пересёк теневую
  // границу и нашёл host предком (иначе был бы двойной сдвиг ≈ -190).
  expect(Math.abs(r.innerVisualX - r.innerFirstX)).toBeLessThanOrEqual(1.5);
});
