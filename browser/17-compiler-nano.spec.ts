/**
 * 17-compiler-nano.spec.ts — browser-differential приёмки компилятора (#208).
 *
 * Один fixture `animate(el, { opacity: 0.5 })` собран реальным Vite дважды
 * (globalSetup compile-artifacts.mjs): compiled — с плагином motionCompiler()
 * (precomputed-артефакт + приватный executor, БЕЗ spring-solver), uncompiled —
 * рантаймовый nano (springLinear в браузере). Оба бандла грузятся по http и
 * прогоняются в РЕАЛЬНОМ движке (chromium/firefox/webkit). Спека доказывает, что
 * lowering не меняет наблюдаемое: opacity-траектория, длительность и easing
 * идентичны на всей сетке времени. Семплирование детерминировано через
 * Animation.currentTime (pause + явный currentTime), без wall-clock (критерий
 * приёмки #102). Байтовую элиминацию solver/parser стережёт node-гейт
 * scripts/compiler-acceptance.mjs; здесь — рендер-эквивалентность на движке.
 */

import { expect, test } from './fixtures/harness';

const COMPILED = '/browser/.artifacts/compiled.js';
const UNCOMPILED = '/browser/.artifacts/uncompiled.js';

test('compiled и uncompiled дают идентичную opacity-траекторию на движке', async ({ page }) => {
  const result = await page.evaluate(async ([compiledUrl, uncompiledUrl]) => {
    const [{ play: playCompiled }, { play: playUncompiled }] = await Promise.all([
      import(compiledUrl) as Promise<{ play: (el: Element) => Animation[] }>,
      import(uncompiledUrl) as Promise<{ play: (el: Element) => Animation[] }>,
    ]);
    const make = (): HTMLElement => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      return el;
    };
    const elCompiled = make();
    const elUncompiled = make();

    const animCompiled = playCompiled(elCompiled)[0]!;
    const animUncompiled = playUncompiled(elUncompiled)[0]!;
    animCompiled.pause();
    animUncompiled.pause();

    const timingCompiled = animCompiled.effect!.getTiming();
    const timingUncompiled = animUncompiled.effect!.getTiming();
    const duration = Number(timingUncompiled.duration);

    // Сетка currentTime: 0 → duration; opacity читается из движка на каждой точке
    // для ОБОИХ путей при ОДИНАКОВОМ currentTime.
    const samples: { t: number; compiled: number; uncompiled: number }[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = (duration * i) / 10;
      animCompiled.currentTime = t;
      animUncompiled.currentTime = t;
      samples.push({
        t,
        compiled: Number.parseFloat(getComputedStyle(elCompiled).opacity),
        uncompiled: Number.parseFloat(getComputedStyle(elUncompiled).opacity),
      });
    }

    animCompiled.finish();
    animUncompiled.finish();
    await Promise.all([animCompiled.finished, animUncompiled.finished]);
    const finalCompiled = Number.parseFloat(getComputedStyle(elCompiled).opacity);
    const finalUncompiled = Number.parseFloat(getComputedStyle(elUncompiled).opacity);

    elCompiled.remove();
    elUncompiled.remove();
    return {
      samples,
      durationCompiled: Number(timingCompiled.duration),
      durationUncompiled: Number(timingUncompiled.duration),
      easingCompiled: String(timingCompiled.easing),
      easingUncompiled: String(timingUncompiled.easing),
      finalCompiled,
      finalUncompiled,
    };
  }, [COMPILED, UNCOMPILED] as const);

  // Длительность и easing precomputed-артефакта обязаны совпасть с рантаймовым
  // nano бит-в-бит: это end-to-end проверка корректности precompute на движке.
  expect(Math.abs(result.durationCompiled - result.durationUncompiled)).toBeLessThanOrEqual(1e-6);
  expect(result.easingCompiled).toBe(result.easingUncompiled);
  expect(result.easingCompiled).toContain('linear(');

  // Траектория идентична на всей сетке. Оба пути кормят WAAPI одинаковыми
  // keyframes+timing, поэтому расхождение допустимо лишь в пределах округления
  // движком computed opacity.
  for (const sample of result.samples) {
    expect(
      Math.abs(sample.compiled - sample.uncompiled),
      `opacity расходится при t=${sample.t}: compiled=${sample.compiled} uncompiled=${sample.uncompiled}`,
    ).toBeLessThanOrEqual(0.001);
  }

  // Контроль не-тривиальности: траектория реально анимирует 1 → 0.5, а не
  // сравнивает два no-op (иначе идентичность ничего не значит).
  const first = result.samples[0]!;
  const last = result.samples[result.samples.length - 1]!;
  expect(first.uncompiled).toBeGreaterThan(0.9);
  expect(last.uncompiled).toBeLessThanOrEqual(0.51);

  // Финал зафиксирован commitStyles на обоих путях.
  expect(Math.abs(result.finalCompiled - 0.5)).toBeLessThanOrEqual(0.001);
  expect(Math.abs(result.finalUncompiled - 0.5)).toBeLessThanOrEqual(0.001);
});

