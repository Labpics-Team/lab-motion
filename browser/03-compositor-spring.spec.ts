/**
 * 03-compositor-spring.spec.ts — матрица #102, пункт (2, WAAPI-tier поведение):
 * реальная compositor-Animation vs АНАЛИТИЧЕСКОЕ предсказание солвера пакета.
 *
 * Ключевой принцип #102: не «просто не NaN», а сверка НАБЛЮДАЕМОГО значения
 * реальной Element.animate() (компилятор compileSpringPlan → нативный WAAPI, вся
 * пружина в CSS linear()-easing) с readCompositorSpring (точная замкнутая форма
 * solveSpring) в ОБОСНОВАННОМ допуске.
 *
 * Обоснование допуска: linear()-строка — кусочно-линейная реконструкция кривой с
 * бюджетом ошибки tolerance (DEFAULT_TOLERANCE = 1/400 в единицах прогресса). При
 * амплитуде A(px) reconstruction-budget = A/400 px; браузер добавляет суб-пиксельное
 * округление matrix(). Порог берём с запасом ×2 к бюджету + 0.1px на округление —
 * это ПРЕДСКАЗАНИЕ теории ошибки, а не подгонка.
 *
 * Детерминизм: семплирование через Animation.currentTime (pause + явный
 * currentTime, document.timeline — виртуальные часы). Ни sleep, ни rAF, ни замера
 * стены времени в ассерте.
 */

import { expect, test } from './fixtures/harness';

/** Парсит translateX из computed 'matrix(a,b,c,d,e,f)' (e = tx). */
function txOf(matrix: string): number {
  const m = matrix.match(/matrix\(([^)]+)\)/);
  if (!m) return matrix === 'none' ? 0 : NaN;
  const parts = m[1].split(',').map((s) => Number(s.trim()));
  return parts[4];
}

for (const seed of [{ label: 'от покоя (v0=0)', v0: 0 }, { label: 'ретаргет-сев (v0=6)', v0: 6 }]) {
  test(`compositor translateX совпадает с solveSpring в допуске — ${seed.label}`, async ({
    page,
  }) => {
    const spring = { mass: 1, stiffness: 180, damping: 12 }; // underdamped, overshoot
    const from = 0;
    const to = 200;

    const samples = await page.evaluate(
      async ({ spring, from, to, v0 }) => {
        const compositor = await import('/dist/compositor/index.js');
        const plan = compositor.compileSpringPlan({
          spring,
          property: 'transform',
          from,
          to,
          v0,
          format: (v: number) => `translateX(${v}px)`,
        });

        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.width = '10px';
        el.style.height = '10px';
        document.body.appendChild(el);

        const anim = el.animate(plan.keyframes, {
          duration: plan.duration,
          easing: plan.easing,
          iterations: plan.iterations,
          fill: plan.fill as FillMode,
          composite: plan.composite as CompositeOperation,
        });
        anim.pause(); // виртуальные часы: значение читаем по currentTime

        const durMs = plan.duration;
        const fractions = [0, 0.1, 0.25, 0.5, 0.75, 1];
        const out: { tMs: number; observed: number; analytic: number }[] = [];
        for (const f of fractions) {
          const tMs = f * durMs;
          anim.currentTime = tMs;
          const observed = getComputedStyle(el).transform;
          const read = compositor.readCompositorSpring(spring, {
            from,
            to,
            v0,
            t: tMs / 1000,
          });
          out.push({ tMs, observed: observed as unknown as number, analytic: read.value });
        }
        anim.cancel();
        el.remove();
        return { durMs, samples: out };
      },
      { spring, from, to, v0: seed.v0 },
    );

    const amplitude = Math.abs(to - from);
    // Теоретический порог: ×2 reconstruction-budget + 0.1px matrix-округление.
    const budget = (amplitude / 400) * 2 + 0.1;

    for (const s of samples.samples) {
      const observed = txOf(s.observed as unknown as string);
      expect(Number.isFinite(observed), `tx не число при t=${s.tMs}: ${s.observed}`).toBe(true);
      expect(
        Math.abs(observed - s.analytic),
        `t=${s.tMs}ms observed=${observed} analytic=${s.analytic} budget=${budget}`,
      ).toBeLessThanOrEqual(budget);
    }

    // Края точны: старт = from, финал (fill:both, currentTime=duration) = to.
    const first = txOf(samples.samples[0].observed as unknown as string);
    const last = txOf(samples.samples[samples.samples.length - 1].observed as unknown as string);
    expect(Math.abs(first - from)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(last - to)).toBeLessThanOrEqual(0.05);
  });
}

