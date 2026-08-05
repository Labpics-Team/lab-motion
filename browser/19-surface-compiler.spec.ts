/**
 * 19-surface-compiler.spec.ts — browser-differential приёмки surface lowering
 * на ВСЕЙ матрице движков (chromium/firefox/webkit): критика «Chromium-first»
 * закрывается тем, что контракт Future Layout проверяется движками напрямую,
 * а не выводом из Chromium-наблюдений.
 *
 * Fixture `animate(el, { width: [240, 360] }, { layout: 'project' })` собран
 * реальным Vite дважды (globalSetup compile-artifacts.mjs): surface-compiled —
 * с плагином (вызов заменён executor-вызовом с литеральным build-time
 * сертифицированным артефактом, БЕЗ solver/parser/full facade в графе),
 * surface-uncompiled — полный runtime path. Спека доказывает на каждом движке:
 *   1. Compiled и runtime пути доставляют одинаковый наблюдаемый финал
 *      (360 px, finished, отсутствие residual-стилей псевдодерева).
 *   2. Compiled list-путь (не-Element target) исполняется WAAPI движка с
 *      артефактными keyframes/easing; семплирование детерминировано через
 *      Animation.currentTime (pause + явный currentTime), без wall-clock.
 *   3. Reduced motion схлопывает compiled-путь к мгновенному коммиту 360 px.
 * Байтовую элиминацию solver/parser стережёт scripts/compiler-acceptance.mjs;
 * здесь — рендер-эквивалентность на движке.
 */

import { expect, test } from './fixtures/harness';

const COMPILED = '/browser/.artifacts/surface-compiled.js';
const UNCOMPILED = '/browser/.artifacts/surface-uncompiled.js';

interface SurfaceControlsLike {
  readonly finished: Promise<void>;
  readonly tier?: string;
  cancel(): void;
}

test('compiled и runtime доставляют идентичный финал поверхности на движке', async ({ page }) => {
  const result = await page.evaluate(async ([compiledUrl, uncompiledUrl]) => {
    const [compiled, uncompiled] = await Promise.all([
      import(compiledUrl) as Promise<{ play: (el: Element) => SurfaceControlsLike }>,
      import(uncompiledUrl) as Promise<{ play: (el: Element) => SurfaceControlsLike }>,
    ]);
    const make = (): HTMLElement => {
      const el = document.createElement('div');
      el.style.cssText = 'width:240px;height:40px;background:#33c';
      document.body.appendChild(el);
      return el;
    };
    const elCompiled = make();
    const elUncompiled = make();
    const stylesBefore = document.querySelectorAll('style').length;

    const ctrlCompiled = compiled.play(elCompiled);
    const ctrlUncompiled = uncompiled.play(elUncompiled);
    await Promise.all([ctrlCompiled.finished, ctrlUncompiled.finished]);

    const read = {
      widthCompiled: getComputedStyle(elCompiled).width,
      widthUncompiled: getComputedStyle(elUncompiled).width,
      // Generated stylesheet живёт ровно между inject и terminal cleanup —
      // после finished на ОБОИХ путях residual-стилей быть не должно.
      stylesAfter: document.querySelectorAll('style').length,
      stylesBefore,
      // Имя псевдодерева на compiled-пути снимается terminal-обработкой
      // (на движках без startViewTransition VT-фазы не было вовсе).
      vtNameCompiled: elCompiled.style.getPropertyValue('view-transition-name'),
      hasViewTransitions: typeof (document as { startViewTransition?: unknown }).startViewTransition === 'function',
      tierUncompiled: ctrlUncompiled.tier,
    };
    elCompiled.remove();
    elUncompiled.remove();
    return read;
  }, [COMPILED, UNCOMPILED] as const);

  test.info().annotations.push({ type: 'surface-engines', description: JSON.stringify(result) });

  expect(result.widthCompiled).toBe('360px');
  expect(result.widthUncompiled).toBe('360px');
  expect(result.stylesAfter).toBe(result.stylesBefore);
  if (result.hasViewTransitions) {
    expect(result.vtNameCompiled).toBe('');
  }
});

test('compiled list-путь исполняется WAAPI с артефактными keyframes/easing', async ({ page }) => {
  const result = await page.evaluate(async ([compiledUrl]) => {
    const { playList } = await import(compiledUrl) as Promise<{
      playList: (list: Element[]) => SurfaceControlsLike;
    }>;
    const els = [0, 1].map((): HTMLElement => {
      const el = document.createElement('div');
      el.style.cssText = 'width:240px;height:20px';
      document.body.appendChild(el);
      return el;
    });
    const controls = playList(els);
    await controls.finished;
    const anims = els.map((el) => el.getAnimations()[0]!);
    for (const anim of anims) anim.pause();

    const timing = anims[0]!.effect!.getComputedTiming();
    const duration = Number(timing.duration);
    const samples: { t: number; widths: number[] }[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = (duration * i) / 10;
      for (const anim of anims) anim.currentTime = t;
      samples.push({
        t,
        widths: els.map((el) => Number.parseFloat(getComputedStyle(el).width)),
      });
    }
    for (const anim of anims) {
      anim.currentTime = duration;
      anim.play();
    }
    await Promise.all(anims.map((anim) => anim.finished));
    const finalWidths = els.map((el) => Number.parseFloat(getComputedStyle(el).width));
    els.forEach((el) => el.remove());
    return {
      duration,
      easing: String(timing.easing),
      samples,
      finalWidths,
    };
  }, [COMPILED] as const);

  // Артефакт build-time сертификации исполнен движком: duration > 0, easing —
  // precomputed linear() (не дефолт движка), концы траектории точные.
  expect(result.duration).toBeGreaterThan(0);
  expect(result.easing).toContain('linear(');
  expect(result.finalWidths).toEqual([360, 360]);

  // Траектория нетривиальна и монотонна 240 → 360 на всей сетке (оба элемента
  // списка получают одинаковое движение — сопряжение без главного треда).
  for (const sample of result.samples) {
    for (const width of sample.widths) {
      expect(width).toBeGreaterThanOrEqual(239.5);
      expect(width).toBeLessThanOrEqual(360.5);
    }
  }
  const first = result.samples[0]!.widths;
  const last = result.samples[result.samples.length - 1]!.widths;
  expect(first[0]).toBeCloseTo(240, 0);
  expect(last[0]).toBeCloseTo(360, 0);
  expect(first[0]).toBeLessThan(last[0]);
});

test('compiled схлопывается к мгновенному коммиту под reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const result = await page.evaluate(async ([compiledUrl]) => {
    const { play } = await import(compiledUrl) as Promise<{
      play: (el: Element) => SurfaceControlsLike;
    }>;
    const el = document.createElement('div');
    el.style.cssText = 'width:240px;height:40px';
    document.body.appendChild(el);
    const stylesBefore = document.querySelectorAll('style').length;
    const controls = play(el);
    await controls.finished;
    const width = getComputedStyle(el).width;
    const stylesAfter = document.querySelectorAll('style').length;
    el.remove();
    return { width, stylesBefore, stylesAfter };
  }, [COMPILED] as const);

  expect(result.width).toBe('360px');
  expect(result.stylesAfter).toBe(result.stylesBefore);
});
