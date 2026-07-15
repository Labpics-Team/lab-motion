/**
 * 09-ssr-hydration.spec.ts — матрица #102, пункт (9): SSR import → hydration /
 * client start.
 *
 * Сценарий: разметка «отрендерена сервером» УЖЕ в DOM; клиент импортирует субпуть
 * (import сам по себе SSR-safe — ноль правок DOM) и запускает движение на
 * СУЩЕСТВУЮЩЕМ узле, резолвя селектор в момент вызова (document.querySelectorAll).
 * Проверяем на реальном движке: (а) import не трогает server-разметку; (б)
 * animate по селектору попадает в тот же узел (идентичность, не пересоздание);
 * (в) клиентский старт рождает НАСТОЯЩУЮ анимацию на узле (getAnimations).
 */

import { expect, test } from './fixtures/harness';

test('SSR-разметка переживает import; client animate стартует на существующем узле', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    // «Сервер» отрендерил статический узел с инлайновым стилем.
    document.body.innerHTML =
      '<section id="app"><div id="ssr-node" style="opacity:1"></div></section>';
    const bodyBeforeImport = document.body.innerHTML;
    const ssrNode = document.getElementById('ssr-node');

    // Клиентский import — после того как разметка уже в DOM (порядок hydration).
    const { animate } = await import('/dist/animate/index.js');
    const bodyAfterImport = document.body.innerHTML; // import не должен ничего менять

    // Гидрация: старт по СЕЛЕКТОРУ (резолв в момент вызова).
    const controls = animate('#ssr-node', { opacity: 0.2 }, {
      spring: { mass: 1, stiffness: 200, damping: 22 },
    });

    const resolvedSame = document.getElementById('ssr-node') === ssrNode;
    // Физический старт юнита — один queueMicrotask на вызов (lazy-commit R3b).
    await Promise.resolve();
    const anims = ssrNode!.getAnimations().length; // клиент реально запустил анимацию
    const hasControls = typeof controls.finished?.then === 'function';

    // Прибираем за собой (без ассертов по времени).
    controls.stop();
    return {
      importMutatedDom: bodyAfterImport !== bodyBeforeImport,
      resolvedSame,
      anims,
      hasControls,
    };
  });

  expect(r.importMutatedDom).toBe(false); // SSR-safe import: ноль правок DOM
  expect(r.resolvedSame).toBe(true); // тот же узел, не пересоздан
  expect(r.hasControls).toBe(true);
  expect(r.anims).toBeGreaterThanOrEqual(1); // hydration → живая анимация на узле
});
