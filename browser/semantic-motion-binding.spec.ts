import { readFileSync } from 'node:fs';
import { buildSync, transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/harness';

const docs = readFileSync(new URL('../docs/recipes.md', import.meta.url), 'utf8');
const recipe = docs.match(/```typescript\n([^`]*?export function bindUploadMotion[^]*?)\n```/)?.[1];
if (!recipe) throw new Error('Отсутствует исполняемый рецепт bindUploadMotion');
const code = transformSync(recipe, { loader: 'ts', format: 'esm', target: 'es2022' }).code;

async function mount(page: import('@playwright/test').Page) {
  await page.evaluate(async source => {
    document.body.innerHTML = '<button id="surface">Загрузить</button><div id="progress" style="transform-origin:left center"></div><span id="complete">Готово</span>';
    const text = source.replaceAll('@labpics/motion/animate', location.origin + '/dist/animate/index.js')
      .replaceAll('@labpics/motion/bindings', location.origin + '/dist/bindings/index.js');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const { bindUploadMotion } = await import(url); URL.revokeObjectURL(url);
    const get = (id: string) => document.getElementById(id)!;
    (window as unknown as { view: View }).view = bindUploadMotion({ surface: get('surface'), progress: get('progress'), complete: get('complete') });
  }, code);
}
interface View {
  update(model: { pressed: boolean; progress: number; status: 'idle' | 'uploading' | 'complete' }): void;
  destroy(): void;
  readonly state: string;
}

test('буквальный рецепт: progress не заменяет native effects других ролей', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const view = (window as unknown as { view: View }).view;
    const surface = document.getElementById('surface')!, progress = document.getElementById('progress')!, complete = document.getElementById('complete')!;
    view.update({ pressed: true, progress: 0.2, status: 'uploading' });
    const before = [surface, progress, complete].map(el => el.getAnimations());
    for (const animations of before) for (const a of animations) { a.pause(); a.currentTime = 40; }
    view.update({ pressed: true, progress: 0.8, status: 'uploading' });
    const after = [surface, progress, complete].map(el => el.getAnimations());
    const retained = before.map((list, i) => list.length === after[i]!.length && list.every((a, j) => a === after[i]![j]));
    const counts = before.map(list => list.length);
    view.destroy();
    return { retained, counts, remaining: [surface, progress, complete].map(el => el.getAnimations().length) };
  });
  expect(result.counts.every(n => n > 0)).toBe(true);
  expect(result.retained).toEqual([true, false, true]);
  expect(result.remaining).toEqual([0, 0, 0]);
});

test('reduce: конечные стили без собственного rAF и native animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await mount(page);
  const result = await page.evaluate(() => {
    const view = (window as unknown as { view: View }).view;
    let calls = 0; const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) { calls++; return raf.call(window, cb); };
    try {
      view.update({ pressed: true, progress: 0.75, status: 'complete' });
      const surface = document.getElementById('surface')!, progress = document.getElementById('progress')!, complete = document.getElementById('complete')!;
      // DOMMatrix Firefox хранит scale с иной точностью. Эталон — независимый
      // CSS того же host, не округление ожидаемого .97 и не расширение допуска.
      const reference = document.createElement('div');
      reference.style.transform = 'scale(0.97)';
      document.body.append(reference);
      const expectedScale = new DOMMatrix(getComputedStyle(reference).transform).m11;
      reference.style.transform = 'scale(0.96)';
      const wrongScale = new DOMMatrix(getComputedStyle(reference).transform).m11;
      reference.remove();
      const result = { calls, animations: document.getAnimations().length, expectedScale, wrongScale,
        scale: new DOMMatrix(getComputedStyle(surface).transform).m11,
        progress: new DOMMatrix(getComputedStyle(progress).transform).m11,
        complete: Number(getComputedStyle(complete).opacity) };
      view.destroy(); return result;
    } finally { window.requestAnimationFrame = raf; }
  });
  const { scale, expectedScale, wrongScale, ...rest } = result;
  expect(rest).toEqual({ calls: 0, animations: 0, progress: 0.75, complete: 1 });
  expect(scale).toBe(expectedScale);
  expect(scale).not.toBe(wrongScale);
});

test('совпадает с прямым animate при pickup; cancel-before-start действительно отличается', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createMotionBinding } = await import('/dist/bindings/index.js');
    const { animate } = await import('/dist/animate/index.js');
    const els = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return el; });
    const options = { spring: { mass: 1, stiffness: 170, damping: 20 }, now: () => 0 };
    let projections = 0, writes = 0, frames = 0;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) { frames++; return raf.call(window, cb); };
    const view = createMotionBinding((n: number) => { projections++; return { panel: { x: n } }; }, {
      panel: goal => { writes++; return animate(els[0]!, goal, options); },
    });
    try {
      view.update(100); const old = animate(els[1]!, { x: 100 }, options), wrong = animate(els[2]!, { x: 100 }, options);
      for (const el of els) for (const effect of el.getAnimations()) { effect.pause(); effect.currentTime = 80; }
      view.update(0); const next = animate(els[1]!, { x: 0 }, options); wrong.cancel(); const bad = animate(els[2]!, { x: 0 }, options);
      const plans = els.map(el => { const e = el.getAnimations()[0]!.effect as KeyframeEffect; return { frames: e.getKeyframes(), timing: e.getTiming() }; });
      const samples = [0, 12, 40, 80].map(t => els.map(el => {
        const e = el.getAnimations()[0]!; e.pause(); e.currentTime = t;
        return new DOMMatrix(getComputedStyle(el).transform).m41;
      }));
      view.destroy(); old.cancel(); next.cancel(); bad.cancel();
      return { plans, samples, projections, writes, frames };
    } finally { window.requestAnimationFrame = raf; els.forEach(el => el.remove()); }
  });
  expect(result.plans[0]).toEqual(result.plans[1]); expect(result.plans[2]).not.toEqual(result.plans[1]);
  for (const values of result.samples) expect(values[0]).toBeCloseTo(values[1]!, 6);
  expect(result.projections).toBe(2); expect(result.writes).toBe(2); expect(result.frames).toBe(0);
});

test('невалидная последняя роль не прерывает ни одну существующую анимацию', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(() => {
    const view = (window as unknown as { view: View }).view;
    view.update({ pressed: true, progress: 0.2, status: 'uploading' });
    const before = document.getAnimations(); let error = '';
    try { view.update({ pressed: false, progress: NaN, status: 'complete' }); }
    catch (e) { error = (e as { code: string }).code; }
    const after = document.getAnimations();
    const intact = before.length === after.length && before.every((a, i) => a === after[i]);
    const state = view.state; view.destroy(); return { intact, error, state };
  });
  expect(result).toEqual({ intact: true, error: 'LM174', state: 'active' });
});

test('завершённый native fill остаётся ресурсом и убирается при destroy', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createMotionBinding } = await import('/dist/bindings/index.js');
    const el = document.createElement('div'); document.body.append(el);
    const view = createMotionBinding((opacity: number) => ({ panel: { opacity } }), {
      panel: goal => el.animate(goal, { duration: 1000, fill: 'both' }),
    });
    view.update(0); const effect = el.getAnimations()[0]!; effect.finish(); await effect.finished;
    const before = el.getAnimations().length; view.destroy(); const after = el.getAnimations().length;
    el.remove(); return { before, after };
  });
  expect(result).toEqual({ before: 1, after: 0 });
});


// Настоящий client runtime Solid, не server entry и не имитация signals.
const solidConsumer = buildSync({
  stdin: { contents: `
    import {createRoot, createSignal, createEffect, onCleanup, batch} from 'solid-js';
    import {createMotionBinding} from '@labpics/motion/bindings';
    export async function exercise() {
      let setModel, dispose, view, writes = [0, 0], cancels = 0;
      createRoot(stop => {
        dispose = stop;
        const [model, set] = createSignal({pressed:false,progress:0});
        setModel = set;
        view = createMotionBinding(s => ({surface:{scale:s.pressed?.97:1},bar:{scaleX:s.progress}}), {
          surface: () => {writes[0]++; return {cancel(){cancels++;}};},
          bar: () => {writes[1]++; return {cancel(){cancels++;}};},
        });
        createEffect(() => view.update(model()));
        onCleanup(view.destroy);
      });
      await Promise.resolve();
      const initial = writes.slice();
      batch(() => {
        setModel({pressed:true,progress:.2});
        setModel({pressed:true,progress:.8});
      });
      const batched = writes.slice();
      setModel({pressed:true,progress:.8});
      const unchanged = writes.slice();
      dispose();
      const destroyed = {writes:writes.slice(),cancels,state:view.state};
      setModel({pressed:false,progress:1});
      return {initial,batched,unchanged,destroyed,late:writes};
    }
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'solid-binding-consumer.js' },
  platform: 'browser', bundle: true, format: 'esm', target: 'es2022', write: false,
  external: ['@labpics/motion/bindings'],
}).outputFiles[0]!.text;

