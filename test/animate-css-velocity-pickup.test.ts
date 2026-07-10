/**
 * test/animate-css-velocity-pickup.test.ts — субпуть ./animate:
 * CSS/value-каналы наследуют скорость при перехвате (контракт C¹, #93 срез 4).
 *
 * Классы: Б (characterization/pin разрыва), А (direct oracle проекции),
 * В (property/fuzz, seeded), Д-доказательства — в маппинге мутаций ниже.
 *
 * Контракт: css-канал ведом нормированным прогрессом p (значение кадра —
 * cssAt(css, p)); его скорость — производная прогресса ṗ (прогресс/с).
 * При перехвате вторым animate() новая интерполяция ребейзится
 * (from = захваченное значение, p снова 0), а импульс проецируется между
 * прогресс-пространствами по ДОМИНАНТНОМУ компоненту НОВОГО спана
 * (канон WaapiUnit.dominantV0 — доминанта всегда по целевому диапазону):
 * v0' = normalizeV0(ṗ̂·Δold_i, Δnew_i),
 * i = argmax|Δnew|. Для юнитных значений (1 компонент) и коллинеарных
 * цветовых ретаргетов проекция ТОЧНА; явная пара [from,to] отключает подхват
 * (канон числовых каналов); var()/смешанные виды — дискретная интерполяция,
 * скорость не определена → 0.
 *
 * Оракул наблюдения (только публичная поверхность): солвер линеен по v0,
 * поэтому унаследованная скорость восстанавливается аффинной инверсией из
 * кадра elapsed=16 мс нового рана (тот же оракул, что в
 * animate-tween-velocity-pickup).
 *
 * ── RED PROOF (вневременно) ──────────────────────────────────────────────────
 * До среза src/animate/channels.ts:364 сеял `v0: 0` безусловно («C⁰-подхват
 * css-каналов: скорость между пространствами не проецируется»), а captureCss
 * отдавал только строку (без ṗ): восстановленная v_inherited = 0, отсюда на
 * базе красные ровно по причине отсутствия контракта (6 из 10 тестов файла):
 *  - «bite: … > 0.65·|v_analytic|» — expected 0 to be greater than 312.120…;
 *  - «spring→spring: ровно ṗ̂·range» — expected +0 to be close to 480.185…;
 *  - «tween→spring: ровно 250» — expected +0 to be close to 250;
 *  - «обратный ретаргет: плато» — 27.515… ≥ 28.047… красный (без импульса
 *    значение сразу падает ниже захвата);
 *  - «цвет: … > 0.6·|v_analytic|» — expected 97.657… > 576.222… красный;
 *  - «fuzz 300 прогонов» — первый же дрифт: v=0 при analytic≈−819.567.
 * C⁰-пины (ребейз from на захват, явная пара, покой после settle, var())
 * зелёные и ДО среза — фиксируют, что перехват не пересоздаёт интерполяцию
 * «от p=0 старого спана» (этот подозреваемый дефект НЕ подтвердился).
 *
 * ── MUTATION PROOF (тест обязан падать на своей мутации; посеяно и откачено) ─
 *   [revert]      В bindGroup занулить результат проекции (v0 = 0·project…)
 *                 → 6 из 10 красные (bite/exact/плато/цвет/fuzz).
 *   [sign]        projectCssV0: ṗ̂·Δold → −ṗ̂·Δold → 5 красных
 *                 (знак скорости перевёрнут: −480 ≠ 480).
 *   [no-old-span] projectCssV0: normalizeV0(ṗ̂·Δold_i, …) → normalizeV0(ṗ̂, …)
 *                 → 6 красных (масштаб старого спана потерян).
 *   [tween-dpdt]  main-unit: не писать o.css.dpdt в tween-ветке → оракул
 *                 «tween→spring: ровно 250» красный (v≈0).
 *   [spring-dpdt] main-unit: не писать css.dpdt в spring-ветке → 5 красных
 *                 (spring→spring, bite, плато, цвет, fuzz: v≈0).
 *
 * Детерминизм: время только через инжектируемые шаг-часы; фазз — seeded LCG.
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import { linear } from '../src/easing/index.js';
import type { SpringParams } from '../src/spring.js';
import {
  allWritesFinite,
  fakeEl,
  lcg,
  makeClock,
  pickAnimate,
  type StyleWrite,
} from './animate-facade-helpers.js';

const animate = pickAnimate(animateApi as Record<string, unknown>);
const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

// ─── Разбор записей ──────────────────────────────────────────────────────────

/** Числовые значения записей свойства (parseFloat: '42.5px' → 42.5). */
function pxSeries(writes: readonly StyleWrite[], prop: string): number[] {
  return writes.filter((w) => w.prop === prop).map((w) => parseFloat(w.value));
}

