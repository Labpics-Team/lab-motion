import { expect, test } from './fixtures/harness';

test('native speed сохраняет тот же Animation и не создаёт собственных кадров', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate, playhead } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'), raw = document.createElement('div'); document.body.append(el, raw);
    const request = window.requestAnimationFrame; let frames = 0;
    window.requestAnimationFrame = callback => { frames++; return request.call(window, callback); };
    const run = playhead(animate(el, { x: [0, 100] }, { duration: 1000 }));
    const effect = el.getAnimations()[0]!;
    const control = raw.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(100px)' }], { duration: 1000, fill: 'both', easing: 'linear' });
    const x = (target: Element) => new DOMMatrixReadOnly(getComputedStyle(target).transform).m41;
    effect.pause(); control.pause(); await Promise.all([effect.ready, control.ready]);
    effect.currentTime = control.currentTime = 400;
    try {
      const samples = [];
      for (const rate of [2, .5, 1, 0, 3]) {
        run.timeScale = rate; control.updatePlaybackRate(rate); await Promise.all([effect.ready, control.ready]);
        samples.push({ time: run.time, requested: run.timeScale, native: effect.playbackRate,
          pose: x(el), reference: x(raw), same: el.getAnimations()[0] === effect });
      }
      run.finish(); await run.finished;
      return { samples, frames, remaining: el.getAnimations().length, final: x(el) };
    } finally { run.stop(); control.cancel(); window.requestAnimationFrame = request; el.remove(); raw.remove(); }
  });
  for (const row of result.samples) {
    expect(row.time).toBe(400); expect(row.requested).toBe(row.native);
    expect(row.pose).toBeCloseTo(row.reference, 3); expect(row.pose).toBeCloseTo(40, 3); expect(row.same).toBe(true);
  }
  expect(result.frames).toBe(0); expect(result.remaining).toBe(0); expect(result.final).toBe(100);
});

test('mixed native/main сохраняет позицию при speed, pause и reverse', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await page.evaluate(async () => {
    const { animate, playhead } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); el.style.width = '100px'; document.body.append(el);
    const run = playhead(animate(el, { x: [0, 100], width: [100, 200] }, { duration: 1000 }));
    run.seek(400); run.timeScale = 2;
    const effect = el.getAnimations()[0]!; effect.pause(); await effect.ready; effect.currentTime = 528;
    Object.assign(window, { transportTest: { el, run } });
  });
  await page.clock.runFor(64);
  const result = await page.evaluate(async () => {
    const { el, run } = (window as unknown as { transportTest: { el: HTMLElement; run: import('../src/motion/types.js').MotionPlayback } }).transportTest;
    try {
      run.pause();
      const style = getComputedStyle(el);
      const result = { x: new DOMMatrixReadOnly(style.transform).m41, width: Number.parseFloat(style.width), time: run.time };
      run.reverse(); run.seek(250); const paused = run.state, rate = run.timeScale;
      run.finish(); await run.finished;
      return { ...result, paused, rate, remaining: el.getAnimations().length };
    } finally { run.stop(); el.remove(); Reflect.deleteProperty(window, 'transportTest'); }
  });
  expect(result.time).toBe(528); expect(result.x).toBeCloseTo(52.8, 2);
  expect(result.width).toBeCloseTo(152.8, 1); expect(result.paused).toBe('paused'); expect(result.rate).toBe(-2);
  expect(result.remaining).toBe(0);
});

test('новый reverse не принимает поздний finished предыдущего направления', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate, playhead } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); document.body.append(el);
    const run = playhead(animate(el, { x: [0, 100] }, { duration: 1000 })); const effect = el.getAnimations()[0]!;
    try {
      effect.finish(); run.reverse(); await Promise.resolve(); const live = run.state;
      run.pause(); run.seek(500);
      const position = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
      run.stop(); const outcome = await run.finished;
      return { live, position, outcome, remaining: el.getAnimations().length };
    } finally { run.stop(); el.remove(); }
  });
  expect(result.live).toBe('running'); expect(result.position).toBeCloseTo(50, 2);
  expect(result.outcome).toEqual({ status: 'stopped' }); expect(result.remaining).toBe(0);
});

test('native → JS reverse достигает начала без зависимости от browser finished', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate, playhead } = await import('/browser/.artifacts/motion-root.js');
    for (const start of [100, 100.00000000000001, .001, 999.999]) {
      for (let iteration = 0; iteration < 4; iteration++) {
        const el = document.createElement('div'); document.body.append(el);
        const run = playhead(animate(el, { x: [0, 100] }, { duration: 1000 }));
        try {
          run.seek(start); run.reverse();
          if (el.getAnimations().length) throw Error('Обратный ход не передан JS');
          const outcome = await run.finished;
          if (outcome.status !== 'finished' || run.time !== 0 || new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 !== 0)
            throw Error('Нарушена конечная фаза');
        } finally { run.stop(); el.remove(); }
      }
    }
    return true;
  });
  expect(result).toBe(true);
});

test('reduced-motion завершён до поздних transport-команд', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { scope, playhead } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('div'); document.body.append(root); const area = scope(root);
    try {
      const run = playhead(area.animate(root, { x: [0, 100] }, { duration: 1000 })); await run.finished;
      run.timeScale = -1; run.reverse(); run.seek(10); run.play();
      return { state: run.state, time: run.time, duration: run.duration,
        x: new DOMMatrixReadOnly(getComputedStyle(root).transform).m41, effects: root.getAnimations().length };
    } finally { area.dispose(); root.remove(); }
  });
  expect(result).toEqual({ state: 'finished', time: 0, duration: 0, x: 100, effects: 0 });
});
