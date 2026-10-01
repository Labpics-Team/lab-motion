import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/harness';

const recipeUrl = '/browser/.artifacts/scope-recipes.js';
type Family = 'sheet' | 'pager';

async function mount(page: Page, family: Family, quiet = false) {
  await page.evaluate(async ({ url, family, quiet }) => {
    const recipes = await import(url);
    const w = window as unknown as {
      consumer: any; root: HTMLElement; handle: HTMLButtonElement; target: HTMLElement;
      frame: (time: number) => void; pending: () => number; issued: number; changes: number; oldLive: any; pointer?: number;
    };
    document.body.innerHTML = '<button id="previous-focus">Назад</button><section id="consumer"></section>';
    document.querySelector<HTMLButtonElement>('#previous-focus')!.focus();
    const root = document.querySelector<HTMLElement>('#consumer')!;
    root.innerHTML = family === 'sheet'
      ? '<button data-sheet-handle style="position:fixed;z-index:1;left:20px;top:20px;width:120px;height:32px;touch-action:none">Положение</button>' +
        '<div data-sheet-panel style="width:240px;height:100px"><input aria-label="Текст" value="Обычный ввод"></div>' +
        '<button data-sheet-snap="0">Закрыть</button><button data-sheet-snap="2">Раскрыть</button>'
      : '<button data-pager-handle style="position:fixed;z-index:1;left:20px;top:20px;width:120px;height:32px;touch-action:none">Страница</button>' +
        '<div data-pager-viewport style="width:240px;overflow:hidden"><div data-pager-track style="display:flex">' +
        '<div data-page style="flex:0 0 100%"><input aria-label="Текст" value="Обычный ввод"></div>' +
        '<div data-page style="flex:0 0 100%">Вторая</div><div data-page style="flex:0 0 100%">Третья</div>' +
        '</div></div><button data-page-index="0">Первая</button><button data-page-index="2">Последняя</button>';
    let queue: Array<(time?: number) => void> = [];
    w.issued = 0; w.changes = 0;
    w.frame = time => { const batch = queue; queue = []; for (const callback of batch) callback(time); };
    w.pending = () => queue.length;
    const options = {
      motion: quiet ? 'none' : 'auto', onSelect: () => { w.changes++; },
      requestFrame: (callback: (time?: number) => void) => { queue.push(callback); return ++w.issued; },
    };
    w.consumer = family === 'sheet'
      ? recipes.mountCompositorSheet(root, { ...options, snapPoints: [0, 120, 240] })
      : recipes.mountCompositorPager(root, options);
    w.root = root;
    root.addEventListener('pointerdown', event => { w.pointer = event.pointerId; }, { capture: true });
    w.handle = root.querySelector<HTMLButtonElement>(family === 'sheet' ? '[data-sheet-handle]' : '[data-pager-handle]')!;
    w.target = root.querySelector<HTMLElement>(family === 'sheet' ? '[data-sheet-panel]' : '[data-pager-track]')!;
  }, { url: recipeUrl, family, quiet });
}

