import { expect, test } from './fixtures/harness';

for (const spring of [false, true]) test(`единый animate: геометрия и исходная шкала (spring=${spring})`, async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const result = await page.evaluate(async spring => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); el.style.cssText = 'width:40px;height:20px;transform-origin:0 0;opacity:0'; document.body.append(el);
    const options = spring ? { spring: { mass: 1, stiffness: 170, damping: 26 } } : { duration: 1000, ease: 'linear' as const };
    const c = animate(el, { x: [0, 200], rotate: [0, 720], opacity: [0, 1] }, options);
    const initial = el.getAnimations().length;
    const samples: Array<{ fraction: number; x: number; held: number; resumed: number }> = [];
    const x = () => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    try {
      for (const fraction of [.12, .7, .3, .85]) {
        c.seek(c.duration * fraction);
        for (const effect of el.getAnimations()) effect.pause();
        const before = x(); c.pause(); const held = x(); c.play();
        for (const effect of el.getAnimations()) effect.pause();
        samples.push({ fraction, x: before, held, resumed: x() });
      }
      c.finish(); const outcome = await c.finished;
      const final = { x: x(), opacity: Number(getComputedStyle(el).opacity), effects: el.getAnimations().length };
      return { initial, samples, outcome, final };
    } finally { c.stop(); el.remove(); }
  }, spring);
  // Разная допустимая точность translation/rotation оставляет их общей JS-группой.
  expect(result.initial).toBe(spring ? 1 : 2);
  expect(result.samples[0]!.x).toBeGreaterThan(0);
  for (const row of result.samples) {
    expect(Math.abs(row.x - row.held)).toBeLessThanOrEqual(.25);
    expect(Math.abs(row.x - row.resumed)).toBeLessThanOrEqual(.25);
    if (!spring) expect(row.x).toBeCloseTo(row.fraction * 200, 2);
  }
  expect(result.outcome).toEqual({ status: 'finished' });
  expect(result.final).toEqual({ x: 200, opacity: 1, effects: 0 });
});

test('перехват одной оси сохраняет другую; старый controller безопасно освобождается', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); el.style.cssText = 'width:30px;height:30px'; document.body.append(el);
    const first = animate(el, { x: [0, 100], opacity: [0, 1] }, { duration: 1000, ease: 'linear' });
    for (const effect of el.getAnimations()) { effect.pause(); effect.currentTime = 300; }
    const opacity = el.getAnimations().find(effect => (effect.effect as KeyframeEffect).getKeyframes()[0]!.opacity !== undefined)!;
    const second = animate(el, { x: 200 }, { duration: 1000, ease: 'linear' });
    for (const effect of el.getAnimations()) effect.pause();
    const atStart = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    first.stop();
    const alive = el.getAnimations().length;
    const same = animate(el, { x: 200 }, { duration: 1000, ease: 'linear' });
    second.stop(); same.finish(); await same.finished;
    const result = { atStart, alive, cancelledOpacity: opacity.playState === 'idle', first: await first.finished,
      second: await second.finished, remaining: el.getAnimations().length };
    el.remove(); return result;
  });
  expect(result.atStart).toBeCloseTo(30, 2); expect(result.alive).toBe(1);
  expect(result.first).toEqual({ status: 'stopped' }); expect(result.second).toEqual({ status: 'stopped' });
  expect(result.cancelledOpacity).toBe(true); expect(result.remaining).toBe(0);
});

