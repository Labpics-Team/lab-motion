import { expect, test } from './fixtures/harness';

for (const js of [false, true]) test(`translation сохраняет нетрансляционные оси (JS=${js})`, async ({ page }) => {
  const rows = await page.evaluate(async js => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const rows = [];
    for (const initial of ['none', 'rotate(30deg)', 'skewX(12deg)', 'skewY(-8deg)', 'scale(2,.5)', 'rotate(30deg) skew(12deg,-8deg) scale(2,.5)']) {
      const el = document.createElement('div');
      el.style.cssText = 'width:40px;height:20px;transform-origin:0 0';
      el.style.transform = initial; document.body.append(el);
      const read = () => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
      };
      const before = read();
      const run = animate(el, { x: [0, 200], y: [0, -100] }, { duration: 1000, ease: js ? (t: number) => t : 'linear' });
      try {
        const effects = el.getAnimations();
        if (js) { run.pause(); run.seek(250); }
        else { effects[0]!.pause(); effects[0]!.currentTime = 250; }
        const quarter = read();
        run.finish();
        rows.push({ initial, before, quarter, final: read(), effects: effects.length,
          outcome: await run.finished, remaining: el.getAnimations().length });
      } finally { run.stop(); el.remove(); }
    }
    return rows;
  }, js);
  for (const row of rows) {
    expect(row.effects, row.initial).toBe(js ? 0 : 1);
    for (const pose of [row.quarter, row.final]) {
      for (let i = 0; i < 4; i++) expect(pose[i], row.initial).toBeCloseTo(row.before[i]!, 4);
    }
    expect(row.quarter.slice(4), row.initial).toEqual([50, -25]);
    expect(row.final.slice(4), row.initial).toEqual([200, -100]);
    expect(row.outcome).toEqual({ status: 'finished' });
    expect(row.remaining).toBe(0);
  }
});

for (const js of [false, true]) for (const turn of [360, 720]) {
  test(`полные обороты сохраняют внутренние матрицы (JS=${js}, rotate=${turn})`, async ({ page }) => {
    const result = await page.evaluate(async ({ js, turn }) => {
      const { animate } = await import('/browser/.artifacts/motion-root.js');
      const el = document.createElement('div'); document.body.append(el);
      const run = animate(el, { x: [0, 80], y: [0, -40], rotate: [0, turn] }, {
        duration: 1000, ease: js ? (t: number) => t : 'linear',
      });
      try {
        const effects = el.getAnimations();
        if (js) run.pause(); else effects[0]!.pause();
        const rows = [.125, .25, .5, .75].map(fraction => {
          if (js) run.seek(fraction * 1000); else effects[0]!.currentTime = fraction * 1000;
          const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
          return { fraction, matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] };
        });
        run.finish();
        return { rows, effects: effects.length, outcome: await run.finished, remaining: el.getAnimations().length };
      } finally { run.stop(); el.remove(); }
    }, { js, turn });
    expect(result.effects).toBe(js ? 0 : 1);
    for (const row of result.rows) {
      const angle = turn * row.fraction * Math.PI / 180;
      const cosine = Math.cos(angle), sine = Math.sin(angle);
      const expected = [cosine, sine, -sine, cosine, 80 * row.fraction, -40 * row.fraction];
      for (let i = 0; i < expected.length; i++) expect(row.matrix[i], `t=${row.fraction}, component=${i}`).toBeCloseTo(expected[i]!, 4);
    }
    expect(result.outcome).toEqual({ status: 'finished' });
    expect(result.remaining).toBe(0);
  });
}

test('translation retarget и native→JS reverse сохраняют матрицу и нового владельца', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const result = await page.evaluate(async () => {
    const { animate, playhead } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); document.body.append(el);
    const read = () => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    };
    const options = { duration: 1000, ease: 'linear' as const };
    const first = animate(el, { x: [0, 200], y: [0, -100] }, options);
    const previousEffect = el.getAnimations()[0]!;
    previousEffect.pause(); previousEffect.currentTime = 250;
    const before = read();
    const next = playhead(animate(el, { x: 300, y: 50 }, options));
    try {
      const handoff = read(), effect = el.getAnimations()[0]!;
      effect.pause(); effect.currentTime = 400;
      const forward = read();
      first.seek(999); first.finish(); first.stop();
      const stale = read(), sameEffect = el.getAnimations()[0] === effect;
      next.reverse();
      const reversed = read(), reverseEffects = el.getAnimations().length, rate = next.timeScale;
      next.pause(); next.seek(250);
      const earlier = read();
      next.stop();
      return { before, handoff, forward, stale, sameEffect, reversed, reverseEffects, rate, earlier,
        previous: await first.finished, outcome: await next.finished, remaining: el.getAnimations().length };
    } finally { first.stop(); next.stop(); el.remove(); }
  });
  const expected = {
    before: [1, 0, 0, 1, 50, -25],
    handoff: [1, 0, 0, 1, 50, -25],
    forward: [1, 0, 0, 1, 150, 5],
    stale: [1, 0, 0, 1, 150, 5],
    reversed: [1, 0, 0, 1, 150, 5],
    earlier: [1, 0, 0, 1, 112.5, -6.25],
  };
  for (const key of ['before', 'handoff', 'forward', 'stale', 'reversed', 'earlier'] as const) {
    for (let i = 0; i < 6; i++) expect(result[key][i], `${key}, component=${i}`).toBeCloseTo(expected[key][i]!, 4);
  }
  expect(result.sameEffect).toBe(true); expect(result.reverseEffects).toBe(0); expect(result.rate).toBe(-1);
  expect(result.previous).toEqual({ status: 'stopped' }); expect(result.outcome).toEqual({ status: 'stopped' });
  expect(result.remaining).toBe(0);
});
