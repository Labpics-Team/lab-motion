/**
 * test/animate-tween-velocity-pickup.test.ts — субпуть ./animate:
 * tween вычисляет АНАЛИТИЧЕСКУЮ скорость канала (контракт C¹, #93 срез 3).
 *
 * Классы: Б (characterization/pin разрыва), А (direct oracle производной),
 * В (property/fuzz, seeded), Д-доказательства — в маппинге мутаций ниже.
 *
 * Контракт: в tween-режиме скорость канала аналитична —
 *   v(t) = range · ease′(k) / duration,  k = t / duration,
 * производная изинга — центральная разность с фиксированным h (детерминизм);
 * у краёв окно разности поджимается внутрь [0,1] (изинги клампят снаружи —
 * разность через край дала бы ложный слом производной). Потребительская цель:
 * перехват tween→spring вторым animate() наследует скорость (smooth pickup
 * становится C¹, как на spring-пути), а не стартует из покоя.
 *
 * Оракул наблюдения (только публичная поверхность): солвер линеен по v0
 * (линейное ОДУ ⇒ value(t) аффинно по v0), поэтому унаследованную скорость
 * можно ВОССТАНОВИТЬ из первой пары кадров нового spring-рана:
 *   v0n = (x(dt) − g(0)) / (g(1) − g(0)),  g(v) = readCompositorSpring(...{v0:v}),
 *   v_inherited = v0n · (to₂ − x_mid).
 *
 * ── RED PROOF (вневременно) ──────────────────────────────────────────────────
 * До среза src/animate/main-unit.ts:214 занулял скорость каждый кадр
 * (`ch.velocity = 0` — «tween: скорость не переносится»): captureNum при
 * прерывании отдавал velocity=0 → новый spring-ран рождался из покоя →
 * восстановленная v_inherited = 0 → пин «bite > 0.65·|v_analytic|» красный
 * по правильной причине (отсутствие контракта, не поломка солвера).
 *
 * ── MUTATION PROOF (тест обязан падать на своей мутации) ─────────────────────
 *   [revert]     Вернуть `ch.velocity = 0` → пин bite красный.
 *   [no-dur]     Убрать деление на duration (v = range·ease′) → оракул
 *                «линейный ease → ровно range/duration·1000» красный (250 ≠ 1e5).
 *   [no-range]   Не умножать на range канала → оракулы 250/67.5 красные.
 *   [fwd-diff]   Заменить центральную разность односторонней (k, k+h) →
 *                оракул easeIn при k=0.3 красный: forward-ошибка h·f″/2 ≈
 *                9e-4·250 = 0.225 units/s ≫ допуск toBeCloseTo(…, 2),
 *                центральная ошибка h²·f‴/6 ≈ 2.5e-4.
 *   [no-clamp]   Убрать поджатие окна разности в [0,1] → краевой оракул
 *                (линейный ease, k=0.9995) красный: сэмпл за краем клампится
 *                изингом → слом производной 250 → ~187.
 *   [nan-leak]   Убрать страж Number.isFinite на скорости → фазз враждебного
 *                ease (NaN) красный (non-finite скорость сеет NaN в v0).
 *
 * Детерминизм: время только через инжектируемые шаг-часы; фазз — seeded LCG.
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import { easeIn, easeInOut, easeOut, linear } from '../src/easing/index.js';
import type { SpringParams } from '../src/spring.js';
import {
  allWritesFinite,
  fakeEl,
  lcg,
  makeClock,
  pickAnimate,
  translateXSeries,
} from './animate-facade-helpers.js';

const animate = pickAnimate(animateApi as Record<string, unknown>);
const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

// ─── Оракул: восстановление унаследованной скорости из публичных кадров ──────

/**
 * Восстанавливает v0 (units/s) нового spring-рана из значения его кадра при
 * elapsed=dtS. Точность аффинной инверсии — машинная (солвер линеен по v0);
 * никакого доступа к приватному состоянию.
 */
function impliedPickupVelocity(
  spring: SpringParams,
  fromMid: number,
  to2: number,
  xAtDt: number,
  dtS: number,
): number {
  const g0 = readCompositorSpring(spring, { from: fromMid, to: to2, v0: 0, t: dtS }).value;
  const g1 = readCompositorSpring(spring, { from: fromMid, to: to2, v0: 1, t: dtS }).value;
  return ((xAtDt - g0) / (g1 - g0)) * (to2 - fromMid);
}

/**
 * Сценарий «tween прерван spring-раном»: гонит tween до tMs (seek — точная
 * контрольная точка), прерывает animate({spring}) к to2, шагает два кадра
 * нового рана (elapsed 0 и 16 мс) и возвращает срез наблюдения.
 */