test('underdamped-пружина реально уходит в overshoot за to (наблюдаемо у движка)', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const compositor = await import('/dist/compositor/index.js');
    const spring = { mass: 1, stiffness: 220, damping: 8 }; // сильный overshoot
    const from = 0;
    const to = 100;
    const plan = compositor.compileSpringPlan({
      spring,
      property: 'transform',
      from,
      to,
      format: (v: number) => `translateX(${v}px)`,
    });
    const el = document.createElement('div');
    el.style.position = 'absolute';
    document.body.appendChild(el);
    const anim = el.animate(plan.keyframes, {
      duration: plan.duration,
      easing: plan.easing,
      fill: 'both',
    });
    anim.pause();
    // Плотный скан по времени: ищем максимум наблюдаемого translateX (шаг мелкий —
    // апекс overshoot острый, грубый шаг занизил бы наблюдаемый пик).
    let observedMax = -Infinity;
    const steps = 2000;
    for (let i = 0; i <= steps; i++) {
      anim.currentTime = (i / steps) * plan.duration;
      const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
      const tx = m ? Number(m[1].split(',')[4]) : 0;
      if (tx > observedMax) observedMax = tx;
    }
    anim.cancel();
    el.remove();
    // Аналитический пик по солверу (столь же плотный скан).
    let analyticMax = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * (plan.duration / 1000);
      const v = compositor.readCompositorSpring(spring, { from, to, t }).value;
      if (v > analyticMax) analyticMax = v;
    }
    return { observedMax, analyticMax, to };
  });
  // Реальный overshoot: пик строго выше to у обоих — и они согласованы.
  expect(r.observedMax).toBeGreaterThan(r.to);
  expect(r.analyticMax).toBeGreaterThan(r.to);
  expect(Math.abs(r.observedMax - r.analyticMax)).toBeLessThanOrEqual(1.0);
});

test('production-план выбирает residency-safe форму для каждого движка', async ({
  page,
  browserName,
}) => {
  const result = await page.evaluate(async () => {
    const { CompositorSpring } = await import('/dist/compositor/index.js');
    const el = document.createElement('div');
    document.body.appendChild(el);
    const spring = new CompositorSpring({
      spring: { mass: 1, stiffness: 220, damping: 8 },
      property: 'opacity',
      from: 0,
      to: 1,
      target: el,
    });
    spring.start();
    const animation = el.getAnimations()[0]!;
    const effect = animation.effect as KeyframeEffect;
    const frames = effect.getKeyframes();
    const timing = effect.getTiming();
    const offsets = frames.map((frame) => frame.computedOffset);
    spring.destroy();
    el.remove();
    return {
      count: frames.length,
      easing: timing.easing,
      offsets,
      vendor: navigator.vendor,
      userAgent: navigator.userAgent,
    };
  });

  expect(result.offsets[0]).toBe(0);
  expect(result.offsets.at(-1)).toBe(1);
  for (let i = 1; i < result.offsets.length; i++) {
    expect(result.offsets[i]!).toBeGreaterThan(result.offsets[i - 1]!);
  }
  if (browserName === 'webkit') {
    expect(result.vendor).toContain('Apple');
    expect(result.userAgent).toContain('AppleWebKit');
    expect(result.count).toBeGreaterThan(2);
    expect(result.easing).toBe('linear');
  } else {
    expect(result.count).toBe(2);
    expect(String(result.easing).startsWith('linear(')).toBe(true);
  }
});