test('common-motion (#221): multi-prop кадр + delay/stagger идентичны по группе', async ({ page }) => {
  const result = await page.evaluate(async ([compiledUrl, uncompiledUrl]) => {
    const [{ play: playCompiled }, { play: playUncompiled }] = await Promise.all([
      import(compiledUrl) as Promise<{ play: (els: Element[]) => Animation[] }>,
      import(uncompiledUrl) as Promise<{ play: (els: Element[]) => Animation[] }>,
    ]);
    const group = (): HTMLElement[] => [0, 1].map(() => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      return el;
    });
    const elsCompiled = group();
    const elsUncompiled = group();
    const animsCompiled = playCompiled(elsCompiled);
    const animsUncompiled = playUncompiled(elsUncompiled);
    for (const anim of [...animsCompiled, ...animsUncompiled]) anim.pause();

    const timings = [0, 1].map((i) => ({
      compiled: animsCompiled[i]!.effect!.getTiming(),
      uncompiled: animsUncompiled[i]!.effect!.getTiming(),
    }));
    const duration = Number(timings[0]!.uncompiled.duration);
    const horizon = 40 + 20 + duration; // maxDelay + duration

    // Одинаковый АБСОЛЮТНЫЙ currentTime всем: пары compiled/uncompiled обязаны
    // совпадать поэлементно (delay+stagger включены в сравнение фаз).
    const samples: Array<{ t: number; index: number; compiled: string; uncompiled: string }> = [];
    for (let s = 0; s <= 8; s++) {
      const t = (horizon * s) / 8;
      for (const anim of [...animsCompiled, ...animsUncompiled]) anim.currentTime = t;
      for (const index of [0, 1]) {
        samples.push({
          t,
          index,
          compiled: `${getComputedStyle(elsCompiled[index]!).opacity}|${getComputedStyle(elsCompiled[index]!).translate}|${getComputedStyle(elsCompiled[index]!).scale}|${getComputedStyle(elsCompiled[index]!).rotate}`,
          uncompiled: `${getComputedStyle(elsUncompiled[index]!).opacity}|${getComputedStyle(elsUncompiled[index]!).translate}|${getComputedStyle(elsUncompiled[index]!).scale}|${getComputedStyle(elsUncompiled[index]!).rotate}`,
        });
      }
    }
    for (const anim of [...animsCompiled, ...animsUncompiled]) anim.finish();
    await Promise.all([...animsCompiled, ...animsUncompiled].map((a) => a.finished));
    const finals = [0, 1].map((i) => ({
      compiled: `${getComputedStyle(elsCompiled[i]!).opacity}|${getComputedStyle(elsCompiled[i]!).translate}`,
      uncompiled: `${getComputedStyle(elsUncompiled[i]!).opacity}|${getComputedStyle(elsUncompiled[i]!).translate}`,
    }));
    for (const el of [...elsCompiled, ...elsUncompiled]) el.remove();
    return {
      samples,
      finals,
      delays: timings.map((t) => ({
        compiled: Number(t.compiled.delay),
        uncompiled: Number(t.uncompiled.delay),
      })),
      durationParity: timings.every(
        (t) => Math.abs(Number(t.compiled.duration) - Number(t.uncompiled.duration)) <= 1e-6,
      ),
      easingParity: timings.every((t) => String(t.compiled.easing) === String(t.uncompiled.easing)),
      moved: samples.some((s) => s.uncompiled.includes('120px')),
    };
  }, ['/browser/.artifacts/compiled-common.js', '/browser/.artifacts/uncompiled-common.js'] as const);

  // Каскад: delay = 40 + 20·index на ОБОИХ путях.
  expect(result.delays[0]).toEqual({ compiled: 40, uncompiled: 40 });
  expect(result.delays[1]).toEqual({ compiled: 60, uncompiled: 60 });
  expect(result.durationParity).toBe(true);
  expect(result.easingParity).toBe(true);
  // Поэлементный паритет вычисленных opacity/translate/scale/rotate на всей сетке.
  for (const sample of result.samples) {
    expect(sample.compiled, `t=${sample.t} index=${sample.index}`).toBe(sample.uncompiled);
  }
  for (const final of result.finals) {
    expect(final.compiled).toBe(final.uncompiled);
  }
  // Контроль не-тривиальности: translate реально доехал до 120px.
  expect(result.moved).toBe(true);
});

test('compiled и uncompiled одинаково схлопывают анимацию под reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async ([compiledUrl, uncompiledUrl]) => {
    const [{ play: playCompiled }, { play: playUncompiled }] = await Promise.all([
      import(compiledUrl) as Promise<{ play: (el: Element) => Animation[] }>,
      import(uncompiledUrl) as Promise<{ play: (el: Element) => Animation[] }>,
    ]);
    const run = (play: (el: Element) => Animation[]) => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const anim = play(el)[0]!;
      const timing = anim.effect!.getTiming();
      anim.finish();
      const opacity = Number.parseFloat(getComputedStyle(el).opacity);
      el.remove();
      return { duration: Number(timing.duration), opacity };
    };
    return { compiled: run(playCompiled), uncompiled: run(playUncompiled) };
  }, [COMPILED, UNCOMPILED] as const);

  // Обе ветки читают matchMedia в момент вызова и схлопывают duration к 0.
  expect(result.compiled.duration).toBe(0);
  expect(result.uncompiled.duration).toBe(0);
  expect(Math.abs(result.compiled.opacity - 0.5)).toBeLessThanOrEqual(0.001);
  expect(Math.abs(result.uncompiled.opacity - 0.5)).toBeLessThanOrEqual(0.001);
});
