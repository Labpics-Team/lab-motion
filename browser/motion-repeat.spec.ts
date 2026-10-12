import { expect, test } from './fixtures/harness';

for (const repeatType of ['reverse', 'mirror'] as const) test('повтор ' + repeatType + ': native, JS и raw WAAPI имеют одинаковую шкалу', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const result = await page.evaluate(async repeatType => {
    const { animate, repeat } = await import('/browser/.artifacts/motion-root.js');
    const elements = Array.from({ length: 3 }, () => {
      const el = document.createElement('div'); el.style.cssText = 'width:10px;height:10px'; document.body.append(el); return el;
    });
    const [nativeTarget, fallbackTarget, controlTarget] = elements as [HTMLDivElement, HTMLDivElement, HTMLDivElement];
    const options = { duration: 100, delay: 10, ...repeat(2, { type: repeatType }) };
    const native = animate(nativeTarget, { x: [0, 100] }, options);
    const fallback = animate(fallbackTarget, { x: [0, 100] }, { ...options, ease: p => p });
    const nativeEffects = nativeTarget.getAnimations(), fallbackEffects = fallbackTarget.getAnimations();
    const effect = nativeEffects[0]!;
    const control = controlTarget.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(100px)' }], {
      duration: 100, delay: 10, iterations: 3, direction: 'alternate', fill: 'both', easing: 'linear',
    });
    effect.pause(); control.pause(); fallback.pause();
    const x = (el: Element) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    try {
      const rows = [0, 9, 10, 50, 109.999, 110, 110.001, 125, 209.999, 210, 225, 309.999].map(t => {
        effect.currentTime = t; control.currentTime = t; fallback.seek(t);
        return { t, native: x(nativeTarget), fallback: x(fallbackTarget), control: x(controlTarget) };
      });
      const sameEffect = nativeTarget.getAnimations()[0] === effect;
      native.finish(); fallback.finish(); control.cancel();
      await Promise.all([native.finished, fallback.finished]);
      return { rows, sameEffect, nativeCount: nativeEffects.length, fallbackCount: fallbackEffects.length,
        remaining: elements.reduce((n, el) => n + el.getAnimations().length, 0) };
    } finally { native.stop(); fallback.stop(); control.cancel(); elements.forEach(el => el.remove()); }
  }, repeatType);
  expect(result.nativeCount).toBe(1); expect(result.fallbackCount).toBe(0); expect(result.sameEffect).toBe(true);
  for (const row of result.rows) {
    expect(row.native, 'native @ ' + row.t).toBeCloseTo(row.control, 2);
    expect(row.fallback, 'fallback @ ' + row.t).toBeCloseTo(row.control, 2);
  }
  expect(result.remaining).toBe(0);
});

for (const repeatType of ['reverse', 'mirror'] as const) test('нелинейный ' + repeatType + ' и repeatDelay сохраняют разные значения', async ({ page }) => {
  const result = await page.evaluate(async repeatType => {
    const { animate, repeat } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); document.body.append(el);
    const run = animate(el, { x: [0, 100] }, { duration: 100, ...repeat(1, { delay: 20, type: repeatType }), ease: p => p * p });
    try {
      const effects = el.getAnimations().length;
      run.pause();
      const rows = [100, 110, 120, 145].map(t => { run.seek(t); return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; });
      run.finish(); await run.finished;
      return { rows, effects, remaining: el.getAnimations().length, final: new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 };
    } finally { run.stop(); el.remove(); }
  }, repeatType);
  expect(result.effects).toBe(0);
  expect(result.rows.slice(0, 3)).toEqual([100, 100, 100]);
  expect(result.rows[3]).toBeCloseTo(repeatType === 'reverse' ? 56.25 : 93.75, 2);
  expect(result.remaining).toBe(0); expect(result.final).toBe(0);
});

test('scope применяет повтор к последовательности, освобождает infinite и не повторяет layout mutation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { scope, repeat } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('section'); el.innerHTML = '<div class="item"></div>'; document.body.append(el);
    const area = scope(el, { ...repeat(Infinity), duration: 100 });
    let mutations = 0;
    const loop = area.animate('.item', { x: [0, 100] });
    const series = area.sequence([['.item', { x: [0, 100] }, { duration: 100 }]]);
    const change = area.layout(() => { mutations++; el.style.width = '100px'; });
    try {
      await Promise.all([loop.finished, series.finished, change.finished]);
      area.dispose();
      return { mutations, duration: [loop.duration, series.duration], effects: el.getAnimations({ subtree: true }).length,
        value: new DOMMatrixReadOnly(getComputedStyle(el.firstElementChild!).transform).m41 };
    } finally { area.dispose(); el.remove(); }
  });
  expect(result).toEqual({ mutations: 1, duration: [0, 0], effects: 0, value: 100 });
});

test('разрывный loop сохраняет полузакрытые границы независимо от округления WAAPI', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate, repeat } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); document.body.append(el);
    const run = animate(el, { x: [0, 100] }, { duration: 100, delay: 10, ...repeat(2) });
    try {
      const effects = el.getAnimations().length;
      run.pause();
      const rows = [109.999, 110, 110.001, 209.999, 210, 210.001].map(t => {
        run.seek(t); return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
      });
      run.finish(); await run.finished;
      return { effects, rows, remaining: el.getAnimations().length };
    } finally { run.stop(); el.remove(); }
  });
  expect(result.effects).toBe(0);
  for (const [i, expected] of [99.999, 0, .001, 99.999, 0, .001].entries()) expect(result.rows[i]).toBeCloseTo(expected, 3);
  expect(result.remaining).toBe(0);
});