test('literal recipes используют manifest и байты фактического npm tarball', async ({ page }, testInfo) => {
  const response = await page.request.get('/browser/.artifacts/scope-recipes.package.json');
  expect(response.ok()).toBe(true);
  const receipt = await response.json();
  expect(receipt.schema).toBe('scope-recipes-package-v1');
  expect(receipt.package.name).toBe('@labpics/motion');
  expect(receipt.tarball.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.tarball.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
  expect(receipt.recipesSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.manifest.fileCount).toBeGreaterThan(100);
  expect(receipt.motionInputs).toContain('dist/compositor/index.js');
  expect(receipt.motionInputs).toContain('dist/animate/index.js');
  expect(receipt.motionInputs.every((path: string) => path.startsWith('dist/'))).toBe(true);
  await testInfo.attach('actual-package-receipt', { body: JSON.stringify(receipt), contentType: 'application/json' });
});

test('actual tarball: React SSR → hydration сохраняет DOM, StrictMode cleanup и поздний click', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ssr = await page.request.get('/browser/.artifacts/scope-react.ssr.html');
  expect(ssr.ok()).toBe(true);
  const html = await ssr.text();
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.evaluate(async ({ url, html }) => {
    const recipes = await import(url);
    document.body.innerHTML = '<div id="hydration"></div><div class="motion-target" id="outside">Сосед</div>';
    const host = document.querySelector<HTMLElement>('#hydration')!; host.innerHTML = html;
    const w = window as any; w.serverNode = host.firstElementChild; w.starts = 0;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) { w.starts++; return original.apply(this, args); };
    w.hydrated = recipes.mountReact(host, true);
  }, { url: recipeUrl, html });
  await expect.poll(() => page.locator('#hydration .motion-target').evaluate(el => el.getAnimations().length)).toBe(2);
  const result = await page.evaluate(() => {
    const w = window as any;
    const target = document.querySelector<HTMLElement>('#hydration .motion-target')!;
    const button = document.querySelector<HTMLButtonElement>('#hydration button')!;
    const same = document.querySelector('#hydration')!.firstElementChild === w.serverNode;
    const outside = document.querySelector('#outside')!.getAnimations().length;
    const starts = w.starts;
    w.hydrated.destroy(); button.click();
    return { same, outside, starts, effects: target.getAnimations().length };
  });
  expect(result).toEqual({ same: true, outside: 0, starts: 4, effects: 0 });
  expect(errors).toEqual([]);
});

