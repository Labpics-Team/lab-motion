/**
 * 02-tiers-linear.spec.ts — матрица #102, пункты (2) tier-детекция и
 * (3) CSS linear() feature-detection.
 *
 * Сверяем ВНУТРЕННЮЮ детекцию пакета (supportsWaapi / supportsLinearEasing /
 * resolveCompositorTier) с ПРЯМЫМ вердиктом реального движка (Element.prototype.
 * animate, CSS.supports). Расхождение здесь = движок деградирует не туда, куда
 * думает библиотека, — молчаливый неверный tier. Плюс: WAAPI-tier vs fallback-tier
 * выбираются на РЕАЛЬНОЙ и на нарочно-недееспособной цели.
 */

import { expect, test } from './fixtures/harness';

test('supportsWaapi совпадает с наличием Element.prototype.animate', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { supportsWaapi } = await import('/dist/waapi/index.js');
    const native = typeof Element.prototype.animate === 'function';
    const el = document.createElement('div');
    return {
      env: supportsWaapi(),
      native,
      onReal: supportsWaapi(el),
      onDucklessNull: supportsWaapi(null),
      onPlain: supportsWaapi({}),
    };
  });
  expect(r.env).toBe(r.native);
  expect(r.env).toBe(true); // все три движка матрицы поддерживают WAAPI
  expect(r.onReal).toBe(true);
  expect(r.onDucklessNull).toBe(false);
  expect(r.onPlain).toBe(false);
});

test('supportsLinearEasing совпадает с CSS.supports(linear())', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { supportsLinearEasing } = await import('/dist/compositor/index.js');
    const native = CSS.supports('transition-timing-function', 'linear(0, 1)');
    return { lib: supportsLinearEasing(), native };
  });
  expect(r.lib).toBe(r.native);
  // linear() — Baseline с 12.2023; в актуальных Chromium/Firefox/WebKit есть.
  expect(r.lib).toBe(true);
});

test('движок реально принимает linear()-строку из easingToLinear', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { easingToLinear } = await import('/dist/waapi/index.js');
    // Явно нелинейный easing (ease-out-ish) → должен дать многостоповый linear().
    const css = easingToLinear((t) => 1 - (1 - t) * (1 - t), 12);
    const supported = CSS.supports('transition-timing-function', css);
    // И браузер должен принять её как easing реальной Animation (не бросить).
    const el = document.createElement('div');
    document.body.appendChild(el);
    let accepted = true;
    try {
      const anim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: css });
      anim.cancel();
    } catch {
      accepted = false;
    }
    el.remove();
    return { css, supported, accepted, stops: css.split(',').length };
  });
  expect(r.css.startsWith('linear(')).toBe(true);
  expect(r.stops).toBeGreaterThan(2);
  expect(r.supported).toBe(true);
  expect(r.accepted).toBe(true);
});

test('resolveCompositorTier: реальная цель → compositor; безанимационная → raf', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { resolveCompositorTier } = await import('/dist/compositor/index.js');
    const el = document.createElement('div');
    // Реальный элемент: WAAPI + linear() → compositor.
    const real = resolveCompositorTier({ target: el });
    // Цель без .animate() (fallback-tier): WAAPI недоступен на ней, но DOM есть → raf.
    const noWaapi = resolveCompositorTier({ target: {} });
    return { real, noWaapi };
  });
  expect(r.real).toBe('compositor');
  expect(r.noWaapi).toBe('raf');
});
