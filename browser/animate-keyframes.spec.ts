import { test, expect } from './fixtures/harness';

for (const n of [3, 4, 11]) {
  test(`N=${n}: настоящий native track совпадает с raw WAAPI и main sampler`, async ({ page }) => {
    const result = await page.evaluate(async n => {
      const { animate } = await import('/dist/animate/index.js');
      const elements = Array.from({ length: 3 }, () => document.createElement('div'));
      document.body.append(...elements);
      const [native, main, raw] = elements as [HTMLDivElement, HTMLDivElement, HTMLDivElement];
      const times = Array.from({ length: n }, (_, i) => (i / (n - 1)) ** 2);
      const values = times.map((_, i) => i % 2 ? 100 : 0);
      const opacities = values.map(x => .2 + x / 125);
      const props = { x: values, opacity: opacities };
      const requestFrame = window.requestAnimationFrame;
      let frames = 0;
      window.requestAnimationFrame = () => { frames++; return 1; };
      const a = animate(native, props, { duration: 1000, times, setTimer: () => () => {} });
      window.requestAnimationFrame = requestFrame;
      const nativeEffects = native.getAnimations();
      for (const effect of nativeEffects) effect.pause();
      const b = animate(main, props, { duration: 1000, times, requestFrame: () => 1 });
      const control = raw.animate(times.map((offset, i) => ({ offset, transform: `translateX(${values[i]}px)`, opacity: opacities[i]! })), { duration: 1000, fill: 'both', easing: 'linear' });
      control.pause();
      const errors: number[][] = [];
      for (const time of [0, 31, 125, 249, 250, 499, 500, 749, 900, 999]) {
        for (const effect of nativeEffects) effect.currentTime = time;
        control.currentTime = time;
        b.seek(time);
        const read = (el: Element) => {
          const style = getComputedStyle(el);
          return [new DOMMatrixReadOnly(style.transform).m41, Number(style.opacity)];
        };
        const av = read(native), bv = read(main), rv = read(raw);
        errors.push([Math.abs(av[0]! - bv[0]!), Math.abs(av[0]! - rv[0]!), Math.abs(av[1]! - bv[1]!), Math.abs(av[1]! - rv[1]!)]);
      }
      a.cancel(); b.cancel(); control.cancel();
      await Promise.all([a.finished, b.finished]);
      const remaining = elements.map(el => el.getAnimations().length);
      for (const el of elements) el.remove();
      return { count: nativeEffects.length, frames, errors, remaining };
    }, n);
    expect(result.count).toBe(2); // transform + opacity, не отдельный effect на stop.
    expect(result.frames).toBe(0);
    expect(result.remaining).toEqual([0, 0, 0]);
    // Сравниваются CSSOM-строки: это допуск их сериализации, не solver tolerance.
    for (const [mainX, rawX, mainOpacity, rawOpacity] of result.errors) {
      expect(mainX).toBeLessThanOrEqual(.001);
      expect(rawX).toBeLessThanOrEqual(.001);
      expect(mainOpacity).toBeLessThanOrEqual(.000001);
      expect(rawOpacity).toBeLessThanOrEqual(.000001);
    }
  });
}

test('function easing и duplicate times остаются точным main path на WAAPI-host', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div'); document.body.append(el);
    const original = window.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    window.requestAnimationFrame = cb => callbacks.push(cb);
    try {
      const c = animate(el, { x: [0, 10, 40, 200] }, { duration: 1000, times: [0, .25, .25, 1], ease: t => t * t });
      const nativeCount = el.getAnimations().length;
      c.seek(250); const jump = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
      c.seek(625); const middle = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
      c.cancel(); await c.finished; const terminal = el.style.transform;
      for (const cb of callbacks.splice(0)) cb(900);
      return { nativeCount, jump, middle, terminal, afterStale: el.style.transform };
    } finally { window.requestAnimationFrame = original; el.remove(); }
  });
  expect(result.nativeCount).toBe(0);
  expect(result.jump).toBe(40);
  expect(result.middle).toBe(80);
  expect(result.afterStale).toBe(result.terminal);
});