for (const family of ['sheet', 'pager'] as const) {
  for (const intent of ['healthy', 'destroy', 'select'] as const) {
    test(`${family}: getter onSelect сохраняет ${intent} intent до внешнего эффекта`, async ({ page }) => {
      const result = await page.evaluate(async ({ url, family, intent }) => {
        const recipes = await import(url);
        document.body.innerHTML = '<section></section>';
        const root = document.querySelector<HTMLElement>('section')!;
        root.innerHTML = family === 'sheet'
          ? '<button data-sheet-handle>Положение</button><div data-sheet-panel></div>'
          : '<button data-pager-handle>Страница</button><div data-pager-viewport style="width:240px"><div data-pager-track><div data-page>Первая</div><div data-page>Вторая</div></div></div>';
        let consumer: any, nested = false, reads = 0;
        const calls: number[] = [], receivers: unknown[] = [];
        const callback = function (this: unknown, index: number) { calls.push(index); receivers.push(this); };
        Object.defineProperty(callback, 'call', { get() { throw new Error('Не читать callback.call'); } });
        const options = {
          motion: 'none', snapPoints: [0, 120],
          get onSelect() {
            reads++;
            if (intent === 'destroy') consumer.destroy();
            if (intent === 'select' && !nested) { nested = true; consumer.select(1); }
            return callback;
          },
        };
        consumer = family === 'sheet' ? recipes.mountCompositorSheet(root, options) : recipes.mountCompositorPager(root, options);
        consumer.select(0); consumer.destroy();
        return { reads, calls, correctReceiver: receivers.every(receiver => receiver === options) };
      }, { url: recipeUrl, family, intent });
      expect(result).toEqual({ reads: intent === 'select' ? 2 : 1,
        calls: intent === 'destroy' ? [] : intent === 'select' ? [1] : [0], correctReceiver: true });
    });
  }

  for (const tree of ['light', 'shadow', 'nested', 'child-shadow',
    'outside-shadow', 'outside-nested', 'parent-shadow', 'closed-shadow',
    'parent-closed-shadow', 'ancestor-closed-shadow'] as const) {
    test(`${family}: destroy восстанавливает прежний focus owner в ${tree}`, async ({ page }) => {
      const result = await page.evaluate(async ({ url, family, tree }) => {
        const recipes = await import(url);
        document.body.replaceChildren();
        let owner: HTMLElement | ShadowRoot = document.body;
        if (tree !== 'light' && tree !== 'child-shadow') {
          const host = document.createElement('div'); document.body.append(host);
          owner = host.attachShadow({ mode: tree === 'closed-shadow'
            || tree === 'parent-closed-shadow' || tree === 'ancestor-closed-shadow' ? 'closed' : 'open' });
        }
        let previousOwner = owner;
        if (tree === 'outside-shadow' || tree === 'outside-nested') previousOwner = document.body;
        if (tree === 'ancestor-closed-shadow') {
          const host = document.createElement('div'); owner.append(host);
          owner = host.attachShadow({ mode: 'closed' });
        }
        if (tree === 'outside-nested' || tree === 'parent-shadow'
          || tree === 'parent-closed-shadow' || tree === 'ancestor-closed-shadow') {
          const host = document.createElement('div'); owner.append(host);
          owner = host.attachShadow({ mode: 'open' });
        }
        const previous = document.createElement('button'); previous.textContent = 'Назад';
        if (tree === 'nested') {
          const host = document.createElement('div'); owner.append(host);
          host.attachShadow({ mode: 'open' }).append(previous);
        } else previousOwner.append(previous);
        const root = document.createElement('section'); owner.append(root);
        root.innerHTML = family === 'sheet'
          ? '<button data-sheet-handle>Положение</button><div data-sheet-panel></div>'
          : '<button data-pager-handle>Страница</button><div data-pager-viewport style="width:240px"><div data-pager-track><div data-page>Первая</div></div></div>';
        previous.focus();
        // Oracle проверяет известный элемент через нативного владельца дерева,
        // не повторяя поиск прежнего фокуса из публичного рецепта.
        const hasFocus = (element: HTMLElement) =>
          (element.getRootNode() as Document | ShadowRoot).activeElement === element;
        const before = hasFocus(previous);
        const consumer = family === 'sheet'
          ? recipes.mountCompositorSheet(root, { snapPoints: [0, 120], motion: 'none' })
          : recipes.mountCompositorPager(root, { motion: 'none' });
        let handle = root.querySelector<HTMLButtonElement>('button')!;
        if (tree === 'child-shadow') {
          const widget = document.createElement('div'); root.append(widget);
          handle = document.createElement('button'); handle.textContent = 'Вложенный ввод';
          widget.attachShadow({ mode: 'open' }).append(handle);
        }
        handle.focus(); const activeControl = hasFocus(handle);
        consumer.destroy(); consumer.destroy();
        return { before, activeControl, restored: hasFocus(previous) };
      }, { url: recipeUrl, family, tree });
      expect(result).toEqual({ before: true, activeControl: true, restored: true });
    });
  }

  for (const quiet of ['none', 'reduced'] as const) {
    test(`${family}: ${quiet} pause сохраняет текущую quiet drag позу`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: quiet === 'reduced' ? 'reduce' : 'no-preference' });
      await mount(page, family, quiet === 'none');
      await page.mouse.move(50, 35); await page.mouse.down();
      await page.mouse.move(family === 'pager' ? 10 : 50, family === 'sheet' ? 115 : 35);
      const result = await page.evaluate(family => {
        const w = window as any;
        const pixel = () => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
          return family === 'sheet' ? matrix.m42 : matrix.m41;
        };
        const before = pixel();
        const issued = w.issued;
        w.consumer.pause(); w.frame(0); w.frame(80);
        const paused = { pixel: pixel(), issued: w.issued, pending: w.pending(),
          effects: w.target.getAnimations().length, capture: w.handle.hasPointerCapture(w.pointer), selected: w.consumer.selected };
        w.consumer.resume();
        const resumed = pixel();
        w.consumer.destroy();
        return { before, issued, paused, resumed };
      }, family);
      await page.mouse.up();
      expect(Math.abs(result.before)).toBeGreaterThan(1);
      expect(result.paused.pixel).toBeCloseTo(result.before, 3);
      expect(result.paused).toMatchObject({ issued: result.issued, pending: 0, effects: 0, capture: false, selected: 0 });
      expect(result.issued).toBe(0);
      expect(result.resumed).toBe(0);
    });
  }

  test(`${family}: native interruption → live follow → native release; один inert callback`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mount(page, family);
    const before = await page.evaluate(family => {
      const w = window as any;
      w.consumer.select(2);
      const animations = w.target.getAnimations();
      if (animations.length !== 1) throw new Error('Здоровый native control не достигнут');
      animations[0].pause(); animations[0].currentTime = 75;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      return { pixel: family === 'sheet' ? matrix.m42 : matrix.m41, issued: w.issued, mode: w.consumer.motion.mode };
    }, family);
    expect(before.mode).toBe('compositor');
    expect(before.issued).toBe(0);
    await page.mouse.move(50, 35); await page.mouse.down();
    const pickup = await page.evaluate(family => {
      const w = window as any;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      return { pixel: family === 'sheet' ? matrix.m42 : matrix.m41, effects: w.target.getAnimations().length,
        mode: w.consumer.motion.mode, capture: w.handle.hasPointerCapture(w.pointer) };
    }, family);
    expect(pickup.pixel).toBeCloseTo(before.pixel, 3);
    expect(pickup.effects).toBe(0); expect(pickup.mode).toBe('fallback'); expect(pickup.capture).toBe(true);
    await page.mouse.move(family === 'pager' ? 180 : 50, family === 'sheet' ? 155 : 35);
    const follow = await page.evaluate(() => {
      const w = window as any;
      w.frame(0); w.frame(80);
      w.oldLive = w.consumer.motion.handoffToLive();
      return { value: w.oldLive.value, velocity: w.oldLive.velocity, effects: w.target.getAnimations().length,
        pending: w.pending(), issued: w.issued };
    });
    expect(follow.effects).toBe(0); expect(follow.pending).toBe(1);
    expect(Number.isFinite(follow.velocity)).toBe(true); expect(Math.abs(follow.velocity)).toBeGreaterThan(0);
    await page.mouse.up();
    const release = await page.evaluate(family => {
      const w = window as any;
      const animations = w.target.getAnimations();
      if (animations.length !== 1) throw new Error('Release не вернулся в native');
      animations[0].pause(); animations[0].currentTime = 0;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      const issued = w.issued;
      w.oldLive.setTarget(100_000);
      w.frame(160); w.frame(240);
      return { pixel: family === 'sheet' ? matrix.m42 : matrix.m41, mode: w.consumer.motion.mode,
        pending: w.pending(), issued: w.issued, issuedAtRelease: issued, effects: w.target.getAnimations().length };
    }, family);
    expect(release.pixel).toBeCloseTo(follow.value, 3);
    expect(release.mode).toBe('compositor'); expect(release.effects).toBe(1);
    expect(release.pending).toBe(0); expect(release.issued).toBe(release.issuedAtRelease);
    const terminal = await page.evaluate(() => {
      const w = window as any;
      w.consumer.destroy(); w.consumer.destroy(); w.handle.click();
      w.consumer.select(Number.NaN); w.consumer.resume(); w.frame(400);
      return { effects: w.target.getAnimations().length, pending: w.pending(), focus: document.activeElement?.id };
    });
    expect(terminal).toEqual({ effects: 0, pending: 0, focus: 'previous-focus' });
  });

  test(`${family}: pointercancel не меняет выбранную цель, pause сохраняет позу`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mount(page, family);
    await page.evaluate(() => { const w = window as any; w.consumer.select(1); w.target.getAnimations()[0].pause(); w.target.getAnimations()[0].currentTime = 90; });
    await page.mouse.move(50, 35); await page.mouse.down();
    await page.mouse.move(family === 'pager' ? 110 : 50, family === 'sheet' ? 75 : 35);
    const result = await page.evaluate(family => {
      const w = window as any;
      w.frame(0); w.frame(50);
      w.handle.dispatchEvent(new PointerEvent('pointercancel', { pointerId: w.pointer, bubbles: true }));
      const afterCancel = { selected: w.consumer.selected, effects: w.target.getAnimations().length, capture: w.handle.hasPointerCapture(w.pointer) };
      const animation = w.target.getAnimations()[0]; animation.pause(); animation.currentTime = 50;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      const beforePause = family === 'sheet' ? matrix.m42 : matrix.m41;
      w.consumer.pause(); w.frame(120); w.frame(240);
      const pausedMatrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      const paused = { pixel: family === 'sheet' ? pausedMatrix.m42 : pausedMatrix.m41,
        effects: w.target.getAnimations().length, pending: w.pending() };
      w.consumer.resume();
      const resumed = { selected: w.consumer.selected, effects: w.target.getAnimations().length, mode: w.consumer.motion.mode };
      w.consumer.destroy();
      return { afterCancel, beforePause, paused, resumed };
    }, family);
    await page.mouse.up();
    expect(result.afterCancel).toEqual({ selected: 1, effects: 1, capture: false });
    expect(result.paused.pixel).toBeCloseTo(result.beforePause, 3);
    expect(result.paused.effects).toBe(0); expect(result.paused.pending).toBe(0);
    expect(result.resumed).toEqual({ selected: 1, effects: 1, mode: 'compositor' });
  });

  test(`${family}: no-motion, keyboard, IME и явный resize/reparent`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mount(page, family, true);
    const result = await page.evaluate(family => {
      const w = window as any;
      w.handle.focus();
      w.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      const selected = w.consumer.selected;
      const input = w.root.querySelector('input'); input.focus();
      const composing = new KeyboardEvent('keydown', { key: 'ArrowRight', isComposing: true, bubbles: true, cancelable: true });
      input.dispatchEvent(composing); input.value = 'Привет 世界';
      const inputResult = { selected: w.consumer.selected, prevented: composing.defaultPrevented, value: input.value, focused: document.activeElement === input };
      const shadowHost = document.createElement('div'); document.body.append(shadowHost);
      const shadow = shadowHost.attachShadow({ mode: 'open' }); shadow.append(w.root);
      if (family === 'sheet') w.consumer.resize([0, 80, 160]);
      else {
        const viewport = w.root.querySelector('[data-pager-viewport]'); viewport.style.width = '360px'; viewport.style.direction = 'rtl';
        w.consumer.resize();
      }
      const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      const resized = family === 'sheet' ? matrix.m42 : matrix.m41;
      if (family === 'pager') {
        w.handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      }
      const afterRtlKey = w.consumer.selected;
      w.handle.focus(); w.consumer.destroy();
      return { selected, inputResult, resized, afterRtlKey, effects: w.target.getAnimations().length,
        pending: w.pending(), issued: w.issued, focus: document.activeElement?.id };
    }, family);
    expect(result.selected).toBe(2);
    expect(result.inputResult).toEqual({ selected: 2, prevented: false, value: 'Привет 世界', focused: true });
    expect(result.resized).toBe(family === 'sheet' ? 160 : 720);
    expect(result.afterRtlKey).toBe(family === 'sheet' ? 2 : 1);
    expect(result.effects).toBe(0); expect(result.pending).toBe(0); expect(result.issued).toBe(0);
    expect(result.focus).toBe('previous-focus');
  });

  test(`${family}: reduced-motion при mount и при смене предпочтения`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(page, family);
    const reduced = await page.evaluate(family => {
      const w = window as any; w.consumer.select(2);
      const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      const result = { value: family === 'sheet' ? matrix.m42 : matrix.m41, effects: w.target.getAnimations().length, issued: w.issued };
      w.consumer.destroy(); return result;
    }, family);
    expect(reduced).toEqual({ value: family === 'sheet' ? 240 : -480, effects: 0, issued: 0 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mount(page, family);
    await page.evaluate(() => { const w = window as any; w.consumer.select(2); });
    expect(await page.evaluate(() => (window as any).target.getAnimations().length)).toBe(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => (window as any).target.getAnimations().length)).toBe(0);
    const changed = await page.evaluate(family => {
      const w = window as any; w.frame(0); w.frame(80);
      const matrix = new DOMMatrixReadOnly(getComputedStyle(w.target).transform);
      const result = { value: family === 'sheet' ? matrix.m42 : matrix.m41, pending: w.pending() };
      w.consumer.destroy(); return result;
    }, family);
    expect(changed).toEqual({ value: family === 'sheet' ? 240 : -480, pending: 0 });
  });
}