test('Solid: штатные signal/batch/cleanup без второго store или provider', async ({page}) => {
  const result = await page.evaluate(async source => {
    const text = source.replaceAll('@labpics/motion/bindings', location.origin + '/dist/bindings/index.js');
    const url = URL.createObjectURL(new Blob([text], {type:'text/javascript'}));
    try { const {exercise} = await import(url); return await exercise(); }
    finally { URL.revokeObjectURL(url); }
  }, solidConsumer);
  expect(result).toEqual({initial:[1,1],batched:[2,2],unchanged:[2,2],
    destroyed:{writes:[2,2],cancels:4,state:'destroyed'},late:[2,2]});
});

const navigationRecipe = docs.match(/```typescript\n([^`]*?export function bindNavigationMotion[^]*?)\n```/)?.[1];
if (!navigationRecipe) throw new Error('Отсутствует исполняемый рецепт bindNavigationMotion');
const navigationCode = transformSync(navigationRecipe, { loader: 'ts', format: 'esm', target: 'es2022' }).code;

for (const direction of ['ltr', 'rtl']) test(`навигация: фокус не перезапускает выбор, геометрия обновляется (${direction})`, async ({ page }) => {
  await page.evaluate(async ({ source, direction }) => {
    document.body.innerHTML = `<nav style="position:relative;display:flex;gap:8px;width:360px;direction:${direction}">
      <button data-key="a" style="width:100px">Обзор</button>
      <button data-key="b" style="width:120px">Проекты</button>
      <i id="selection" style="position:absolute;left:0;bottom:0;width:1px;height:3px;transform-origin:left center;pointer-events:none"></i>
      <i id="focus" style="position:absolute;left:0;top:0;width:1px;height:2px;transform-origin:left center;pointer-events:none"></i>
    </nav>`;
    // Прозрачный наблюдатель сохраняет настоящие публичные controls. После
    // прерывания оси могут иметь разные скорости и законно перейти с WAAPI
    // на MainUnit: getAnimations() не является часами всего движения.
    const trackedUrl = URL.createObjectURL(new Blob([`
      import { animate as original } from '${location.origin}/dist/animate/index.js';
      export const controls = [];
      export function animate(...args) {
        const control = original(...args);
        controls.push(control);
        return control;
      }
    `], { type: 'text/javascript' }));
    const { controls } = await import(trackedUrl);
    const text = source.replaceAll('@labpics/motion/animate', trackedUrl)
      .replaceAll('@labpics/motion/bindings', location.origin + '/dist/bindings/index.js');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const { bindNavigationMotion } = await import(url);
    URL.revokeObjectURL(url); URL.revokeObjectURL(trackedUrl);
    const selection = document.getElementById('selection')!, focus = document.getElementById('focus')!;
    const view = bindNavigationMotion({ selection, focus });
    let selected = 'a', focused: string | null = null;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    const update = () => view.update({ selected, focused,
      items: buttons.map(button => ({ key: button.dataset.key!, x: button.offsetLeft, width: button.offsetWidth })),
    });
    for (const button of buttons) {
      button.addEventListener('focus', () => { focused = button.dataset.key!; update(); });
      button.addEventListener('blur', () => { focused = null; update(); });
      button.addEventListener('click', () => {
        selected = button.dataset.key!;
        for (const item of buttons) item.setAttribute('aria-current', item === button ? 'page' : 'false');
        update();
      });
    }
    update();
    const before = selection.getAnimations()[0];
    if (!before) throw new Error('Контроль должен создать native selection');
    before.pause(); before.currentTime = 40;
    (window as unknown as { navigation: unknown }).navigation = { view, update, before, controls };
  }, { source: navigationCode, direction });
  await page.getByRole('button', { name: 'Проекты' }).focus();
  expect(await page.evaluate(() => {
    const n = (window as unknown as { navigation: { before: Animation } }).navigation;
    return document.getElementById('selection')!.getAnimations()[0] === n.before;
  })).toBe(true);
  await page.getByRole('button', { name: 'Проекты' }).press('Space');
  await expect(page.getByRole('button', { name: 'Проекты' })).toHaveAttribute('aria-current', 'page');
  const result = await page.evaluate(() => {
    const n = (window as unknown as { navigation: { before: Animation; controls: Array<{ pause(): void; seek(tMs: number): void }>; update(): void; view: { destroy(): void } } }).navigation;
    const selection = document.getElementById('selection')!, focus = document.getElementById('focus')!;
    const changed = selection.getAnimations()[0] !== n.before;
    const button = document.querySelector<HTMLButtonElement>('[data-key=b]')!;
    button.style.width = '160px'; n.update();
    const expected = [button.offsetLeft, button.offsetWidth];
    // Общие публичные часы для native и JS. Отозванные controls инертны;
    // реальные текущие исполнители обеих ролей достигают той же цели.
    for (const control of n.controls) { control.pause(); control.seek(10_000); }
    const actual = [selection, focus].map(el => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      return [matrix.m41, matrix.m11];
    });
    const focused = document.activeElement === button;
    n.view.destroy();
    return { changed, expected, actual, focused, remaining: [selection, focus].map(el => el.getAnimations().length) };
  });
  expect(result.changed).toBe(true);
  expect(result.actual).toEqual([result.expected, result.expected]);
  expect(result.focused).toBe(true);
  expect(result.remaining).toEqual([0, 0]);
});
