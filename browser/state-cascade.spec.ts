import { expect, test } from './fixtures/harness';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

test('каскад → MotionValue → DOM: последний target, скрытые обновления и cleanup', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createStateCascade } = await import('/dist/behaviors/index.js');
    const { MotionValue } = await import('/dist/index.js');
    const element = document.createElement('div');
    document.body.append(element);
    const frames: Array<(ts?: number) => void> = [];
    const drain = () => {
      let steps = 0;
      while (frames.length) {
        if (++steps > 10000) throw new Error('MotionValue failed to settle');
        frames.shift()!(); // Штатный timestamp-free virtual clock, не wall-clock sleep.
      }
    };
    const value = new MotionValue({
      initial: 0, spring: { mass: 1, stiffness: 170, damping: 26 },
      requestFrame(cb) { frames.push(cb); return 1; },
    });
    const state = createStateCascade<{ x: number }>();
    const base = state.createLayer({ x: 0 });
    const press = state.createLayer();
    const targets: number[] = [];
    let writes = 0;
    value.onChange(x => { writes++; element.style.transform = `translateX(${x}px)`; });
    state.subscribe(({ changed }) => { if (changed.x === 1) press.set({ x: 2 }); });
    state.subscribe(({ changed }) => {
      if (changed.x !== undefined) { targets.push(changed.x); value.setTarget(changed.x); }
    });
    try {
      press.set({ x: 1 });
      for (let i = 1; i <= 1000; i++) base.set({ x: i });
      const visibleTargets = targets.slice();
      drain();
      const pressed = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
      press.clear();
      drain();
      const released = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
      press.set({ x: 9 }); // Остался scheduled callback, он не должен писать после cleanup.
      state.destroy();
      value.destroy();
      const before = writes;
      base.set({ x: 7 });
      drain();
      return { visibleTargets, pressed, released, afterDestroyWrites: writes - before };
    } finally {
      state.destroy();
      value.destroy();
      element.remove();
    }
  });
  expect(result.visibleTargets).toEqual([1, 2]);
  expect(result.pressed).toBe(2);
  expect(result.released).toBe(1000);
  expect(result.afterDestroyWrites).toBe(0);
});

test('browser built artifact: FIFO, observer errors и destroy во время доставки', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createStateCascade } = await import('/dist/behaviors/index.js');
    const state = createStateCascade<{ x: number }>();
    const layer = state.createLayer();
    const failure = new Error('observer failure');
    const seen: number[] = [];
    state.subscribe(({ changed }) => {
      if (changed.x === 1) { layer.set({ x: 2 }); throw failure; }
      if (changed.x === 3) state.destroy();
    });
    state.subscribe(({ changed }) => { seen.push(changed.x!); });
    let preserved = false;
    try { layer.set({ x: 1 }); } catch (error) { preserved = error === failure; }
    const latest = state.get('x');
    layer.set({ x: 3 });
    return { seen, preserved, latest, active: layer.active, keys: Object.keys(state.snapshot()) };
  });
  expect(result.seen).toEqual([1, 2]);
  expect(result.preserved).toBe(true);
  expect(result.latest).toBe(2);
  expect(result.active).toBe(false);
  expect(result.keys).toEqual([]);
});


test('документированный адаптер: real reduced-motion, press ownership и возврат inline style', async ({ page }) => {
  const docs = readFileSync(new URL('../docs/recipes.md', import.meta.url), 'utf8');
  const section = docs.split('## Каскад состояний взаимодействия без гонок')[1]!;
  const source = section.split('```ts\n')[1]!.split('```')[0]!;
  const code = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async (compiled) => {
    const module = compiled
      .replace('"@labpics/motion"', JSON.stringify(`${location.origin}/dist/index.js`))
      .replace('"@labpics/motion/behaviors"', JSON.stringify(`${location.origin}/dist/behaviors/index.js`));
    const url = URL.createObjectURL(new Blob([module], { type: 'text/javascript' }));
    const element = document.createElement('div');
    element.style.setProperty('scale', '1.2', 'important');
    document.body.append(element);
    try {
      const { bindInteractionScale } = await import(url);
      const controls = bindInteractionScale(element);
      const values = [Number(getComputedStyle(element).scale)];
      controls.setHovered(true);
      values.push(Number(getComputedStyle(element).scale));
      controls.setPressed(true);
      controls.setHovered(false);
      values.push(Number(getComputedStyle(element).scale));
      controls.setPressed(false);
      values.push(Number(getComputedStyle(element).scale));
      controls.destroy();
      controls.destroy();
      controls.setHovered(true);
      return { values, restored: element.style.getPropertyValue('scale'), priority: element.style.getPropertyPriority('scale') };
    } finally {
      element.remove();
      URL.revokeObjectURL(url);
    }
  }, code);
  expect(result.values).toEqual([1, 1.03, 0.97, 1]);
  expect(result.restored).toBe('1.2');
  expect(result.priority).toBe('important');
});
