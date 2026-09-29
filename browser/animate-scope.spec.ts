import { expect, test } from './fixtures/harness';

const recipeUrl = '/browser/.artifacts/scope-recipes.js';

test('локальные roots и ShadowRoot: чужой компонент не движется, cleanup снимает WAAPI', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = await page.evaluate(async () => {
    const { createAnimateScope } = await import('/dist/animate/index.js');
    const first = document.createElement('section'); const second = document.createElement('section');
    first.innerHTML = second.innerHTML = '<div class="motion-target">Card</div>';
    document.body.append(first, second);
    const shadow = second.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div class="motion-target">Shadow</div>';
    const a = first.querySelector<HTMLElement>('.motion-target')!;
    const b = second.querySelector<HTMLElement>('.motion-target')!;
    const c = shadow.querySelector<HTMLElement>('.motion-target')!;
    const s = createAnimateScope(first); const sh = createAnimateScope(shadow);
    const one = s.animate('.motion-target', { opacity: [0, 1] });
    const two = sh.animate('.motion-target', { opacity: [0, 1] });
    const during = [a, b, c].map(el => el.getAnimations().length);
    for (const el of [a, c]) for (const animation of el.getAnimations()) animation.currentTime = 100;
    const advanced = [a, c].map(el => Number(getComputedStyle(el).opacity));
    s.destroy(); const afterFirst = [a, b, c].map(el => el.getAnimations().length);
    sh.destroy(); await Promise.all([one.finished, two.finished]);
    const after = [a, b, c].map(el => el.getAnimations().length);
    const late = s.animate('.motion-target', { opacity: [0, 1] }); await late.finished;
    const lateCount = a.getAnimations().length;
    first.remove(); second.remove();
    return { during, advanced, afterFirst, after, lateCount };
  });
  expect(result.during).toEqual([1, 0, 1]);
  for (const opacity of result.advanced) { expect(opacity).toBeGreaterThan(0); expect(opacity).toBeLessThan(1); }
  expect(result.afterFirst).toEqual([0, 0, 1]); expect(result.after).toEqual([0, 0, 0]); expect(result.lateCount).toBe(0);
});

test('DOM recipe из документации: повтор, keyboard, detached cleanup, remount', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async (url) => {
    const { mountCardMotion } = await import(url);
    document.body.innerHTML = '<section id="a"><button data-replay>Повторить</button><div class="motion-target">A</div></section>' +
      '<section id="b"><button data-replay>Повторить</button><div class="motion-target">B</div></section>';
    const root = document.querySelector<HTMLElement>('#a')!;
    const w = window as unknown as { dispose: () => void; target: HTMLElement; mount: () => void };
    w.target = root.querySelector('.motion-target')!;
    w.mount = () => { w.dispose = mountCardMotion(root); }; w.mount();
  }, recipeUrl);
  await expect.poll(() => page.locator('#a .motion-target').evaluate(el => el.getAnimations().length)).toBe(2);
  expect(await page.locator('#b .motion-target').evaluate(el => el.getAnimations().length)).toBe(0);
  await page.locator('#a button').focus(); await page.keyboard.press('Enter');
  expect(await page.locator('#a .motion-target').evaluate(el => el.getAnimations().length)).toBe(2);
  const result = await page.evaluate(async () => {
    const w = window as unknown as { dispose: () => void; target: HTMLElement; mount: () => void };
    w.dispose(); await Promise.resolve(); const after = w.target.getAnimations().length;
    document.querySelector<HTMLButtonElement>('#a button')!.click(); const late = w.target.getAnimations().length;
    w.mount(); const remount = w.target.getAnimations().length;
    w.target.remove(); w.dispose(); await Promise.resolve();
    return { after, late, remount, detached: w.target.getAnimations().length };
  });
  expect(result).toEqual({ after: 0, late: 0, remount: 2, detached: 0 });
});

for (const framework of ['React', 'Solid'] as const) {
  test(`${framework} recipe: настоящий owner, cleanup и отсутствие чужих анимаций`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async ({ url, framework }) => {
      const recipes = await import(url);
      document.body.innerHTML = '<div id="component"></div><div class="motion-target" id="outside">Outside</div>';
      const host = document.querySelector<HTMLElement>('#component')!;
      const w = window as unknown as { dispose: () => void; commits: () => number; starts: number };
      w.starts = 0; const original = Element.prototype.animate;
      Element.prototype.animate = function (...args) { w.starts++; return original.apply(this, args); };
      if (framework === 'React') { const mounted = recipes.mountReact(host); w.dispose = mounted.destroy; w.commits = mounted.commits; }
      else { w.dispose = recipes.mountSolid(host); w.commits = () => 0; }
    }, { url: recipeUrl, framework });
    await expect.poll(() => page.locator('#component .motion-target').evaluate(el => el.getAnimations().length)).toBe(2);
    expect(await page.locator('#outside').evaluate(el => el.getAnimations().length)).toBe(0);
    if (framework === 'React') {
      expect(await page.evaluate(() => (window as unknown as { starts: number }).starts)).toBe(4); // setup → cleanup → setup
    }
    const before = await page.evaluate(() => (window as unknown as { commits: () => number }).commits());
    await page.locator('#component button').click();
    const result = await page.evaluate(async () => {
      const w = window as unknown as { dispose: () => void; commits: () => number };
      const el = document.querySelector<HTMLElement>('#component .motion-target')!;
      for (const animation of el.getAnimations()) animation.currentTime = 100;
      const moved = Number(getComputedStyle(el).opacity);
      const button = document.querySelector<HTMLButtonElement>('#component button')!;
      w.dispose(); await Promise.resolve(); const after = el.getAnimations().length;
      button.click(); await Promise.resolve();
      return { moved, after, late: el.getAnimations().length, commits: w.commits() };
    });
    expect(result.moved).toBeGreaterThan(0); expect(result.moved).toBeLessThan(1);
    expect(result.after).toBe(0); expect(result.late).toBe(0); expect(result.commits).toBe(before);
  });
}

test('reduced motion и main fallback сохраняют lifecycle области', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(async (url) => {
    const { mountCardMotion } = await import(url);
    const root = document.createElement('section'); root.innerHTML = '<button data-replay>Go</button><div class="motion-target">A</div>'; document.body.append(root);
    const dispose = mountCardMotion(root); const el = root.querySelector<HTMLElement>('.motion-target')!;
    const result = { opacity: el.style.opacity, effects: el.getAnimations().length };
    dispose(); root.remove(); return result;
  }, recipeUrl);
  expect(reduced).toEqual({ opacity: '1', effects: 0 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const fallback = await page.evaluate(async () => {
    const { createAnimateScope } = await import('/dist/animate/index.js');
    const root = document.createElement('section'); const el = document.createElement('div'); root.append(el); document.body.append(root);
    let queue: Array<(t?: number) => void> = [];
    const frame = (t: number) => { const current = queue; queue = []; for (const cb of current) cb(t); };
    const scope = createAnimateScope(root);
    const c = scope.animate('div', { opacity: [0, 1] }, { duration: 100, ease: t => t, requestFrame: cb => queue.push(cb) });
    frame(0); frame(50); const before = el.style.opacity;
    scope.destroy(); frame(100); await c.finished; const after = el.style.opacity;
    root.remove(); return { before, after, pending: queue.length };
  });
  expect(fallback).toEqual({ before: '0.5', after: '0.5', pending: 0 });
});