test('native pause/seek/play сохраняют исходную многоточечную траекторию и terminal lifecycle', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div'); document.body.append(el);
    const timers = new Set<() => void>(); let completed = 0;
    const c = animate(el, { x: [0, 100, 0] }, { duration: 1000, delay: 100, now: () => 0,
      setTimer: cb => { timers.add(cb); return () => { timers.delete(cb); }; }, onComplete: () => { completed++; } });
    const first = el.getAnimations()[0]!; first.pause(); first.currentTime = 350;
    const x = () => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    c.pause(); const paused = [x(), el.getAnimations().length];
    c.seek(750); const sought = x(); c.play(); const second = el.getAnimations()[0]!;
    second.pause(); second.currentTime = 0; const resumed = x();
    second.currentTime = 100; const advanced = x(); c.pause(); const held = x();
    c.seek(1000); await c.finished;
    const end = { x: x(), effects: el.getAnimations().length, timers: timers.size, completed };
    c.play(); c.seek(10); c.stop(); const noReplay = el.getAnimations().length;
    el.remove(); return { paused, sought, resumed, advanced, held, end, noReplay };
  });
  expect(result.paused).toEqual([50, 0]);
  expect(result.sought).toBe(50); expect(result.resumed).toBe(50);
  expect(result.advanced).toBeCloseTo(30, 5); expect(result.held).toBeCloseTo(30, 5);
  expect(result.end).toEqual({ x: 0, effects: 0, timers: 0, completed: 1 });
  expect(result.noReplay).toBe(0);
});

test('native N-track → spring наследует фактическую скорость сегмента', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div'); document.body.append(el);
    let oldComplete = 0;
    const old = animate(el, { x: [0, 100, 0] }, { duration: 1000, setTimer: () => () => {}, onComplete: () => { oldComplete++; } });
    const native = el.getAnimations()[0]!; native.pause(); native.currentTime = 250;
    let queue: Array<(t?: number) => void> = [];
    const next = animate(el, { x: 200 }, { spring: { mass: 1, stiffness: 100, damping: 20 }, requestFrame: cb => queue.push(cb) });
    const actual: number[] = [];
    for (const t of [0, 40, 80]) {
      const current = queue; queue = []; for (const cb of current) cb(t);
      actual.push(new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
    }
    await old.finished; next.cancel(); await next.finished;
    const before = el.style.transform;
    for (const cb of queue) cb(1000);
    const stable = before === el.style.transform;
    el.remove(); return { actual, oldComplete, stable };
  });
  // Независимое решение критического ОДУ: x0=50, v0=200px/s, goal=200.
  const expected = [0, .04, .08].map(t => 200 + (-150 - 1300 * t) * Math.exp(-10 * t));
  for (let i = 0; i < expected.length; i++) expect(Math.abs(result.actual[i]! - expected[i]!)).toBeLessThan(.001);
  expect(result.oldComplete).toBe(0); expect(result.stable).toBe(true);
});

test('N-track reduced motion не читает native capability и не резервирует кадр', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div'); document.body.append(el);
    let capabilityReads = 0, frames = 0, complete = 0;
    Object.defineProperty(el, 'animate', { get() { capabilityReads++; throw Error('native forbidden'); } });
    const original = window.requestAnimationFrame; window.requestAnimationFrame = () => { frames++; return 1; };
    try {
      const c = animate(el, { x: [0, 100, 30], opacity: [.2, 1, .8] }, { duration: 1000, delay: 500, onComplete: () => { complete++; } });
      await c.finished;
      const value = { x: new DOMMatrixReadOnly(getComputedStyle(el).transform).m41, opacity: Number(getComputedStyle(el).opacity) };
      return { capabilityReads, frames, complete, value };
    } finally { window.requestAnimationFrame = original; el.remove(); }
  });
  expect(result).toEqual({ capabilityReads: 0, frames: 0, complete: 1, value: { x: 30, opacity: .8 } });
});

test('пример акцента исполняется прямо из docs: движение, повтор, cancel, reduced', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = '/browser/.artifacts/keyframe-recipe.js';
    const { playAttention } = await import(path);
    const button = document.createElement('button'); document.body.append(button);
    const first = playAttention(button); const effects = button.getAnimations();
    for (const effect of effects) { effect.pause(); effect.currentTime = 90; }
    const x = new DOMMatrixReadOnly(getComputedStyle(button).transform).m41;
    const second = playAttention(button); await first.finished;
    const replayCount = button.getAnimations().length;
    second.cancel(); await second.finished;
    const remaining = button.getAnimations().length;
    button.remove(); return { count: effects.length, x, replayCount, remaining };
  });
  expect(result).toEqual({ count: 2, x: -12, replayCount: 2, remaining: 0 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(async () => {
    const path = '/browser/.artifacts/keyframe-recipe.js'; const { playAttention } = await import(path);
    const button = document.createElement('button'); document.body.append(button);
    await playAttention(button).finished;
    const result = { effects: button.getAnimations().length, x: new DOMMatrixReadOnly(getComputedStyle(button).transform).m41, opacity: Number(getComputedStyle(button).opacity) };
    button.remove(); return result;
  });
  expect(reduced).toEqual({ effects: 0, x: 0, opacity: 1 });
});
