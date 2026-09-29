import { expect, test } from './fixtures/harness';
import type { Page } from '@playwright/test';

async function mount(page: Page, grid = false, rtl = false): Promise<void> {
  await page.setContent(`<style>
    ul { width: 260px; padding: 0; display: grid; gap: 10px; list-style:none; ${grid ? 'grid-template-columns: repeat(2, 1fr);' : ''} }
    li { height: 80px; } .reorder-card { height:80px; background:#eee; }
    [data-grip] { height: 40px; width:100%; touch-action:none; }
  </style><ul id="list" dir="${rtl ? 'rtl' : 'ltr'}" aria-label="Задачи">${['a', 'b', 'c', 'd'].map(key => `<li data-key="${key}"><div class="reorder-card"><button data-grip aria-pressed="false">${key}</button><button data-move="previous">Раньше ${key}</button><button data-move="next">Позже ${key}</button></div></li>`).join('')}</ul><p id="status" role="status" aria-live="polite"></p><ul id="other"><li data-key="a">Другой компонент</li></ul>`);
  await page.evaluate(async () => {
    // Артефакт globalSetup построен из буквального кода docs/recipes.md.
    // @ts-expect-error generated browser-only fixture
    const { mountReorder } = await import('/browser/.artifacts/reorder-recipe.js');
    (window as unknown as { cleanup: () => void }).cleanup = mountReorder(document.getElementById('list'), document.getElementById('status'));
  });
}
const order = (page: Page) => page.locator('#list > li').evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.key));

test('реальный pointer reorder: scoped list, подтверждённый DOM, focus и cleanup', async ({ page }) => {
  await mount(page);
  const first = await page.locator('[data-key=a] [data-grip]').boundingBox();
  const target = await page.locator('[data-key=c] [data-grip]').boundingBox();
  await page.mouse.move(first!.x + 20, first!.y + 20); await page.mouse.down();
  await page.mouse.move(target!.x + 20, target!.y + 20, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['b', 'c', 'a', 'd']);
  await expect(page.locator('#other')).toHaveText('Другой компонент');
  await expect(page.locator('[data-key=a] [data-grip]')).toBeFocused();
  await expect(page.locator('#status')).toHaveText('a: 3 из 4');
  await page.evaluate(() => (window as unknown as { cleanup: () => void }).cleanup());
  const before = await order(page);
  await page.locator('[data-key=a] [data-grip]').press('Space'); await page.keyboard.press('Home');
  expect(await order(page)).toEqual(before);
  await expect(page.locator('[data-key=a] [data-grip]')).toHaveAttribute('aria-pressed', 'false');
});

for (const rtl of [false, true]) test(`grid ${rtl ? 'RTL' : 'LTR'}: keyboard, альтернативные кнопки и Escape`, async ({ page }) => {
  await mount(page, true, rtl);
  await page.locator('[data-key=a] [data-grip]').focus(); await page.keyboard.press('Space');
  await page.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight');
  expect(await order(page)).toEqual(['b', 'a', 'c', 'd']);
  await page.keyboard.press('ArrowDown');
  expect(await order(page)).toEqual(['b', 'c', 'd', 'a']);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-key=a] [data-grip]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-key=a] [data-move=previous]').click();
  expect(await order(page)).toEqual(['b', 'c', 'a', 'd']);
  await expect(page.locator('[data-key=a] [data-move=previous]')).toBeFocused();
  await page.evaluate(() => (window as unknown as { cleanup: () => void }).cleanup());
});

test('reduced motion сохраняет перестановку, не создавая ни одного rAF', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await mount(page);
  await page.evaluate(() => {
    const original = window.requestAnimationFrame;
    (window as unknown as { requests: number }).requests = 0;
    window.requestAnimationFrame = cb => { (window as unknown as { requests: number }).requests++; return original(cb); };
  });
  await page.locator('[data-key=b] [data-grip]').focus(); await page.keyboard.press('Space'); await page.keyboard.press('End');
  expect(await order(page)).toEqual(['a', 'c', 'd', 'b']);
  expect(await page.evaluate(() => (window as unknown as { requests: number }).requests)).toBe(0);
  expect(await page.locator('.reorder-card').evaluateAll(nodes => nodes.every(n => !(n as HTMLElement).style.transform))).toBe(true);
});

test('повторная перестановка mid-flight сохраняет визуальную границу и один projection callback', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const queue: FrameRequestCallback[] = []; let maxPending = 0;
    window.requestAnimationFrame = cb => { queue.push(cb); maxPending = Math.max(maxPending, queue.length); return queue.length; };
    const frame = (ts: number) => { const batch = queue.splice(0); for (const cb of batch) cb(ts); };
    const button = document.querySelector<HTMLElement>('[data-key=a] [data-grip]')!;
    const key = (k: string) => button.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    button.focus(); key(' '); key('ArrowDown'); frame(0); frame(16);
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.reorder-card'));
    const before = nodes.map(n => n.getBoundingClientRect().y);
    key('ArrowDown');
    const after = nodes.map(n => n.getBoundingClientRect().y);
    frame(32);
    const moving = nodes.some(n => n.style.transform !== '');
    (window as unknown as { cleanup: () => void }).cleanup();
    const clean = nodes.map(n => n.getAttribute('style'));
    for (const ts of [48, 100, 5000]) frame(ts);
    return { before, after, moving, maxPending, clean, afterCleanup: nodes.map(n => n.getAttribute('style')), queued: queue.length };
  });
  for (let i = 0; i < result.before.length; i++) expect(Math.abs(result.before[i]! - result.after[i]!)).toBeLessThan(0.05);
  expect(result.moving).toBe(true); expect(result.maxPending).toBe(1); expect(result.queued).toBe(0);
  expect(result.afterCleanup).toEqual(result.clean);
});

test('actual dist: no rAF/listener в headless resolver; stale proposal после внешнего snapshot', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createReorder } = await import('/dist/behaviors/reorder/index.js');
    let calls = 0, raf = 0; const original = window.requestAnimationFrame;
    window.requestAnimationFrame = cb => { raf++; return original(cb); };
    const rect = (y: number) => ({ x: 0, y, width: 10, height: 10 });
    let current: Parameters<ReturnType<typeof createReorder<string>>['isCurrent']>[0] | undefined;
    const state = createReorder<string>({ items: [{ key: 'a', rect: rect(0) }, { key: 'b', rect: rect(30) }, { key: 'hidden' }], onReorder(_next, p) { calls++; current = p; } });
    const s = state.start('a')!; s.step('next'); const valid = state.isCurrent(current!);
    for (let i = 0; i < 1000; i++) s.move({ x: 5, y: 35 });
    state.update([{ key: 'a', rect: rect(0) }, { key: 'hidden' }]);
    const stale = state.isCurrent(current!); s.move({ x: 5, y: 35 }); state.destroy();
    return { calls, raf, valid, stale, active: s.active };
  });
  expect(result).toEqual({ calls: 1, raf: 0, valid: true, stale: false, active: false });
});
