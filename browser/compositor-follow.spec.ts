import { expect, test } from './fixtures/harness';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type PackageReceipt = {
  tarball: { sha256: string };
  outputs: { file: string; sha256: string }[];
};

type ProbeWindow = Window & {
  followProbe: { animations: Animation[]; frames: number; cleanup: () => void };
};

test.beforeEach(async ({ page }) => {
  const manifest = await page.request.get('/browser/.artifacts/compositor-follow-package.json');
  expect(manifest.ok()).toBe(true);
  const receipt: PackageReceipt = await manifest.json();
  const tarball = process.env.LAB_MOTION_TARBALL ?? new URL('./.artifacts/compositor-follow-package.tgz', import.meta.url);
  expect(createHash('sha256').update(readFileSync(tarball)).digest('hex')).toBe(receipt.tarball.sha256);
  const bundle = await page.request.get('/browser/.artifacts/compositor-follow-recipes.js');
  expect(bundle.ok()).toBe(true);
  expect(createHash('sha256').update(await bundle.body()).digest('hex'))
    .toBe(receipt.outputs.find((output) => output.file === 'compositor-follow-recipes.js')?.sha256);
  test.info().annotations.push({ type: 'package-sha256', description: receipt.tarball.sha256 });
  await test.info().attach('shipped-recipe', { body: JSON.stringify(receipt), contentType: 'application/json' });
  await page.evaluate(() => {
    const probe = { animations: [] as Animation[], frames: 0, cleanup: () => {} };
    (window as unknown as ProbeWindow).followProbe = probe;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      animation.pause();
      animation.currentTime = 0;
      probe.animations.push(animation);
      return animation;
    };
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => { probe.frames++; return raf.call(window, callback); };
  });
});

test('рецепт панели: повторный pickup, native settle, focus и cleanup', async ({ page }) => {
  await page.setContent(`<style>
    #panel-root { position:relative; width:320px; height:700px; }
    [data-panel] { position:absolute; top:50px; width:320px; height:300px; background:#ddd; }
    [data-handle] { height:40px; width:320px; touch-action:none; }
  </style><section id="panel-root"><button data-open>Открыть</button>
    <section data-panel aria-label="Параметры"><div data-handle>Потяните панель</div>
      <button data-close>Закрыть</button></section></section>`);
  await page.evaluate(async () => {
    // @ts-expect-error Модуль собирается из буквального кода docs/recipes.md.
    const { mountSnapPanel } = await import('/browser/.artifacts/compositor-follow-recipes.js');
    (window as unknown as ProbeWindow).followProbe.cleanup = mountSnapPanel(document.getElementById('panel-root'));
  });
  await page.locator('[data-open]').click();
  await expect(page.locator('[data-close]')).toBeFocused();
  await page.evaluate(() => {
    const animation = (window as unknown as ProbeWindow).followProbe.animations.at(-1)!;
    animation.currentTime = Number(animation.effect!.getComputedTiming().duration);
  });
  const handle = await page.locator('[data-handle]').boundingBox();
  await page.mouse.move(handle!.x + 30, handle!.y + 20);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 30, handle!.y + 130, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#panel-root')).toHaveAttribute('data-snap', '160');
  expect(await page.locator('[data-panel]').evaluate((el) => el.getAnimations().length)).toBe(1);

  await page.evaluate(() => { (window as unknown as ProbeWindow).followProbe.animations.at(-1)!.currentTime = 40; });
  const before = await page.locator('[data-panel]').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42);
  const second = await page.locator('[data-handle]').boundingBox();
  await page.mouse.move(second!.x + 30, second!.y + 20);
  await page.mouse.down();
  const after = await page.locator('[data-panel]').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42);
  expect(Math.abs(after - before)).toBeLessThan(0.01);
  expect(await page.locator('[data-panel]').evaluate((el) => el.getAnimations().length)).toBe(0);
  await page.mouse.move(second!.x + 30, second!.y - 25, { steps: 3 });
  await page.mouse.up();
  expect(await page.locator('[data-panel]').evaluate((el) => el.getAnimations().length)).toBe(1);
  await page.locator('[data-close]').click();
  await expect(page.locator('[data-open]')).toBeFocused();
  await expect(page.locator('[data-open]')).toHaveAttribute('aria-expanded', 'false');
  const result = await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).followProbe;
    probe.cleanup();
    return { count: probe.animations.length, frames: probe.frames, idle: probe.animations.every((a) => a.playState === 'idle') };
  });
  expect(result.frames).toBe(0);
  expect(result.idle).toBe(true);
  await page.locator('[data-open]').click();
  expect(await page.evaluate(() => (window as unknown as ProbeWindow).followProbe.animations.length)).toBe(result.count);
});

