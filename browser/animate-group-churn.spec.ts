import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { test, expect } from './fixtures/harness';

const cookbook = readFileSync(new URL('../docs/recipes.md', import.meta.url), 'utf8');
const recipe = cookbook.match(/```typescript\n([^`]*?export function mountGroupMotion[^]*?)\n```/)?.[1];
if (!recipe) throw new Error('Отсутствует пример mountGroupMotion');
const source = transformSync(recipe, { loader: 'ts', format: 'esm', target: 'es2022' }).code;

for (const reduced of [false, true]) test(`массовая смена целей: один кадр и целая группа (reduce=${reduced})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const result = await page.evaluate(async ({ source, reduced }) => {
    const original = window.requestAnimationFrame;
    let queue: FrameRequestCallback[] = [], requests = 0;
    window.requestAnimationFrame = callback => { queue.push(callback); return ++requests; };
    const step = (time: number) => {
      const callbacks = queue; queue = [];
      for (const callback of callbacks) callback(time);
    };
    const root = document.createElement('section'); document.body.append(root);
    const items = Array.from({ length: 256 }, (_, id) => {
      const element = document.createElement('div');
      element.style.cssText = 'width:1px;height:1px;position:absolute';
      root.append(element);
      return { element, x: id + 10, y: id + 20 };
    });
    const url = URL.createObjectURL(new Blob([
      source.replaceAll('@labpics/motion/animate', location.origin + '/dist/animate/index.js'),
    ], { type: 'text/javascript' }));
    const { mountGroupMotion } = await import(url); URL.revokeObjectURL(url);
    const motion = mountGroupMotion(root);
    try {
      motion.move(items); step(0); step(120);
      const read = () => items.map(({ element }) => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform);
        return [matrix.m41, matrix.m42];
      });
      const middle = read();
      const requestsBefore = requests;
      for (let round = 0; round < 4; round++) {
        motion.move(items.map((item, id) => ({ ...item, x: 100 - id + round, y: 200 - id + round })));
      }
      const requestsDuring = requests - requestsBefore;
      const pending = queue.length;
      step(120); step(240); step(400);
      const final = read();
      motion.destroy(); step(800);
      const afterDestroy = requests;
      motion.move(items); step(1200);
      return { middle, final, requestsDuring, pending, lateRequests: requests - afterDestroy,
        remaining: queue.length, native: root.getAnimations({ subtree: true }).length, reduced };
    } finally {
      motion.destroy(); root.remove(); window.requestAnimationFrame = original;
    }
  }, { source, reduced });
  expect(result.requestsDuring).toBe(0);
  expect(result.pending).toBe(reduced ? 0 : 1);
  expect(result.remaining).toBe(0);
  expect(result.lateRequests).toBe(0);
  expect(result.native).toBe(0);
  for (let id = 0; id < 256; id++) {
    expect(result.middle[id]![0]).toBeCloseTo((id + 10) * (reduced ? 1 : 0.5), 5);
    expect(result.middle[id]![1]).toBeCloseTo((id + 20) * (reduced ? 1 : 0.5), 5);
    expect(result.final[id]![0]).toBeCloseTo(103 - id, 5);
    expect(result.final[id]![1]).toBeCloseTo(203 - id, 5);
  }
});
