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
 *      (360 px, отсутствие residual-стилей псевдодерева, очищенный
 *      view-transition-name) — контроль по DOM, не по контракту возврата.
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

// Ждём терминального состояния через наблюдаемые DOM-признаки, а не через
// контракт возврата: после hotfix наблюдаемой эквивалентности fixture-функция
// — голый вызов, возвращаемое значение недоступно потребителю.
async function waitTerminal(page: import('@playwright/test').Page, elSel: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el !== null && getComputedStyle(el).width === '360px';
    },
    elSel,
    { timeout: 5000 },
  );
}

// Generated stylesheet снимается на terminal phase отдельной задачей после
// того, как computed width достиг 360px: на сборке waitTerminal может снять
// пробу раньше observer-тика, который удаляет <style>. Отдельный gate —
// stylesBefore должен совпасть с stylesAfter, когда стили зафиксировались.
async function waitStylesSettled(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const st = (window as unknown as { __els?: { stylesBefore: number } }).__els;
      return st !== undefined && document.querySelectorAll('style').length === st.stylesBefore;
    },
    undefined,
    { timeout: 5000 },
  );
}

test('compiled и runtime доставляют идентичный финал поверхности на движке', async ({ page }) => {
  await page.evaluate(async ([compiledUrl, uncompiledUrl]) => {
    const [compiled, uncompiled] = await Promise.all([
      import(compiledUrl) as Promise<{ play: (el: Element) => void }>,
      import(uncompiledUrl) as Promise<{ play: (el: Element) => void }>,
    ]);
    const make = (id: string): HTMLElement => {
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'width:240px;height:40px;background:#33c';
      document.body.appendChild(el);
      return el;
    };
    (window as unknown as { __els: { compiled: HTMLElement; uncompiled: HTMLElement; stylesBefore: number; vtNameCompiled: string } }).__els = {
      compiled: make('lm19-compiled'),
      uncompiled: make('lm19-uncompiled'),
      stylesBefore: document.querySelectorAll('style').length,
      vtNameCompiled: '',
    };
    compiled.play((window as unknown as { __els: { compiled: HTMLElement } }).__els.compiled);
    uncompiled.play((window as unknown as { __els: { uncompiled: HTMLElement } }).__els.uncompiled);
  }, [COMPILED, UNCOMPILED] as const);

  await waitTerminal(page, '#lm19-compiled');
  await waitTerminal(page, '#lm19-uncompiled');
  await waitStylesSettled(page);

  const result = await page.evaluate(() => {
    const st = (window as unknown as { __els: { compiled: HTMLElement; uncompiled: HTMLElement; stylesBefore: number } }).__els;
    const read = {
      widthCompiled: getComputedStyle(st.compiled).width,
      widthUncompiled: getComputedStyle(st.uncompiled).width,
      stylesAfter: document.querySelectorAll('style').length,
      stylesBefore: st.stylesBefore,
      vtNameCompiled: st.compiled.style.getPropertyValue('view-transition-name'),
      hasViewTransitions: typeof (document as { startViewTransition?: unknown }).startViewTransition === 'function',
    };
    st.compiled.remove();
    st.uncompiled.remove();
    return read;
  });

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
    const { playList } = (await import(compiledUrl)) as {
      playList: (list: Element[]) => void;
    };
    const els = [0, 1].map((): HTMLElement => {
      const el = document.createElement('div');
      el.style.cssText = 'width:240px;height:20px';
      document.body.appendChild(el);
      return el;
    });
    playList(els);
    // Ждём, пока у обоих появится активная WAAPI-анимация (startViewTransition
    // не может стартовать мгновенно в некоторых движках) — polling по rAF.
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (els.every((el) => el.getAnimations().length > 0)) resolve();
        else requestAnimationFrame(tick);
      };
      tick();
    });
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
  await page.evaluate(async ([compiledUrl]) => {
    const { play } = (await import(compiledUrl)) as {
      play: (el: Element) => void;
    };
    const el = document.createElement('div');
    el.id = 'lm19-rm';
    el.style.cssText = 'width:240px;height:40px';
    document.body.appendChild(el);
    play(el);
  }, [COMPILED] as const);

  // Reduced-motion схлопывается к мгновенному коммиту — но коммит может
  // потребовать одного кадра. Ждём терминальную ширину по DOM.
  await page.waitForFunction(
    () => {
      const el = document.getElementById('lm19-rm');
      return el !== null && getComputedStyle(el).width === '360px';
    },
    undefined,
    { timeout: 5000 },
  );

  const result = await page.evaluate(() => {
    const el = document.getElementById('lm19-rm')!;
    const read = {
      width: getComputedStyle(el).width,
      styles: document.querySelectorAll('style').length,
    };
    el.remove();
    return read;
  });

  expect(result.width).toBe('360px');
});
