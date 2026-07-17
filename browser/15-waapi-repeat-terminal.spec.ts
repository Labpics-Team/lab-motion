/**
 * Реальные hosts по-разному квантуют terminal phase finite repeatDelay.
 * Pure WAAPI compiler обязан отвергнуть оба воспроизводимых класса до того,
 * как неверный KeyframeEffect попадёт в Chromium/Firefox/WebKit.
 */

import { expect, test } from './fixtures/harness';

test('finite repeatDelay fail-closed для обоих host rounding артефактов', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const { compileWaapi } = await import('/dist/waapi/index.js');
    const cases = [
      [8.3e-7, 2_147_483_647, 0.99999917],
      [0.00006907150968459744, 1_055_663_962, 0.30355795758042775],
    ] as const;
    return cases.map(([duration, repeat, repeatDelay]) => {
      try {
        compileWaapi({ property: 'opacity', values: [0, 1], duration, repeat, repeatDelay });
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
  });

  expect(errors).toEqual(['LM161', 'LM161']);
});

test('infinite hold не схлопывает разные authored offsets в native effect', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { compileWaapi } = await import('/dist/waapi/index.js');
    let formatCalls = 0;
    try {
      compileWaapi({
        property: 'opacity',
        values: [0, 1, 2, 3],
        times: [0, 0.7974094492383301, 0.7974094492383302, 1],
        duration: 0.1,
        repeat: Infinity,
        repeatDelay: 1,
        format(value) {
          formatCalls++;
          return value;
        },
      });
      return { error: '', formatCalls };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        formatCalls,
      };
    }
  });

  expect(result).toEqual({ error: 'LM162', formatCalls: 0 });
});