/** rgb-компоненты записей свойства: 'rgb(12, 34, 56)' → [12, 34, 56]. */
function rgbSeries(writes: readonly StyleWrite[], prop: string): number[][] {
  const out: number[][] = [];
  for (const w of writes) {
    if (w.prop !== prop) continue;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(w.value);
    if (m) out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  return out;
}

// ─── Оракул: восстановление унаследованной скорости из публичных кадров ──────

/**
 * Восстанавливает унаследованную скорость (units value/s) нового spring-рана
 * из его кадра при elapsed=dtS аффинной инверсией (солвер линеен по v0).
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

/** Аналитическая скорость прогресса ṗ(t̂) пружины от покоя (прогресс/с). */
function pdotAt(tS: number): number {
  return readCompositorSpring(SPRING, { from: 0, to: 1, v0: 0, t: tS }).velocity;
}

/**
 * Сценарий «css-ран width прерван spring-раном»: гонит первый ран до seekMs
 * (seek — точная контрольная точка), прерывает animate({spring}) к to2,
 * шагает два кадра нового рана (elapsed 0 и 16 мс), возвращает срез.
 */
function runCssPickup(opts: {
  mode1: Record<string, unknown>;
  seekMs: number;
  to2: string | readonly [string, string];
}): { wMid: number; v: number; series: number[]; writes: StyleWrite[] } {
  const f = fakeEl({ width: '0px' });
  const clock = makeClock();
  const first = animate(
    f.el,
    { width: '100px' },
    { ...opts.mode1, requestFrame: clock.requestFrame },
  );
  first.seek(opts.seekMs);
  const wMid = pxSeries(f.writes, 'width').at(-1)!;
  animate(f.el, { width: opts.to2 }, { spring: SPRING, requestFrame: clock.requestFrame });
  clock.step(16); // кадр 1 нового рана: elapsed 0 (ребейз, p=0)
  clock.step(16); // кадр 2: elapsed 16 мс
  const series = pxSeries(f.writes, 'width');
  const to2v = parseFloat(typeof opts.to2 === 'string' ? opts.to2 : opts.to2[1]);
  const from2 = typeof opts.to2 === 'string' ? wMid : parseFloat(opts.to2[0]);
  return {
    wMid,
    v: impliedPickupVelocity(SPRING, from2, to2v, series.at(-1)!, 0.016),
    series,
    writes: f.writes,
  };
}

// ─── Класс Б: characterization разрыва — пин потребительского контракта ──────

describe('animate css-канал: подхват скорости при перехвате (Класс Б, пин #93 срез 4)', () => {
  it('bite: перехват на середине наследует |v| > 0.65·|v_analytic| (RED до среза: v=0)', () => {
    const f = fakeEl({ width: '0px' });
    const clock = makeClock();
    // Реалистичный потребительский ход: чистые rAF-кадры, без seek.
    animate(f.el, { width: '100px' }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 6; i++) clock.step(16); // кадры t = 0..80 мс
    const wMid = pxSeries(f.writes, 'width').at(-1)!;
    expect(wMid).toBeGreaterThan(0);
    expect(wMid).toBeLessThan(100);

    animate(f.el, { width: '300px' }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    const wAtDt = pxSeries(f.writes, 'width').at(-1)!;
    const vInherited = impliedPickupVelocity(SPRING, wMid, 300, wAtDt, 0.016);
    const vAnalytic = pdotAt(0.08) * 100; // ṗ(80 мс)·range — units/s
    expect(Math.abs(vAnalytic)).toBeGreaterThan(100); // страж представительности сценария
    expect(Math.abs(vInherited)).toBeGreaterThan(0.65 * Math.abs(vAnalytic));
  });

  it('C⁰: первая запись нового рана — ровно захваченное значение (ребейз, не p=0 старого спана)', () => {
    const r = runCssPickup({ mode1: { spring: SPRING }, seekMs: 80, to2: '300px' });
    // series[0] — запись seek (захват), series[1] — кадр elapsed 0 нового рана.
    expect(r.series[1]!).toBeCloseTo(r.wMid, 12);
  });

  it('обратный ретаргет: импульс держит границу (плато у захвата), затем движение к цели', () => {
    const r = runCssPickup({ mode1: { spring: SPRING }, seekMs: 80, to2: '0px' });
    // Унаследованный импульс направлен ОТ новой цели: эмит клампится на p=0 →
    // кадр 16 мс не ниже захвата (без наследования он сразу падает к 0).
    expect(r.series.at(-1)!).toBeGreaterThanOrEqual(r.wMid - 1e-9);
  });

  it('явная пара [from, to] отключает подхват: старт из покоя с явного from', () => {
    const r = runCssPickup({
      mode1: { spring: SPRING },
      seekMs: 80,
      to2: ['10px', '300px'] as const,
    });
    expect(r.series[1]!).toBeCloseTo(10, 12); // ребейз на явный from
    expect(r.v).toBeCloseTo(0, 6); // скорость не наследуется
  });

  it('после естественного оседания реестр в покое: следующий ран стартует с v0=0', async () => {
    const f = fakeEl({ width: '0px' });
    const clock = makeClock();
    const first = animate(
      f.el,
      { width: '100px' },
      { duration: 200, ease: linear, requestFrame: clock.requestFrame },
    );
    clock.drain(16);
    await first.finished;
    expect(pxSeries(f.writes, 'width').at(-1)).toBe(100);

    animate(f.el, { width: '300px' }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    const v = impliedPickupVelocity(SPRING, 100, 300, pxSeries(f.writes, 'width').at(-1)!, 0.016);
    expect(v).toBeCloseTo(0, 6);
  });

  it('смешанные виды AST (px → var()): скорость не определена → покой, записи конечны', () => {
    const f = fakeEl({ width: '0px' });
    const clock = makeClock();
    const first = animate(
      f.el,
      { width: '100px' },
      { spring: SPRING, requestFrame: clock.requestFrame },
    );
    first.seek(80);
    animate(f.el, { width: 'var(--w)' }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    expect(allWritesFinite(f.writes)).toBe(true);
  });
});

// ─── Класс А: direct oracle — точная проекция между прогресс-пространствами ──

describe('animate css-канал: проекция скорости точна (Класс А)', () => {
  it('spring→spring: унаследованная скорость — ровно ṗ̂·range старого рана', () => {
    const r = runCssPickup({ mode1: { spring: SPRING }, seekMs: 80, to2: '300px' });
    // Юнитный спан одномерен → доминантная проекция точна: v = ṗ(0.08)·(100−0).
    expect(r.v).toBeCloseTo(pdotAt(0.08) * 100, 6);
  });

  it('tween→spring: линейный ease, k=0.5 → ровно range/duration = 250 units/s', () => {
    const r = runCssPickup({
      mode1: { duration: 400, ease: linear },
      seekMs: 200,
      to2: '300px',
    });
    expect(r.wMid).toBeCloseTo(50, 9);
    expect(r.v).toBeCloseTo(250, 6);
  });

  it('цвет (коллинеарный ретаргет): наследует |v| > 0.6·|v_analytic| доминантного канала', () => {
    const f = fakeEl({ 'background-color': 'rgb(0, 0, 0)' });
    const clock = makeClock();
    const first = animate(
      f.el,
      { backgroundColor: 'rgb(200, 100, 60)' },
      { spring: SPRING, requestFrame: clock.requestFrame },
    );
    first.seek(80);
    const rMid = rgbSeries(f.writes, 'background-color').at(-1)![0]!;
    // Коллинеарный спан (цель ×1.25): проекция по доминантному r-каналу точна.
    animate(
      f.el,
      { backgroundColor: 'rgb(250, 125, 75)' },
      { spring: SPRING, requestFrame: clock.requestFrame },
    );
    clock.step(16);
    clock.step(16);
    const rAtDt = rgbSeries(f.writes, 'background-color').at(-1)![0]!;
    const vInherited = impliedPickupVelocity(SPRING, rMid, 250, rAtDt, 0.016);
    const vAnalytic = pdotAt(0.08) * 200; // ṗ̂·Δr старого спана
    // Округление rgb-эмита до целых даёт ±0.5 на кадр → допуск bite, не exact.
    expect(Math.abs(vInherited)).toBeGreaterThan(0.6 * Math.abs(vAnalytic));
    expect(allWritesFinite(f.writes)).toBe(true);
  });

  it('неколлинеарный ретаргет: доминанта по НОВОМУ спану — без взрывного усиления', () => {
    // Adversarial-находка ревью PR #126: доминанта по СТАРОМУ спану (r: 255)
    // при новом спане, доминантном по b (Δb=250, Δr≈1), давала
    // v0 = ṗ̂·a[r]/b[r] ≈ 1224 прогресс/с — синий канал прыгал 5→255 за один
    // кадр и висел на клампе («violent flash»). Канон dominantV0 (waapi-unit,
    // projection/driver) — доминанта всегда по ЦЕЛЕВОМУ диапазону.
    // RED-факт до фикса: blue уже на первом шаге = 255 (кламп).
    const f = fakeEl({ 'background-color': 'rgb(0, 0, 0)' });
    const clock = makeClock();
    const first = animate(
      f.el,
      { backgroundColor: 'rgb(255, 0, 10)' },
      { spring: SPRING, requestFrame: clock.requestFrame },
    );
    first.seek(80); // захват ≈ rgb(135, 0, 5), ṗ̂ ≈ 4.8/с
    animate(
      f.el,
      { backgroundColor: 'rgb(136, 0, 255)' },
      { spring: SPRING, requestFrame: clock.requestFrame },
    );
    clock.step(16);
    clock.step(16);
    const blues = rgbSeries(f.writes, 'background-color').map((c) => c[2]!);
    // Проекция по доминанте нового спана: v0 = ṗ̂·Δb_old/Δb_new ≈ 0.19/с —
    // за два кадра синий уходит от захвата (≈5) не дальше четверти пути.
    expect(blues.at(-1)!).toBeLessThan(100);
    expect(allWritesFinite(f.writes)).toBe(true);
  });
});

// ─── Класс В: seeded property/fuzz — проекция на масштабе диапазона/времени ──

describe('animate css-канал: скорость против аналитической (Класс В, seeded fuzz)', () => {
  it('300 прогонов: |v_inherited − v_analytic| ≤ 1% шкалы; записи конечны', () => {
    const rnd = lcg(0xc55_5eed);
    for (let i = 0; i < 300; i++) {
      const to1 = (rnd() < 0.5 ? -1 : 1) * (20 + rnd() * 580);
      const tMs = 30 + rnd() * 270;
      // Цель перехвата — дальше по ходу движения: ранние кадры без клампа p.
      const to2 = to1 + Math.sign(to1) * (Math.abs(to1) + 50 + rnd() * 300);
      const f = fakeEl({ width: '0px' });
      const clock = makeClock();
      const first = animate(
        f.el,
        { width: `${to1}px` },
        { spring: SPRING, requestFrame: clock.requestFrame },
      );
      first.seek(tMs);
      const wMid = pxSeries(f.writes, 'width').at(-1)!;
      animate(f.el, { width: `${to2}px` }, { spring: SPRING, requestFrame: clock.requestFrame });
      clock.step(16);
      clock.step(16);
      const wAtDt = pxSeries(f.writes, 'width').at(-1)!;
      const v = impliedPickupVelocity(SPRING, wMid, to2, wAtDt, 0.016);
      const vAnalytic = pdotAt(tMs / 1000) * to1;
      const err = Math.abs(v - vAnalytic);
      if (err > 0.01 * Math.max(Math.abs(vAnalytic), 1)) {
        throw new Error(
          `drift: to1=${to1} tMs=${tMs} to2=${to2} v=${v} analytic=${vAnalytic} err=${err}`,
        );
      }
      if (!allWritesFinite(f.writes)) {
        throw new Error(`non-finite write: to1=${to1} tMs=${tMs} to2=${to2}`);
      }
    }
  }, 30_000);
});
