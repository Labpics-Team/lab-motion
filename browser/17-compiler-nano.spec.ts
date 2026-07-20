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
