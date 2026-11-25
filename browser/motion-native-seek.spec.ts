import { expect, test } from './fixtures/harness';

test('running native seek keeps the same effects, pose, and finished lifecycle', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate, playhead } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('div');
    root.innerHTML = '<div></div>'.repeat(12);
    document.body.append(root);
    const targets = [...root.children];
    const run = playhead(animate(targets, { x: [0, 100], opacity: [0, 1] }, { duration: 1000, delay: 100, ease: 'linear' }));
    const effects = targets.flatMap(el => el.getAnimations());
    try {
      await Promise.all(effects.map(effect => effect.ready));
      const samples = [];
      for (const time of [50, 300, 900, 200]) {
        run.seek(time);
        const current = targets.flatMap(el => el.getAnimations());
        const expected = Math.max(0, time - 100) / 1000;
        const error = Math.max(...targets.map(el => {
          const css = getComputedStyle(el);
          return Math.max(Math.abs(new DOMMatrixReadOnly(css.transform).m41 - expected * 100), Math.abs(Number(css.opacity) - expected) * 100);
        }));
        samples.push({ same: current.length === effects.length && current.every(effect => effects.includes(effect)), error });
      }
      run.seek(1100);
      const outcome = await run.finished;
      return { initial: effects.length, samples, outcome, remaining: targets.flatMap(el => el.getAnimations()).length,
        final: targets.every(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 === 100 && Number(getComputedStyle(el).opacity) === 1) };
    } finally { run.stop(); root.remove(); }
  });
  expect(result.initial).toBe(24);
  for (const sample of result.samples) {
    expect(sample.same).toBe(true);
    expect(sample.error).toBeLessThan(0.2);
  }
  expect(result.outcome).toEqual({ status: 'finished' });
  expect(result.remaining).toBe(0);
  expect(result.final).toBe(true);
});