test('рецепт карусели: локальная страница, повторный захват, кнопки и cleanup', async ({ page }) => {
  await page.setContent(`<style>
    [data-viewport] { width:240px; overflow:hidden; }
    [data-track] { display:flex; width:720px; touch-action:pan-y; }
    [data-track] > article { flex:0 0 240px; height:100px; background:#ddd; }
  </style><section id="carousel-root"><div data-viewport><div data-track>
    <article>Один</article><article>Два</article><article>Три</article></div></div>
    <button data-previous>Назад</button><button data-next>Вперёд</button>
    <p data-page-status role="status"></p></section>`);
  await page.evaluate(async () => {
    // @ts-expect-error Модуль собирается из буквального кода docs/recipes.md.
    const { mountPagedCarousel } = await import('/browser/.artifacts/compositor-follow-recipes.js');
    (window as unknown as ProbeWindow).followProbe.cleanup = mountPagedCarousel(document.getElementById('carousel-root'));
  });
  const viewport = await page.locator('[data-viewport]').boundingBox();
  const x = viewport!.x + 190;
  const y = viewport!.y + 30;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 145, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('[data-page-status]')).toHaveText('Страница 2 из 3');
  expect(await page.locator('[data-track]').evaluate((el) => el.getAnimations().length)).toBe(1);
  await page.evaluate(() => { (window as unknown as ProbeWindow).followProbe.animations.at(-1)!.currentTime = 30; });
  const before = await page.locator('[data-track]').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  await page.mouse.move(x, y);
  await page.mouse.down();
  const after = await page.locator('[data-track]').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  expect(Math.abs(after - before)).toBeLessThan(0.01);
  await page.mouse.move(x - 40, y, { steps: 3 });
  await page.mouse.up();
  expect(await page.locator('[data-track]').evaluate((el) => el.getAnimations().length)).toBe(1);
  await page.locator('[data-next]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-page-status]')).toHaveText('Страница 3 из 3');
  await expect(page.locator('[data-next]')).toBeDisabled();
  const result = await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).followProbe;
    probe.cleanup();
    return { count: probe.animations.length, frames: probe.frames, idle: probe.animations.every((a) => a.playState === 'idle') };
  });
  expect(result.frames).toBe(0);
  expect(result.idle).toBe(true);
  await page.locator('[data-previous]').click();
  expect(await page.evaluate(() => (window as unknown as ProbeWindow).followProbe.animations.length)).toBe(result.count);
});


test('рецепт панели: принятый pointer сохраняет mouse focus и клавиатуру', async ({ page }) => {
  await page.setContent(`<section id="panel-root"><button data-open>Открыть</button>
    <section data-panel aria-label="Параметры"><div data-handle tabindex="0">Потяните панель</div>
      <button data-close>Закрыть</button></section></section>`);
  await page.evaluate(async () => {
    // @ts-expect-error Модуль собирается из буквального кода docs/recipes.md.
    const { mountSnapPanel } = await import('/browser/.artifacts/compositor-follow-recipes.js');
    (window as unknown as ProbeWindow).followProbe.cleanup = mountSnapPanel(document.getElementById('panel-root'));
  });
  await page.locator('[data-open]').click();
  await page.evaluate(() => {
    const animation = (window as unknown as ProbeWindow).followProbe.animations.at(-1)!;
    animation.currentTime = Number(animation.effect!.getComputedTiming().duration);
  });
  await page.locator('[data-handle]').click();
  await expect(page.locator('[data-handle]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-close]')).toBeFocused();
  await page.evaluate(() => (window as unknown as ProbeWindow).followProbe.cleanup());
});
