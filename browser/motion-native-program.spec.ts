import { expect, test } from './fixtures/harness';

test('authored native program uses one effect per surface, preserves offsets, ownership and cleanup', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate, playhead } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); document.body.append(el);
    const run = playhead(animate(el, { x: [0, 80, -20, 100], y: [0, 40, -10, 50] }, {
      duration: 600, delay: 100, times: [0, .2, .7, 1], ease: 'linear',
    }));
    try {
      const effect = el.getAnimations()[0]!;
      if (!effect) throw Error('expected native effect');
      await effect.ready;
      const samples = [];
      for (const [time, expected] of [[50, 0], [160, 40], [220, 80], [370, 30], [520, -20], [610, 40], [160, 40]]) {
        run.seek(time!);
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        samples.push({ error: Math.max(Math.abs(m.m41 - expected!), Math.abs(m.m42 - expected! / 2)), same: el.getAnimations()[0] === effect });
      }
      run.pause(); run.seek(370);
      const next = animate(el, { x: [30, 200] }, { duration: 100, ease: 'linear' });
      run.finish(); next.finish();
      const final = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { samples, x: final.m41, y: final.m42, old: await run.finished, next: await next.finished, remaining: el.getAnimations().length };
    } finally { run.stop(); el.remove(); }
  });
  for (const s of result.samples) { expect(s.same).toBe(true); expect(s.error).toBeLessThan(.2); }
  expect(result.x).toBe(200); expect(result.y).toBe(50);
  expect(result.old.status).toBe('stopped'); expect(result.next.status).toBe('finished'); expect(result.remaining).toBe(0);
});

test('sequence native projection preserves idle gaps and terminal holds; jumps stay numerical', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { sequence, animate } = await import('/browser/.artifacts/motion-root.js');
    const a = document.createElement('div'), b = document.createElement('div');
    document.body.append(a, b);
    const linear = { duration: 100, ease: 'linear' as const };
    const run = sequence([
      [a, { x: [0, 100] }, linear],
      [a, { x: 200 }, { ...linear, at: 200 }],
      [b, { opacity: [0, 1] }, { ...linear, at: 300 }],
    ]);
    try {
      const effects = [...a.getAnimations(), ...b.getAnimations()];
      await Promise.all(effects.map(e => e.ready));
      const samples = [];
      for (const t of [50, 150, 250, 350, 50]) {
        run.seek(t);
        samples.push(new DOMMatrixReadOnly(getComputedStyle(a).transform).m41);
      }
      run.finish();
      const outcome = await run.finished;
      const discontinuous = sequence([[a, { x: [0, 100] }, linear], [a, { x: [300, 400] }, linear]]);
      const jumpEffects = a.getAnimations().length;
      discontinuous.seek(100); const jump = new DOMMatrixReadOnly(getComputedStyle(a).transform).m41;
      discontinuous.finish(); await discontinuous.finished;
      const custom = animate(a, { x: [0, 100, 200] }, { duration: 100, ease: t => t });
      const customEffects = a.getAnimations().length;
      custom.finish(); await custom.finished;
      return { count: effects.length, samples, outcome, jumpEffects, jump, customEffects, remaining: a.getAnimations().length + b.getAnimations().length };
    } finally { run.stop(); a.remove(); b.remove(); }
  });
  expect(result.count).toBe(2);
  for (const [i, value] of [50, 100, 150, 200, 50].entries()) expect(result.samples[i]).toBeCloseTo(value, 1);
  expect(result.outcome.status).toBe('finished'); expect(result.jumpEffects).toBe(0);
  expect(result.jump).toBe(300); expect(result.customEffects).toBe(0); expect(result.remaining).toBe(0);
});
