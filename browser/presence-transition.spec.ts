import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { test, expect } from './fixtures/harness';

const docs = readFileSync(new URL('../docs/recipes.md', import.meta.url), 'utf8');
const recipe = docs.match(/```typescript\n([^`]*?export function bindAnimatedDialog[^]*?)\n```/)?.[1];
if (!recipe) throw new Error('Рабочий рецепт отсутствует');
const code = transformSync(recipe, { loader: 'ts', format: 'esm', target: 'es2022' }).code;

// Исполняется буквальный пример документации, не его копия в test fixture.
async function mount(page: import('@playwright/test').Page) {
  await page.evaluate(async source => {
    document.body.innerHTML = '<button id="open">Открыть</button><dialog aria-label="Настройки"><section data-panel><button autofocus>Готово</button></section></dialog>';
    const opener = document.querySelector<HTMLButtonElement>('#open')!;
    opener.focus();
    const text = source.replaceAll('@labpics/motion/animate', location.origin + '/dist/animate/index.js')
      .replaceAll('@labpics/motion/presence', location.origin + '/dist/presence/index.js');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const module = await import(url); URL.revokeObjectURL(url);
    const dialog = document.querySelector<HTMLDialogElement>('dialog')!;
    (window as unknown as { binding: Binding }).binding = module.bindAnimatedDialog(dialog);
  }, code);
}
interface Binding {
  setPresent(value: boolean): Promise<unknown>;
  readonly finished: Promise<unknown>;
  readonly state: string;
  destroy(): void;
}

for (const reduced of [false, true]) test(`диалог: рецепт, Escape, фокус, cleanup (reduce=${reduced})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await mount(page);
  const initial = await page.evaluate(async () => {
    const binding = (window as unknown as { binding: Binding }).binding;
    let rafs = 0; const old = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) { rafs++; return old.call(window, cb); };
    const opening = binding.setPresent(true);
    const effects = document.querySelector('[data-panel]')!.getAnimations();
    for (const effect of effects) effect.finish();
    await opening;
    window.requestAnimationFrame = old;
    return { state: binding.state, open: document.querySelector<HTMLDialogElement>('dialog')!.open,
      focused: document.activeElement?.textContent, rafs, effects: effects.length };
  });
  expect(initial.state).toBe('present'); expect(initial.open).toBe(true); expect(initial.focused).toBe('Готово');
  if (reduced) { expect(initial.rafs).toBe(0); expect(initial.effects).toBe(0); }
  else expect(initial.effects).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  const final = await page.evaluate(async () => {
    const binding = (window as unknown as { binding: Binding }).binding;
    for (const effect of document.querySelector('[data-panel]')!.getAnimations()) effect.finish();
    await binding.finished;
    const closed = !document.querySelector<HTMLDialogElement>('dialog')!.open;
    const focused = document.activeElement?.id;
    binding.destroy(); await binding.setPresent(true);
    return { closed, focused, state: binding.state, open: document.querySelector<HTMLDialogElement>('dialog')!.open };
  });
  expect(final).toEqual({ closed: true, focused: 'open', state: 'destroyed', open: false });
});

test('повторное открытие не скрывает диалог по старому finished', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const p = (window as unknown as { binding: Binding }).binding;
    const first = p.setPresent(true);
    const panel = document.querySelector('[data-panel]')!;
    for (const animation of panel.getAnimations()) animation.finish(); await first;
    const exit = p.setPresent(false);
    for (const animation of panel.getAnimations()) { animation.pause(); animation.currentTime = 70; }
    const before = getComputedStyle(panel).opacity;
    const enter = p.setPresent(true);
    for (const animation of panel.getAnimations()) { animation.pause(); animation.currentTime = 0; }
    const after = getComputedStyle(panel).opacity;
    const oldResult = await exit;
    const stillOpen = document.querySelector<HTMLDialogElement>('dialog')!.open;
    for (const animation of panel.getAnimations()) { animation.play(); animation.finish(); } await enter;
    const state = p.state; p.destroy();
    return { before: Number(before), after: Number(after), oldResult, stillOpen, state };
  });
  expect(result.before).toBeGreaterThan(0); expect(result.before).toBeLessThan(1);
  expect(result.after).toBeCloseTo(result.before, 5);
  expect(result.oldResult).toEqual({ status: 'superseded', present: false });
  expect(result.stillOpen).toBe(true); expect(result.state).toBe('present');
});

test('вся группа native Animation завершена прежде onGone, не первый элемент', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createPresenceTransition } = await import('/dist/presence/index.js');
    const a = document.createElement('div'), b = document.createElement('div'); document.body.append(a, b);
    let gone = 0;
    const effects = [a, b].map(el => el.animate({ opacity: [1, 0] }, { duration: 10_000, fill: 'both' }));
    effects.forEach(effect => effect.pause());
    const p = createPresenceTransition({ initiallyPresent: true, exit: () => effects, onGone: () => { gone++; } });
    const pending = p.setPresent(false);
    effects[0]!.finish(); await effects[0]!.finished;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const partial = { gone, state: p.state };
    effects[1]!.finish(); const outcome = await pending; const final = { gone, state: p.state };
    p.destroy(); a.remove(); b.remove(); return { partial, final, outcome };
  });
  expect(result.partial).toEqual({ gone: 0, state: 'exiting' });
  expect(result.final).toEqual({ gone: 1, state: 'gone' });
  expect(result.outcome).toEqual({ status: 'finished', present: false });
});

test('native pickup равен прямому animate, cancel-before-start является различителем', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createPresenceTransition } = await import('/dist/presence/index.js');
    const { animate } = await import('/dist/animate/index.js');
    const els = [0, 1, 2].map(() => { const el = document.createElement('div'); document.body.append(el); return el; });
    const [managed, raw, wrong] = els as [HTMLDivElement, HTMLDivElement, HTMLDivElement];
    const options = { spring: { mass: 1, stiffness: 170, damping: 20 }, now: () => 0 };
    const p = createPresenceTransition({ initiallyPresent: true,
      exit: () => animate(managed, { x: 100 }, options), enter: () => animate(managed, { x: 0 }, options) });
    p.setPresent(false); const rawExit = animate(raw, { x: 100 }, options), wrongExit = animate(wrong, { x: 100 }, options);
    for (const el of els) for (const effect of el.getAnimations()) { effect.pause(); effect.currentTime = 80; }
    p.setPresent(true); const rawEnter = animate(raw, { x: 0 }, options); wrongExit.cancel(); const wrongEnter = animate(wrong, { x: 0 }, options);
    const plans = els.map(el => {
      const effect = el.getAnimations()[0]!.effect as KeyframeEffect;
      return { frames: effect.getKeyframes(), timing: effect.getTiming() };
    });
    const samples = [0, 12, 40].map(t => els.map(el => {
      const effect = el.getAnimations()[0]!; effect.pause(); effect.currentTime = t;
      return new DOMMatrix(getComputedStyle(el).transform).m41;
    }));
    p.destroy(); rawExit.cancel(); rawEnter.cancel(); wrongEnter.cancel(); els.forEach(el => el.remove());
    return { plans, samples };
  });
  expect(result.plans[0]).toEqual(result.plans[1]);
  expect(result.plans[2]).not.toEqual(result.plans[1]);
  for (const sample of result.samples) expect(sample[0]).toBeCloseTo(sample[1]!, 6);
});
