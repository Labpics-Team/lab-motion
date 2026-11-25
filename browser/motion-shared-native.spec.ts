import { expect, test } from './fixtures/harness';

test('one parsed native shape serves a staggered timeline, preserving placement and independent effects', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('div'); root.innerHTML = '<div></div>'.repeat(24); document.body.append(root);
    const targets = [...root.children];
    const Original = window.KeyframeEffect;
    let templates = 0, clones = 0;
    window.KeyframeEffect = new Proxy(Original, {
      construct(target, args, newTarget) {
        if (args.length === 1) clones++; else templates++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    const run = animate(targets, { x: [0, 80, -20, 100] }, {
      duration: 600, times: [0, .2, .7, 1], ease: 'linear', stagger: 12,
    });
    try {
      const effects = targets.map(el => el.getAnimations()[0]!);
      await Promise.all(effects.map(effect => effect.ready));
      const delays = effects.map(effect => effect.effect!.getTiming().delay);
      const expected = (t: number) => t <= 0 ? 0 : t <= 120 ? 80 * t / 120 :
        t <= 420 ? 80 - 100 * (t - 120) / 300 : t < 600 ? -20 + 120 * (t - 420) / 180 : 100;
      let maxError = 0;
      for (const time of [80, 270, 510, 180]) {
        run.seek(time);
        for (let i = 0; i < targets.length; i++) {
          if (targets[i]!.getAnimations()[0] !== effects[i]) throw Error('effect replaced');
          maxError = Math.max(maxError, Math.abs(new DOMMatrixReadOnly(getComputedStyle(targets[i]!).transform).e - expected(time - 12 * i)));
        }
      }
      run.finish();
      return { templates, clones, distinct: new Set(effects).size, delays, maxError,
        finished: await run.finished, final: targets.every(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).e === 100),
        remaining: targets.flatMap(el => el.getAnimations()).length };
    } finally { run.stop(); window.KeyframeEffect = Original; root.remove(); }
  });
  expect(result.templates).toBe(1); expect(result.clones).toBe(23);
  expect(result.distinct).toBe(24); expect(result.delays).toEqual(Array.from({ length: 24 }, (_, i) => 12 * i));
  expect(result.maxError).toBeLessThan(.05); expect(result.finished).toEqual({ status: 'finished' });
  expect(result.final).toBe(true); expect(result.remaining).toBe(0);
});

test('shared instructions preserve different static poses and cannot stop a successor', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const elements = Array.from({ length: 12 }, (_, i) => {
      const el = document.createElement('div'); el.style.transform = 'translate(0px,' + (i % 3 * 7) + 'px)';
      document.body.append(el); return el;
    });
    const run = animate(elements, { x: [0, 100, 200] }, { duration: 400, ease: 'linear' });
    let successor;
    try {
      run.seek(200);
      const poses = elements.map(el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return [m.e, m.f]; });
      successor = animate(elements[0]!, { x: 300 }, { duration: 200, ease: 'linear' });
      run.stop();
      const independent = successor.state === 'running';
      successor.finish(); await successor.finished;
      return { poses, independent, x: new DOMMatrixReadOnly(getComputedStyle(elements[0]!).transform).e,
        remaining: elements.flatMap(el => el.getAnimations()).length };
    } finally { run.stop(); successor?.stop(); elements.forEach(el => el.remove()); }
  });
  for (let i = 0; i < result.poses.length; i++) {
    expect(result.poses[i]![0]).toBeCloseTo(100, 4); expect(result.poses[i]![1]).toBe(i % 3 * 7);
  }
  expect(result.independent).toBe(true); expect(result.x).toBe(300); expect(result.remaining).toBe(0);
});

test('native instruction instances remain in their own document timelines', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const frame = document.createElement('iframe'); document.body.append(frame);
    const docs = [document, frame.contentDocument!];
    const elements = docs.flatMap(doc => Array.from({ length: 4 }, () => { const el = doc.createElement('div'); doc.body.append(el); return el; }));
    const run = animate(elements, { x: [0, 100] }, { duration: 400, ease: 'linear' });
    try {
      const effects = elements.map(el => el.getAnimations()[0]!);
      const correct = effects.every((effect, i) => effect.timeline === elements[i]!.ownerDocument.timeline &&
        effect.effect instanceof elements[i]!.ownerDocument.defaultView!.KeyframeEffect);
      run.finish(); await run.finished;
      return { correct, final: elements.every(el => new DOMMatrixReadOnly(el.ownerDocument.defaultView!.getComputedStyle(el).transform).e === 100),
        remaining: elements.flatMap(el => el.getAnimations()).length };
    } finally { run.stop(); elements.forEach(el => el.remove()); frame.remove(); }
  });
  expect(result.correct).toBe(true); expect(result.final).toBe(true); expect(result.remaining).toBe(0);
});