for (const reduce of [false, true]) test(`компонент: список, события, значения и очистка (reduce=${reduce})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
  const result = await page.evaluate(async reduce => {
    const { scope } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('section'); root.innerHTML = '<button>Go</button>' + '<div class="item"></div>'.repeat(20); document.body.append(root);
    const area = scope(root); let calls = 0;
    area.on('button', 'click', () => { calls++; });
    const v = area.value(0); const scalar = v.animate(100, { duration: 1000 });
    const c = area.animate('.item', { x: [0, 100], opacity: [0, 1] }, { duration: 1000, stagger: 2 });
    root.querySelector('button')!.click();
    const initial = root.getAnimations({ subtree: true }).length;
    area.dispose(); root.querySelector('button')!.click();
    await Promise.all([scalar.finished, c.finished]); await Promise.resolve();
    const effects = root.getAnimations({ subtree: true }).length;
    const late = area.animate('.missing[', { get x(): number { throw new Error('late read'); } });
    const outcome = await late.finished; root.remove();
    return { initial, calls, effects, disposed: area.disposed, outcome };
  }, reduce);
  expect(result.initial).toBe(reduce ? 0 : 40); expect(result.calls).toBe(1); expect(result.effects).toBe(0);
  expect(result.disposed).toBe(true); expect(result.outcome).toEqual({ status: 'stopped' });
});

test('sequence: авторские массивы, относительное положение шагов и контролы', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { sequence } = await import('/browser/.artifacts/motion-root.js');
    const el = document.createElement('div'); el.style.cssText = 'width:240px;height:20px;opacity:0'; document.body.append(el);
    const c = sequence([
      [el, { x: [0, 100, -50, 0], width: [240, 300, 270, 360] }, { duration: 300, ease: 'linear' }],
      [el, { opacity: [0, 1] }, { at: '<', duration: 300, ease: 'linear' }],
      [el, { x: 200 }, { at: 400, duration: 200, ease: 'linear' }],
    ]);
    const sample = (t: number) => { c.pause(); c.seek(t); const style = getComputedStyle(el); return { t, x: new DOMMatrixReadOnly(style.transform).m41, width: Number.parseFloat(style.width), opacity: Number(style.opacity) }; };
    const rows = [100, 200, 150, 500, 50].map(sample); c.finish(); const outcome = await c.finished;
    const duration = c.duration; const remaining = el.getAnimations().length; el.remove(); return { rows, duration, outcome, remaining };
  });
  expect(result.duration).toBe(600);
  expect(result.rows.map(row => row.x)).toEqual([100, -50, 25, 100, 50]);
  expect(result.rows[0]!.width).toBe(300); expect(result.rows[3]!.width).toBe(360);
  expect(result.rows[0]!.opacity).toBeCloseTo(1 / 3, 3);
  expect(result.outcome).toEqual({ status: 'finished' }); expect(result.remaining).toBe(0);
});

test('layout: изменение приложения выполняется один раз и служебные эффекты уходят', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { layout } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('section'); root.style.cssText = 'width:120px;height:20px;background:blue'; document.body.append(root);
    let called = 0; const styles = document.querySelectorAll('style').length;
    const c = layout(root, () => { called++; root.style.width = '240px'; }, { duration: 80, ease: 'linear' });
    const outcome = await c.finished;
    const result = { called, width: getComputedStyle(root).width, outcome, state: c.state,
      styles: document.querySelectorAll('style').length - styles, name: root.style.viewTransitionName, effects: document.getAnimations().length };
    root.remove(); return result;
  });
  expect(result).toEqual({ called: 1, width: '240px', outcome: { status: 'finished' }, state: 'finished', styles: 0, name: '', effects: 0 });
});

test('layout: ошибка асинхронного обновления доступна потребителю и не оставляет стили', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { layout } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('div'); document.body.append(root); const count = document.querySelectorAll('style').length;
    const error = new Error('mutation error');
    const c = layout(root, async () => { throw error; }, { duration: 100 });
    let caught = false; try { await c.finished; } catch (e) { caught = e === error; }
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = { caught, state: c.state, styles: document.querySelectorAll('style').length - count, name: root.style.viewTransitionName };
    root.remove(); return result;
  });
  expect(result).toEqual({ caught: true, state: 'failed', styles: 0, name: '' });
});

test('layout: пауза до готовности сохраняет snapshot до явного завершения', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { layout } = await import('/browser/.artifacts/motion-root.js');
    const root = document.createElement('section'); root.style.cssText = 'width:80px;height:30px;background:blue'; document.body.append(root);
    const supported = typeof document.startViewTransition === 'function';
    const c = layout(root, () => { root.style.width = '320px'; }, { duration: 300, ease: 'linear' });
    c.pause();
    await new Promise(resolve => setTimeout(resolve, 600));
    const paused = c.state;
    const native = document.getAnimations().map(effect => ({ state: effect.playState, pseudo: (effect.effect as KeyframeEffect).pseudoElement }));
    c.seek(150); c.finish(); await c.finished;
    const after = document.getAnimations().length; root.remove(); return { supported, paused, native, after };
  });
  if (result.supported) {
    expect(result.paused).toBe('paused');
    expect(result.native.some(effect => effect.state === 'paused')).toBe(true);
  }
  expect(result.after).toBe(0);
});