function runPickup(opts: {
  toTween: number;
  durationMs: number;
  ease: (t: number) => number;
  seekMs: number;
  to2: number;
}): { xMid: number; vInherited: number; writes: ReturnType<typeof fakeEl>['writes'] } {
  const f = fakeEl();
  const clock = makeClock();
  const first = animate(
    f.el,
    { x: opts.toTween },
    { duration: opts.durationMs, ease: opts.ease, requestFrame: clock.requestFrame },
  );
  first.seek(opts.seekMs);
  const xMid = translateXSeries(f.writes).at(-1)!;
  animate(f.el, { x: opts.to2 }, { spring: SPRING, requestFrame: clock.requestFrame });
  clock.step(16); // кадр 1 нового рана: elapsed 0 (bit-exact точка ретаргета)
  clock.step(16); // кадр 2: elapsed 16 мс
  const xAtDt = translateXSeries(f.writes).at(-1)!;
  return {
    xMid,
    vInherited: impliedPickupVelocity(SPRING, xMid, opts.to2, xAtDt, 0.016),
    writes: f.writes,
  };
}

// ─── Класс Б: characterization разрыва — пин потребительского контракта ──────

describe('animate tween→spring: подхват скорости (Класс Б, пин #93 срез 3)', () => {
  it('bite: перехват на середине наследует |v| > 0.65·|v_analytic| (RED до среза: v=0)', () => {
    const f = fakeEl();
    const clock = makeClock();
    // Реалистичный потребительский ход: чистые rAF-кадры, без seek.
    animate(
      f.el,
      { x: 100 },
      { duration: 400, ease: linear, requestFrame: clock.requestFrame },
    );
    clock.step(16); // первый кадр: elapsed 0
    for (let i = 0; i < 12; i++) clock.step(16); // elapsed 192 мс ≈ середина
    const xMid = translateXSeries(f.writes).at(-1)!;
    expect(xMid).toBeGreaterThan(0);
    expect(xMid).toBeLessThan(100);

    animate(f.el, { x: 300 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    const xAtDt = translateXSeries(f.writes).at(-1)!;
    const vInherited = impliedPickupVelocity(SPRING, xMid, 300, xAtDt, 0.016);
    const vAnalytic = ((100 - 0) / 400) * 1000; // линейный ease: 250 units/s
    expect(Math.abs(vInherited)).toBeGreaterThan(0.65 * Math.abs(vAnalytic));
  });

  it('C⁰ не сломан: первая запись нового рана — ровно значение на момент прерывания', () => {
    const r = runPickup({ toTween: 100, durationMs: 400, ease: easeInOut, seekMs: 170, to2: 300 });
    const xs = translateXSeries(r.writes);
    // Кадр elapsed 0 нового рана (предпоследняя запись) === xMid.
    expect(xs.at(-2)!).toBeCloseTo(r.xMid, 9);
  });
});

// ─── Класс А: direct oracle — аналитическая производная известных изингов ────

describe('animate tween: аналитическая скорость = range·ease′(k)/duration (Класс А)', () => {
  it('линейный ease, k=0.5: ровно range/duration = 250 units/s', () => {
    const r = runPickup({ toTween: 100, durationMs: 400, ease: linear, seekMs: 200, to2: 300 });
    expect(r.xMid).toBeCloseTo(50, 9);
    expect(r.vInherited).toBeCloseTo(250, 6);
  });

  it('easeIn (t³), k=0.3: ease′=3k²=0.27 → 67.5 units/s (допуск режет fwd-diff мутант)', () => {
    const r = runPickup({ toTween: 100, durationMs: 400, ease: easeIn, seekMs: 120, to2: 300 });
    // Центральная разность на кубике: ошибка h²·f‴/6 ≈ 1e-6 (норм.) → ~2.5e-4 units/s.
    expect(r.vInherited).toBeCloseTo(67.5, 2);
  });

  it('easeInOut, k=0.25 (гладкая точка): ease′=12k²=0.75 → 187.5 units/s', () => {
    const r = runPickup({ toTween: 100, durationMs: 400, ease: easeInOut, seekMs: 100, to2: 300 });
    expect(r.vInherited).toBeCloseTo(187.5, 2);
  });

  it('обратное направление: пара [100, 0] → скорость отрицательна, −250 units/s', () => {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(
      f.el,
      { x: [100, 0] },
      { duration: 400, ease: linear, requestFrame: clock.requestFrame },
    );
    first.seek(200);
    const xMid = translateXSeries(f.writes).at(-1)!;
    expect(xMid).toBeCloseTo(50, 9);
    animate(f.el, { x: 300 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    const v = impliedPickupVelocity(SPRING, xMid, 300, translateXSeries(f.writes).at(-1)!, 0.016);
    expect(v).toBeCloseTo(-250, 6);
  });

  it('край k→1: окно разности поджато в [0,1] — линейный ease держит ровно 250', () => {
    // k=0.9995: сэмпл k+h вышел бы за 1 и клампился бы изингом (слом → ~187).
    const r = runPickup({ toTween: 100, durationMs: 400, ease: linear, seekMs: 399.8, to2: 300 });
    expect(r.vInherited).toBeCloseTo(250, 6);
  });

  it('край k→0: окно поджато снизу — линейный ease держит ровно 250', () => {
    const r = runPickup({ toTween: 100, durationMs: 400, ease: linear, seekMs: 0.2, to2: 300 });
    expect(r.vInherited).toBeCloseTo(250, 6);
  });
});

// ─── Класс Б: границы контракта (покой и враждебный ease) ────────────────────

describe('animate tween: границы скорости (Класс Б)', () => {
  it('после естественного оседания tween реестр в покое: следующий ран стартует с v0=0', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(
      f.el,
      { x: 100 },
      { duration: 200, ease: linear, requestFrame: clock.requestFrame },
    );
    clock.drain(16);
    await first.finished;
    expect(translateXSeries(f.writes).at(-1)).toBe(100);

    animate(f.el, { x: 300 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    const v = impliedPickupVelocity(SPRING, 100, 300, translateXSeries(f.writes).at(-1)!, 0.016);
    expect(v).toBeCloseTo(0, 6);
  });

  it('враждебный ease (NaN): кадр линейный (существующий контракт), скорость → 0, записи конечны', () => {
    const r = runPickup({
      toTween: 100,
      durationMs: 400,
      ease: () => NaN,
      seekMs: 200,
      to2: 300,
    });
    expect(r.xMid).toBeCloseTo(50, 9); // линейный fallback кадра не сломан
    expect(r.vInherited).toBeCloseTo(0, 6); // NaN-производная не сеется в v0
    expect(allWritesFinite(r.writes)).toBe(true);
  });
});

// ─── Класс В: seeded property/fuzz — производная любого гладкого изинга ──────

describe('animate tween: скорость против аналитической производной (Класс В, seeded fuzz)', () => {
  const EASES: { name: string; fn: (t: number) => number; d: (t: number) => number }[] = [
    { name: 'linear', fn: linear, d: () => 1 },
    { name: 'easeIn', fn: easeIn, d: (t) => 3 * t * t },
    { name: 'easeOut', fn: easeOut, d: (t) => 3 * (1 - t) * (1 - t) },
    {
      name: 'easeInOut',
      fn: easeInOut,
      d: (t) => (t < 0.5 ? 12 * t * t : 3 * (2 - 2 * t) * (2 - 2 * t)),
    },
  ];

  it('500 прогонов: |v_inherited − v_analytic| ≤ 1% скоростной шкалы; записи конечны', () => {
    const rnd = lcg(0x5eed_c3a5);
    for (let i = 0; i < 500; i++) {
      const ease = EASES[i % EASES.length]!;
      const durationMs = 150 + rnd() * 750;
      const to = (rnd() < 0.5 ? -1 : 1) * (20 + rnd() * 580);
      const k = 0.05 + rnd() * 0.9;
      const seekMs = k * durationMs;
      const r = runPickup({ toTween: to, durationMs, ease: ease.fn, seekMs, to2: r2(rnd, to) });
      const vAnalytic = (to * ease.d(k) * 1000) / durationMs;
      const scale = (Math.abs(to) * 1000) / durationMs; // скоростная шкала рана
      const err = Math.abs(r.vInherited - vAnalytic);
      if (err > 0.01 * scale + 1e-6) {
        throw new Error(
          `drift: ease=${ease.name} dur=${durationMs} to=${to} k=${k} ` +
            `v=${r.vInherited} analytic=${vAnalytic} err=${err}`,
        );
      }
      if (!allWritesFinite(r.writes)) {
        throw new Error(`non-finite write: ease=${ease.name} dur=${durationMs} to=${to} k=${k}`);
      }
    }
  }, 30_000);

  /** Цель прерывания: гарантированно ненулевой и невырожденный range₂. */
  function r2(rnd: () => number, to: number): number {
    return to + (rnd() < 0.5 ? -1 : 1) * (50 + rnd() * 350);
  }
});
