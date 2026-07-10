/**
 * test/continuity-differential-matrix.test.ts — ФИНАЛЬНАЯ фиксация единого
 * C¹-контракта пакета (#93, срез 6): систематическая матрица ПАРЫ ПЕРЕХОДОВ ×
 * ПРОВЕРКИ. Все пары реализованы срезами 1–5 — сьют born-green фиксирует
 * контракт целиком; любой RED здесь = найденный дефект контракта.
 *
 * Классы: Б (characterization-пины стыков) + А (direct oracle: бит-в-бит
 * против solveSpring/readCompositorSpring/springUnchecked) + В (seeded LCG
 * fuzz на финитность) + Д (mutation proof ниже).
 *
 * ── ПАРЫ (строки матрицы) ────────────────────────────────────────────────────
 *   P1  mv-retarget         spring→spring: MotionValue.setTarget в полёте
 *   P2  drive-drive         spring→spring: drive → drive c initialVelocity
 *   P3  tween-spring        tween→spring: animate() перехват (transform-канал)
 *   P4  decay-spring        decay→spring: gestures snapBackSpring на границе
 *   P5  glide-drag          glide→drag pickup (синтетический сэмпл трекера)
 *   P6  compositor-gesture  readCompositorSpring → pointerDown(p, pickup)
 *   P7  compositor-live     handoffToLive (compositor → live MotionValue)
 *   P8  presence-reverse    presence exit→enter (reversed continuation)
 *   P9  css-spring          css-канал spring→spring (animate, projectCssV0)
 *   P10 driver-mv           driver-хендл → MotionValue (controls.velocity)
 *
 * ── ПРОВЕРКИ (столбцы матрицы) ───────────────────────────────────────────────
 *   C0      первый кадр приёмника = точка захвата (непрерывность позиции)
 *   C1      скорость унаследована (точно / в допуске с обоснованием)
 *   SIGN    знак скорости сохранён на стыке
 *   DEGEN   вырожденный вход стыка → скорость ровно 0 / инертный стык
 *   NONFIN  non-finite вход → ровно 0 или fail-fast (по канону пути)
 *   REDUCE  prefers-reduced-motion: CHARACTER-switch, импульс не течёт
 *   REST    покой → скорость ровно 0 (стык из покоя стартует из покоя)
 *   UNITS   единицы units/s согласованы через стык (сдвиг ×1000 кусается)
 *   CLAMP   clamp не искажает hidden state (скорость — аналитика траектории)
 *   SETTLE  оседание на цели точное (=== цель, не «рядом»)
 *   FINITE  финитность всех эмиссий (в т.ч. на злых входах, seeded LCG)
 *
 * Полная карта покрытия — константа MATRIX ниже: каждая клетка обязана быть
 * либо 'covered' (тогда есть тест), либо 'N/A: причина' — молчаливых клеток
 * нет, это стережёт мета-тест «матрица как спецификация».
 *
 * ── ПУНКТ Б (#93 срез 6): публичное чтение velocity у хендла animate() ──────
 * НЕ-ЦЕЛЬ среза, отложено до #127 (ленивый dpdt освободит байты). Факты:
 * animate-one-liner = 11198/11200 gz (запас 2 байта), full-core = 2299/2300
 * (запас 1 байт) — любой рост фасада ломает размерный гейт, а геттер velocity
 * на агрегированных контролах требует ещё и дизайна per-канальной адресации
 * (какой канал какой цели читать). Аналитическое чтение при этом УЖЕ есть:
 * внутренний capture-канал (реестр groupRecord: numeric[].velocity, css.dpdt)
 * питает C¹-подхват (пары P3/P9), а публичные хендлы с чтением — у ядра:
 * MotionValue.velocity (P1) и driver controls.velocity (P10). Характеризация
 * текущего хендла закреплена в describe «пункт Б» ниже.
 *
 * ── ПУНКТ В: один канонический солвер main/compositor ───────────────────────
 * readCompositorSpring НЕ несёт второй копии математики — внутри тот же
 * internal/solver.solveSpring, что у main-пути (springUnchecked, MotionValue,
 * drive, driver) и у сегментера (makeSpringValueSampler). Пин ниже фиксирует
 * бит-в-бит паритет всех трёх точек на сетке (under/critical/over × t × v0):
 * подмена/раздвоение солвера кусается точным toBe.
 *
 * ── MUTATION PROOF (8 мутантов посеяны руками в РАЗНЫЕ пары, каждый кусался,
 *    откачены; перечислены ФАКТИЧЕСКИЕ падения этого сьюта) ───────────────────
 *   [M1 sign-v0 → P1]      motion-value.ts setTarget: захват скорости с
 *                          минусом (−this._velocity) → 6 RED: P1×C1 (ratio −1),
 *                          P1×SIGN, P7×C1 (differential-хвост разошёлся),
 *                          P7×SIGN, P7×UNITS, P8×SIGN.
 *   [M2 capture-loss → P7/P8/P10] motion-value.ts: игнорировать
 *                          opts.initialVelocity (:= 0) → 9 RED: P1×NONFIN
 *                          (fail-fast донора исчез), P7×C1/SIGN/UNITS,
 *                          P8×C1/SIGN, P10×C1/SIGN/NONFIN.
 *   [M3 sample-sign → P5/P6] gestures pointerDown: синтетический сэмпл вдоль
 *                          +v (x + vx·Δt вместо x − vx·Δt) → 4 RED:
 *                          P5×SIGN/SETTLE, P6×SIGN/SETTLE (унаследованная
 *                          скорость зеркалится, объект едет назад).
 *   [M4 clamp-kill → P1/P7/P8] motion-value.ts _tick: velocity := 0 при
 *                          clamp:true → 9 RED: P1×C0/C1/SIGN/DEGEN/REST/CLAMP,
 *                          P7×CLAMP, P8×SIGN/CLAMP (hidden state мёртв).
 *   [M5 solver-swap → пин В] compositor readCompositorSpring: t·(1+1e-7)
 *                          (вторая «почти та же» математика) → 2 RED: оба
 *                          compositor-пина паритета (нормированный 0→1 и
 *                          денормализация) — toBe бит-в-бит кусается.
 *   [M6 units → P10]       driver.ts velocity: ÷1000 (units/ms) → 2 RED:
 *                          P10×UNITS (бит-оракул springUnchecked·range),
 *                          P10×CLAMP.
 *   [M7 units → P3/P9]     main-unit.ts tween dpdt: slope/durationMs без
 *                          ×1000 → 4 RED: P3×C1 (250→0.25), P3×SIGN,
 *                          P3×UNITS (500→0.5), P9×UNITS.
 *   [M8 v0-norm → P2]      drive.ts: нормировка v0·range вместо v0/range →
 *                          3 RED: P2×C1 (оракул расходится со 2-го кадра),
 *                          P2×UNITS, P2×CLAMP.
 *
 * Детерминизм: время только через инжектируемые часы; фазз — seeded LCG.
 */

import { describe, expect, it } from 'vitest';
import { MotionParamError, MotionValue, drive } from '../src/index.js';
import { createDriver } from '../src/driver.js';
import { createDrag } from '../src/gestures/index.js';
import { createDecay } from '../src/decay.js';
import { createPresence, type PresenceSnapshot } from '../src/presence/index.js';
import {
  CompositorSpring,
  handoffToLive,
  readCompositorSpring,
} from '../src/compositor/index.js';
import { makeSpringValueSampler, solveSpring } from '../src/internal/solver.js';
import { springUnchecked, type SpringParams } from '../src/spring.js';
import { FIXED_DT_S } from '../src/internal/constants.js';
import { linear } from '../src/easing/index.js';
import * as animateApi from '../src/animate/index.js';
import {
  allWritesFinite,
  drainClock,
  fakeEl,
  fakeWaapiEl,
  impliedPickupVelocity,
  lcg,
  makeClock,
  makeVirtualClock,
  pickAnimate,
  pumpClock,
  reduceMedia,
  translateXSeries,
} from './continuity-helpers.js';

const animate = pickAnimate(animateApi as Record<string, unknown>);

// ─── Пружины сьюта ────────────────────────────────────────────────────────────

/** ζ≈0.707 — канон retarget-тестов ядра. */
const STD: SpringParams = { mass: 1, stiffness: 200, damping: 20 };
/** ζ≈0.354 — overshoot реален: различает clamp-политики. */
const UNDER: SpringParams = { mass: 1, stiffness: 200, damping: 10 };
/** ζ=1 точно (критическое демпфирование). */
const CRIT: SpringParams = { mass: 1, stiffness: 100, damping: 20 };
/** ζ≈2.12 (передемпфированная). */
const OVER: SpringParams = { mass: 1, stiffness: 50, damping: 30 };
/** Канон фасада/compositor-тестов. */
const S170: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
/** Упругая (ζ≈0.298) — для differential-хвостов хендоффа. */
const BOUNCY: SpringParams = { mass: 1, stiffness: 180, damping: 8 };

// ─── Спецификация матрицы ─────────────────────────────────────────────────────

const CHECK_IDS = [
  'C0',
  'C1',
  'SIGN',
  'DEGEN',
  'NONFIN',
  'REDUCE',
  'REST',
  'UNITS',
  'CLAMP',
  'SETTLE',
  'FINITE',
] as const;
type CheckId = (typeof CHECK_IDS)[number];

const PAIRS = [
  { id: 'P1', title: 'spring→spring: MotionValue retarget' },
  { id: 'P2', title: 'spring→spring: drive → drive c initialVelocity' },
  { id: 'P3', title: 'tween→spring: animate() перехват' },
  { id: 'P4', title: 'decay→spring: gestures snapBackSpring на границе' },
  { id: 'P5', title: 'glide→drag pickup (синтетический сэмпл)' },
  { id: 'P6', title: 'compositor→gesture: readCompositorSpring → pointerDown pickup' },
  { id: 'P7', title: 'compositor→live: handoffToLive' },
  { id: 'P8', title: 'presence exit→enter (reversed continuation)' },
  { id: 'P9', title: 'css-канал spring→spring (animate, projectCssV0)' },
  { id: 'P10', title: 'driver-хендл → MotionValue (controls.velocity)' },
] as const;
type PairId = (typeof PAIRS)[number]['id'];

/**
 * Карта покрытия — читается как спецификация: 'covered' ⇔ ниже есть тест
 * клетки; 'N/A: причина' — проверка неприменима к природе пары, причина
 * обязательна (мета-тест не пропустит молчание).
 */
const MATRIX: Record<PairId, Record<CheckId, string>> = {
  P1: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE:
      'N/A: MotionValue — headless-ядро без matchMedia-шва; CHARACTER-switch делают биндинги через snapTo (velocity→0 закреплён в REST)',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP: 'covered',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P2: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP: 'covered',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P3: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP:
      'N/A: фасад не экспонирует clamp-режим канала; политика «скорость = hidden-state, не производная клампа» закреплена на ядре (P1/P10×CLAMP)',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P4: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP: 'covered',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P5: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS:
      'N/A: прайор и секансы — одно px/s-пространство без конверсии; сдвиг единиц ×1000 в сиде кусается окном 0.65–1.05 клетки C1',
    CLAMP: 'N/A: bounds в стыке пары не участвуют; clamp×hidden-state — P4×CLAMP',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P6: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP:
      'N/A: клампа на стыке нет — жест наследует hidden-state замкнутой формы как есть (кламп compositor-канала не существует)',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P7: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE:
      'N/A: headless-мост без matchMedia-шва; reduced-политику применяет вызывающий ДО хендоффа (закреплено P3/P8/P10×REDUCE)',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP: 'covered',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P8: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS:
      'N/A: снимок — непрозрачный S: машина не преобразует единицы, наследование поля velocity бит-в-бит закреплено клеткой C1',
    CLAMP: 'covered',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P9: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP: 'covered',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
  P10: {
    C0: 'covered',
    C1: 'covered',
    SIGN: 'covered',
    DEGEN: 'covered',
    NONFIN: 'covered',
    REDUCE: 'covered',
    REST: 'covered',
    UNITS: 'covered',
    CLAMP: 'covered',
    SETTLE: 'covered',
    FINITE: 'covered',
  },
};

// ─── P1: spring→spring — MotionValue retarget ────────────────────────────────

/** Живой ран 0→100, 5 кадров транзиента: возвращает точку захвата. */
function p1Vertical() {
  const clock = makeVirtualClock();
  const emits: number[] = [];
  const mv = new MotionValue({ initial: 0, spring: STD, requestFrame: clock.requestFrame });
  mv.onChange((v) => emits.push(v));
  mv.setTarget(100);
  clock.drain(5);
  return { clock, mv, emits, grabValue: mv.value, grabVelocity: mv.velocity };
}

const P1_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const { clock, mv, emits, grabValue, grabVelocity } = p1Vertical();
    expect(Math.abs(grabVelocity)).toBeGreaterThan(1); // ран живой
    mv.setTarget(30);
    const n = emits.length;
    clock.drain(1); // кадр elapsed=0 нового рана
    expect(emits[n]).toBe(grabValue); // рождение ровно в точке захвата (бит-в-бит)
    mv.destroy();
  },
  C1() {
    const { clock, mv, grabValue, grabVelocity } = p1Vertical();
    const target2 = 30;
    mv.setTarget(target2);
    const range2 = target2 - grabValue;
    const v0n = grabVelocity / range2; // та же нормировка, что smooth pickup
    clock.drain(1);
    // Бит-в-бит оракул: elapsed=0 → скорость = v0n·range2 (round-trip ≤ 1 ulp).
    expect(mv.velocity).toBe(solveSpring(STD, 0, v0n).velocity * range2);
    expect(mv.velocity / grabVelocity).toBeCloseTo(1, 10);
    mv.destroy();
  },
  SIGN() {
    const { clock, mv, grabVelocity } = p1Vertical();
    expect(grabVelocity).toBeGreaterThan(0); // едем вверх
    mv.setTarget(0); // ретаргет ЗА спину
    clock.drain(1);
    expect(Math.sign(mv.velocity)).toBe(1); // импульс не перевёрнут целью
    mv.destroy();
  },
  DEGEN() {
    const { clock, mv } = p1Vertical();
    expect(Math.abs(mv.velocity)).toBeGreaterThan(1);
    const here = mv.value;
    mv.setTarget(here); // вырожденный range≈0 при живой скорости
    clock.drain(1);
    expect(mv.value).toBe(here); // снап в цель
    expect(Object.is(mv.velocity, 0)).toBe(true); // скорость РОВНО 0, не −0
    mv.destroy();
  },
  NONFIN() {
    const { mv } = p1Vertical();
    expect(() => mv.setTarget(Number.NaN)).toThrow(MotionParamError);
    expect(() => mv.snapTo(Number.POSITIVE_INFINITY)).toThrow(MotionParamError);
    mv.destroy();
    // Донор скорости обязан падать fail-fast, не «молча из покоя».
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        () => new MotionValue({ initial: 0, spring: STD, initialVelocity: bad }),
      ).toThrow(MotionParamError);
    }
  },
  REST() {
    const { clock, mv } = p1Vertical();
    clock.drainAll(2500);
    expect(mv.value).toBe(100);
    expect(mv.velocity).toBe(0); // сходимость → покой ровно 0
    mv.setTarget(0);
    clock.drain(3);
    expect(mv.velocity).not.toBe(0);
    mv.snapTo(50); // CHARACTER-switch биндингов
    expect(mv.velocity).toBe(0);
    expect(mv.value).toBe(50);
    mv.destroy();
  },
  UNITS() {
    // Секанс эмиссий (units за СЕКУНДЫ виртуального клока) сходится к
    // аналитической velocity — сдвиг единиц (мс/кадры) дал бы расхождение ×10³.
    const clock = makeVirtualClock();
    const emits: number[] = [];
    const mv = new MotionValue({
      initial: 0,
      spring: STD,
      clamp: false,
      requestFrame: clock.requestFrame,
    });
    mv.onChange((v) => emits.push(v));
    mv.setTarget(100);
    clock.drain(2); // подписка(0) + кадр1(elapsed 0) + кадр2
    const v1 = mv.velocity;
    clock.drain(1);
    const v2 = mv.velocity;
    const dtS = (clock.stamps[2]! - clock.stamps[1]!) / 1000;
    const secant = (emits[3]! - emits[2]!) / dtS;
    const avg = (v1 + v2) / 2; // трапеция: |err| ~ h²·x‴/12 ≪ 5%
    expect(Math.abs(secant - avg)).toBeLessThan(0.05 * Math.abs(avg));
    mv.destroy();
  },
  CLAMP() {
    // Два инстанса clamp:true/false на идентичных часах: скрытая скорость
    // БИТ-В-БИТ одна (clamp искажает только эмит, не state), эмиссии
    // clamp:true не выходят из [from,target], clamp:false честно выходят.
    const mk = (clamp: boolean) => {
      const clock = makeVirtualClock();
      const emits: number[] = [];
      const mv = new MotionValue({
        initial: 0,
        spring: UNDER,
        clamp,
        initialVelocity: 1500,
        requestFrame: clock.requestFrame,
      });
      mv.onChange((v) => emits.push(v));
      mv.setTarget(100);
      return { clock, mv, emits };
    };
    const a = mk(true);
    const b = mk(false);
    for (let i = 0; i < 40 && a.clock.queueLength() > 0 && b.clock.queueLength() > 0; i++) {
      a.clock.drain(1);
      b.clock.drain(1);
      expect(a.mv.velocity).toBe(b.mv.velocity); // hidden state не искажён
    }
    expect(Math.max(...a.emits)).toBeLessThanOrEqual(100);
    expect(Math.max(...b.emits)).toBeGreaterThan(100); // честный overshoot
    a.mv.destroy();
    b.mv.destroy();
  },
  SETTLE() {
    const { clock, mv, emits } = p1Vertical();
    mv.setTarget(30); // ретаргет в полёте
    clock.drainAll(2500);
    expect(mv.value).toBe(30); // ровно цель
    expect(emits[emits.length - 1]).toBe(30);
    mv.destroy();
  },
  FINITE() {
    const rnd = lcg(0x5eed_0601);
    const springs = [STD, UNDER, CRIT, OVER];
    for (let i = 0; i < 150; i++) {
      const clock = makeVirtualClock();
      const mv = new MotionValue({
        initial: (rnd() - 0.5) * 2000,
        spring: springs[i % springs.length]!,
        initialVelocity: (rnd() - 0.5) * 2e4,
        clamp: rnd() < 0.5,
        requestFrame: clock.requestFrame,
      });
      mv.onChange((v) => {
        if (!Number.isFinite(v)) throw new Error(`non-finite эмиссия ${v} на прогоне ${i}`);
      });
      mv.setTarget((rnd() - 0.5) * 2000);
      clock.drain(1 + Math.floor(rnd() * 30));
      mv.setTarget((rnd() - 0.5) * 2000); // ретаргет в полёте
      clock.drainAll(2500);
      if (clock.queueLength() === 0) expect(mv.velocity).toBe(0);
      mv.destroy();
    }
  },
};

// ─── P2: spring→spring — drive → drive c initialVelocity ────────────────────

/**
 * Вертикаль: источник — drive 0→100 из покоя (6 кадров); пара (value, v)
 * снимается замкнутой формой (у drive нет хендла — канон чтения см. P10);
 * приёмник — drive(from=value, to=300, initialVelocity=v).
 */
function p2Vertical() {
  const clock1 = makeVirtualClock();
  const emitted1: number[] = [];
  void drive({
    from: 0,
    to: 100,
    spring: STD,
    clamp: false,
    onStep: (v) => emitted1.push(v),
    requestFrame: clock1.requestFrame,
  });
  clock1.drain(6);
  const elapsedK = (clock1.stamps[5]! - clock1.stamps[0]!) / 1000;
  const grabValue = emitted1[emitted1.length - 1]!;
  const grabVelocity = solveSpring(STD, elapsedK, 0).velocity * 100;
  expect(grabValue).toBe(solveSpring(STD, elapsedK, 0).value * 100); // санити источника
  return { grabValue, grabVelocity };
}

const P2_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const { grabValue, grabVelocity } = p2Vertical();
    const clock = makeVirtualClock();
    const emitted: number[] = [];
    void drive({
      from: grabValue,
      to: 300,
      spring: STD,
      clamp: false,
      initialVelocity: grabVelocity,
      onStep: (v) => emitted.push(v),
      requestFrame: clock.requestFrame,
    });
    clock.drain(1); // кадр 1: elapsed 0
    expect(emitted[0]).toBe(grabValue); // первая эмиссия — ровно точка захвата
  },
  C1() {
    const { grabValue, grabVelocity } = p2Vertical();
    const clock = makeVirtualClock();
    const emitted: number[] = [];
    void drive({
      from: grabValue,
      to: 300,
      spring: STD,
      clamp: false,
      initialVelocity: grabVelocity,
      onStep: (v) => emitted.push(v),
      requestFrame: clock.requestFrame,
    });
    clock.drain(8);
    const range = 300 - grabValue;
    const v0n = grabVelocity / range; // та же нормировка, что drive()
    for (let k = 0; k < emitted.length; k++) {
      const elapsed = (clock.stamps[k]! - clock.stamps[0]!) / 1000;
      // Бит-в-бит: приёмник продолжает ТОЙ ЖЕ математикой с унаследованным v0.
      expect(emitted[k]).toBe(grabValue + solveSpring(STD, elapsed, v0n).value * range);
    }
  },
  SIGN() {
    const clock = makeVirtualClock();
    const emitted: number[] = [];
    void drive({
      from: 0,
      to: 100,
      spring: STD,
      clamp: false,
      initialVelocity: -800, // импульс ОТ цели
      onStep: (v) => emitted.push(v),
      requestFrame: clock.requestFrame,
    });
    clock.drain(3);
    expect(emitted[1]!).toBeLessThan(emitted[0]!); // знак скорости сохранён
  },
  async DEGEN() {
    let steps = 0;
    let frames = 0;
    await drive({
      from: 5,
      to: 5, // вырожденный range
      spring: STD,
      initialVelocity: 900,
      onStep: () => steps++,
      requestFrame: () => {
        frames++;
        return 1;
      },
    });
    expect(steps).toBe(0); // v0 не оживляет вырожденный прогон
    expect(frames).toBe(0);
  },
  NONFIN() {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let frames = 0;
      expect(() =>
        drive({
          from: 0,
          to: 100,
          spring: STD,
          initialVelocity: bad,
          onStep: () => {},
          requestFrame: () => {
            frames++;
            return 1;
          },
        }),
      ).toThrow(MotionParamError);
      expect(frames).toBe(0); // fail-fast: до Promise и до единого кадра
    }
  },
  async REDUCE() {
    let frames = 0;
    const emitted: number[] = [];
    await drive({
      from: 0,
      to: 100,
      spring: STD,
      initialVelocity: 5000, // импульс не течёт в CHARACTER-switch
      matchMedia: reduceMedia(),
      onStep: (v) => emitted.push(v),
      requestFrame: () => {
        frames++;
        return 1;
      },
    });
    expect(emitted).toEqual([100]); // ровно один снап в цель
    expect(frames).toBe(0);
  },
  REST() {
    // Опция опущена ≡ initialVelocity: 0 — рождение из покоя бит-в-бит.
    const run = (withOption: boolean): number[] => {
      const clock = makeVirtualClock();
      const emitted: number[] = [];
      void drive({
        from: 0,
        to: 100,
        spring: STD,
        onStep: (v) => emitted.push(v),
        requestFrame: clock.requestFrame,
        ...(withOption ? { initialVelocity: 0 } : {}),
      });
      clock.drain(10);
      return emitted;
    };
    const a = run(false);
    const b = run(true);
    expect(a.length).toBeGreaterThan(2);
    expect(b).toEqual(a);
  },
  UNITS() {
    // Средняя скорость первого кадра ≈ V units/s (демпфирование за 8.3 мс мало́):
    // сдвиг единиц ×1000 дал бы секанс ~2 units/s вместо ~2000.
    const clock = makeVirtualClock(1000 / 120);
    const V = 2000;
    const emitted: number[] = [];
    void drive({
      from: 0,
      to: 100,
      spring: STD,
      clamp: false,
      initialVelocity: V,
      onStep: (v) => emitted.push(v),
      requestFrame: clock.requestFrame,
    });
    clock.drain(2);
    const dtS = (clock.stamps[1]! - clock.stamps[0]!) / 1000;
    const secant = (emitted[1]! - emitted[0]!) / dtS;
    expect(Math.abs(secant - V)).toBeLessThan(0.15 * V);
  },
  CLAMP() {
    // Кламп — трансформация ЭМИТА, не состояния: клампованные эмиссии бит-в-бит
    // равны монотонному клампу ТОЙ ЖЕ сырой аналитической траектории с v0
    // (clamp:false-ран на идентичных часах). Ранний settle насыщенного клампа —
    // документированная политика drive (visual-saturation), не искажение v0.
    const V = 1500;
    const run = (clamp: boolean): number[] => {
      const clock = makeVirtualClock();
      const emitted: number[] = [];
      void drive({
        from: 0,
        to: 100,
        spring: STD,
        clamp,
        initialVelocity: V,
        onStep: (v) => emitted.push(v),
        requestFrame: clock.requestFrame,
      });
      clock.drainAll(2500);
      return emitted;
    };
    const raw = run(false);
    const clamped = run(true);
    expect(Math.max(...raw)).toBeGreaterThan(100); // скрытая траектория честно летит за to
    expect(clamped.length).toBeGreaterThan(3);
    let maxToward = 0;
    for (let k = 0; k < clamped.length - 1; k++) {
      maxToward = Math.max(maxToward, Math.max(0, Math.min(100, raw[k]!)));
      expect(clamped[k]).toBe(maxToward); // тот же hidden state под клампом
    }
    for (const v of clamped) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(clamped[clamped.length - 1]).toBe(100);
  },
  SETTLE() {
    for (const V of [5000, -5000]) {
      for (const clampMode of [true, false]) {
        const clock = makeVirtualClock();
        const emitted: number[] = [];
        void drive({
          from: 100,
          to: -50,
          spring: STD,
          clamp: clampMode,
          initialVelocity: V,
          onStep: (v) => emitted.push(v),
          requestFrame: clock.requestFrame,
        });
        clock.drainAll(2500);
        expect(emitted[emitted.length - 1], `V=${V} clamp=${clampMode}`).toBe(-50);
      }
    }
  },
  FINITE() {
    const rnd = lcg(0x5eed_0602);
    const springs = [STD, UNDER, CRIT, OVER];
    for (let i = 0; i < 300; i++) {
      const clock = makeVirtualClock();
      const v0 = (rnd() < 0.5 ? -1 : 1) * 10 ** (rnd() * 8 - 2);
      void drive({
        from: (rnd() - 0.5) * 2000,
        to: (rnd() - 0.5) * 2000,
        spring: springs[i % springs.length]!,
        clamp: rnd() < 0.5,
        initialVelocity: v0,
        onStep: (v) => {
          if (!Number.isFinite(v)) throw new Error(`non-finite эмиссия ${v}, прогон ${i}`);
        },
        requestFrame: clock.requestFrame,
      });
      clock.drain(160);
    }
  },
};

// ─── P3: tween→spring — animate() перехват (transform-канал) ────────────────

/** Сценарий «tween прерван spring-раном» (канон animate-tween-velocity-pickup). */
function p3Intercept(opts: {
  durationMs: number;
  ease: (t: number) => number;
  seekMs: number;
  to1?: number | readonly [number, number];
  to2: number;
}) {
  const f = fakeEl();
  const clock = makeClock();
  const first = animate(
    f.el,
    { x: opts.to1 ?? 100 },
    { duration: opts.durationMs, ease: opts.ease, requestFrame: clock.requestFrame },
  );
  first.seek(opts.seekMs);
  const xMid = translateXSeries(f.writes).at(-1)!;
  animate(f.el, { x: opts.to2 }, { spring: S170, requestFrame: clock.requestFrame });
  clock.step(16); // кадр 1 нового рана: elapsed 0
  clock.step(16); // кадр 2: elapsed 16 мс
  const xs = translateXSeries(f.writes);
  return { f, clock, xMid, xs };
}

const P3_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const r = p3Intercept({ durationMs: 400, ease: linear, seekMs: 170, to2: 300 });
    expect(r.xs.at(-2)!).toBeCloseTo(r.xMid, 9); // кадр elapsed=0 = точка захвата
  },
  C1() {
    const r = p3Intercept({ durationMs: 400, ease: linear, seekMs: 200, to2: 300 });
    expect(r.xMid).toBeCloseTo(50, 9);
    const v = impliedPickupVelocity(S170, r.xMid, 300, r.xs.at(-1)!, 0.016);
    expect(v).toBeCloseTo(250, 6); // ровно range/duration·1000 (линейный ease)
  },
  SIGN() {
    const r = p3Intercept({
      durationMs: 400,
      ease: linear,
      seekMs: 200,
      to1: [100, 0] as const, // движение ВНИЗ
      to2: 300,
    });
    const v = impliedPickupVelocity(S170, r.xMid, 300, r.xs.at(-1)!, 0.016);
    expect(v).toBeCloseTo(-250, 6); // знак движения источника сохранён
  },
  DEGEN() {
    // Перехват в ТУ ЖЕ точку (range₂ = 0) при живой скорости tween:
    // вырожденный ран снапается, скорость не «оживляет» его.
    const r = p3Intercept({ durationMs: 400, ease: linear, seekMs: 200, to2: 50 });
    expect(r.xMid).toBeCloseTo(50, 9);
    expect(r.xs.at(-1)!).toBe(50); // остался ровно в точке
    expect(allWritesFinite(r.f.writes)).toBe(true);
  },
  NONFIN() {
    const f = fakeEl();
    expect(() => animate(f.el, { x: Number.NaN })).toThrow(MotionParamError);
    expect(f.writes).toHaveLength(0); // fail-fast ДО записей в стиль
  },
  REDUCE() {
    const f = fakeEl();
    const clock = makeClock();
    const first = animate(
      f.el,
      { x: 100 },
      { duration: 400, ease: linear, requestFrame: clock.requestFrame },
    );
    first.seek(200); // tween в полёте
    animate(f.el, { x: 300 }, { spring: S170, matchMedia: reduceMedia(), requestFrame: clock.requestFrame });
    expect(translateXSeries(f.writes).at(-1)).toBe(300); // мгновенный снап в цель
    const writesBefore = f.writes.length;
    clock.drain(16);
    expect(f.writes.length).toBe(writesBefore); // импульс не течёт: кадров нет
  },
  async REST() {
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
    animate(f.el, { x: 300 }, { spring: S170, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    const v = impliedPickupVelocity(S170, 100, 300, translateXSeries(f.writes).at(-1)!, 0.016);
    expect(v).toBeCloseTo(0, 6); // после оседания реестр в покое
  },
  UNITS() {
    // Деление на СЕКУНДЫ длительности: вдвое короче tween → вдвое выше скорость.
    const r = p3Intercept({ durationMs: 200, ease: linear, seekMs: 100, to2: 300 });
    const v = impliedPickupVelocity(S170, r.xMid, 300, r.xs.at(-1)!, 0.016);
    expect(v).toBeCloseTo(500, 5); // 100/200·1000
  },
  SETTLE() {
    const r = p3Intercept({ durationMs: 400, ease: linear, seekMs: 200, to2: 300 });
    r.clock.drain(16);
    expect(translateXSeries(r.f.writes).at(-1)).toBe(300); // ровно цель
  },
  FINITE() {
    const r = p3Intercept({ durationMs: 400, ease: () => Number.NaN, seekMs: 200, to2: 300 });
    expect(r.xMid).toBeCloseTo(50, 9); // враждебный ease → линейный кадр
    const v = impliedPickupVelocity(S170, r.xMid, 300, r.xs.at(-1)!, 0.016);
    expect(v).toBeCloseTo(0, 6); // NaN-производная не сеется в v0
    r.clock.drain(16);
    expect(allWritesFinite(r.f.writes)).toBe(true);
  },
};

// ─── P4: decay→spring — gestures snapBackSpring на границе ──────────────────

const SNAP: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

/** Стандартный флик вправо (vx = 100/0.08 = 1250 px/s на release). */
function p4Flick(
  clock: ReturnType<typeof pumpClock>,
  opts: Parameters<typeof createDrag>[0] = {},
) {
  const d = createDrag({ requestFrame: clock.requestFrame, ...opts });
  d.pointerDown({ x: 0, y: 0, t: 0 });
  for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
  d.pointerUp({ x: 100, y: 0, t: 0.08 });
  return d;
}

/** Прогон snap-back до оседания с журналом глайд-кадров и их ts. */
function p4Run(opts: Parameters<typeof createDrag>[0] = {}) {
  const clock = pumpClock();
  const steps: number[] = [];
  const restXs: number[] = [];
  const d = p4Flick(clock, {
    bounds: { x: { min: 0, max: 150 } },
    snapBackSpring: SNAP,
    onStep: (x) => steps.push(x),
    onRest: (x) => restXs.push(x),
    ...opts,
  });
  const glide: number[] = [];
  const pumped: number[] = [];
  for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) {
    const before = steps.length;
    clock.pump(ts);
    if (steps.length > before) {
      glide.push(steps[steps.length - 1]!);
      pumped.push(ts);
    }
  }
  return { d, steps, glide, pumped, restXs, clock };
}

const P4_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    // Кадр стыка лежит НА decay-траектории (C⁰: пружина рождается в сыром
    // значении decay за границей, без телепорта на границу).
    const { glide, pumped } = p4Run();
    const model = createDecay({ from: 100, velocity: (100 - 0) / (0.08 - 0) });
    let elapsed = 0;
    let lastTs: number | undefined;
    let k = -1;
    for (let i = 0; i < glide.length; i++) {
      elapsed = lastTs === undefined ? elapsed : elapsed + Math.max(0, (pumped[i]! - lastTs) / 1000);
      lastTs = pumped[i]!;
      if (glide[i]! > 150) {
        k = i;
        break;
      }
      expect(glide[i]).toBe(model.valueAt(elapsed)); // до стыка — чистый decay
    }
    expect(k).toBeGreaterThan(0);
    expect(glide[k]).toBe(model.valueAt(elapsed)); // кадр стыка бит-в-бит на decay
  },
  C1() {
    const { glide } = p4Run();
    const k = glide.findIndex((x) => x > 150);
    expect(k).toBeGreaterThan(0);
    const dt = 0.016;
    const secBefore = (glide[k]! - glide[k - 1]!) / dt; // decay-производная у касания
    const secAfter = (glide[k + 1]! - glide[k]!) / dt; // первый чисто пружинный шаг
    expect(secBefore).toBeGreaterThan(0);
    // C¹ — ДВУСТОРОННЕЕ окно [0.65, 1.05]·secBefore (факт: ratio≈0.815): пружина
    // рождается со скоростью decay у касания и за один 16 мс кадр слегка тормозит
    // восстанавливающей силой. Только нижний порог (>0.5·) пропускал бы мутанта,
    // РАЗДУВШЕГО скорость подхвата (secAfter ≫ secBefore) — верхняя граница ловит
    // его; это же окно — обоснование N/A клеток P4×UNITS (сдвиг единиц ×1000).
    expect(secAfter).toBeGreaterThan(0.65 * secBefore);
    expect(secAfter).toBeLessThan(1.05 * secBefore);
  },
  SIGN() {
    // Флик влево на min-границе: импульс сохраняет знак — провал НИЖЕ min.
    const clock = pumpClock();
    const steps: number[] = [];
    const d = createDrag({
      requestFrame: clock.requestFrame,
      bounds: { x: { min: -150, max: 0 } },
      snapBackSpring: SNAP,
      onStep: (x) => steps.push(x),
    });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: -i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: -100, y: 0, t: 0.08 });
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(Math.min(...steps)).toBeLessThan(-150);
    expect(d.x).toBe(-150);
  },
  DEGEN() {
    // Вырожденный стык: граница недостижима → пружина не рождается,
    // траектория бит-в-бит прежняя (snapBackSpring инертна без касания).
    const run = (withSnap: boolean): number[] => {
      const clock = pumpClock();
      const steps: number[] = [];
      const d = p4Flick(clock, {
        bounds: { x: { min: -1e6, max: 1e6 } },
        ...(withSnap ? { snapBackSpring: SNAP } : {}),
        onStep: (x) => steps.push(x),
      });
      for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
      return steps;
    };
    const a = run(false);
    const b = run(true);
    expect(a.length).toBeGreaterThan(2);
    expect(b).toEqual(a);
  },
  NONFIN() {
    for (const bad of [
      { mass: 1, stiffness: Number.NaN, damping: 20 },
      { mass: 0, stiffness: 200, damping: 20 },
      { mass: 1, stiffness: 200, damping: -1 },
    ]) {
      expect(() => createDrag({ snapBackSpring: bad })).toThrow(MotionParamError);
    }
  },
  REDUCE() {
    const clock = pumpClock();
    const restXs: number[] = [];
    const d = p4Flick(clock, {
      bounds: { x: { min: 0, max: 150 } },
      snapBackSpring: SNAP,
      matchMedia: reduceMedia(),
      onRest: (x) => restXs.push(x),
    });
    expect(clock.queue.length).toBe(0); // CHARACTER-switch: ни одного кадра
    expect(d.gliding).toBe(false);
    expect(d.x).toBe(150); // снап в клампнутую точку покоя
    expect(restXs).toEqual([150]);
  },
  REST() {
    // После оседания стык мёртв: дальнейшие кадры не двигают позицию.
    const { d, clock } = p4Run();
    expect(d.gliding).toBe(false);
    const settled = d.x;
    clock.pump(20_000);
    clock.pump(20_016);
    expect(d.x).toBe(settled);
  },
  UNITS() {
    // Скорость release известна: слоуп трекера 1250 px/s. Секанс первого
    // глайд-шага обязан быть тем же px/s-масштабом (decay слегка гасит).
    const { glide } = p4Run();
    const secant0 = (glide[1]! - glide[0]!) / 0.016;
    expect(secant0).toBeGreaterThan(0.5 * 1250);
    expect(secant0).toBeLessThan(1.05 * 1250);
  },
  CLAMP() {
    // Кламп границы не гасит hidden state: со snapBackSpring эмиссии выходят
    // ЗА границу (импульс жив), по умолчанию — жёстко клампятся.
    const withSnap = p4Run();
    expect(Math.max(...withSnap.steps)).toBeGreaterThan(150);
    const clock = pumpClock();
    const steps: number[] = [];
    const d = p4Flick(clock, {
      bounds: { x: { min: 0, max: 150 } },
      onStep: (x) => steps.push(x),
    });
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    for (const x of steps) expect(x).toBeLessThanOrEqual(150);
  },
  SETTLE() {
    const { d, glide, restXs } = p4Run();
    expect(d.x).toBe(150); // РОВНО граница (снап сходимости пружины)
    expect(glide[glide.length - 1]).toBe(150);
    expect(restXs).toEqual([150]); // onRest один раз
  },
  FINITE() {
    const rnd = lcg(0x5eed_0604); // общий канон fuzz-PRNG (дедуп локального LCG)
    const springs = [SNAP, CRIT, OVER];
    for (let run = 0; run < 120; run++) {
      const clock = pumpClock();
      const max = 50 + rnd() * 200;
      const d = createDrag({
        requestFrame: clock.requestFrame,
        bounds: { x: { min: -max, max } },
        snapBackSpring: springs[run % springs.length]!,
        onStep: (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`non-finite эмиссия (${x}, ${y}) на прогоне ${run}`);
          }
        },
      });
      const dir = rnd() < 0.5 ? -1 : 1;
      const speed = rnd() * 150;
      d.pointerDown({ x: 0, y: 0, t: 0 });
      for (let i = 1; i <= 5; i++) d.pointerMove({ x: dir * i * speed, y: 0, t: i * 0.016 });
      d.pointerUp({ x: dir * 5 * speed, y: 0, t: 0.08 });
      for (let ts = 0; ts <= 40_000 && d.gliding; ts += 16) clock.pump(ts);
      expect(d.gliding).toBe(false);
      expect(d.x).toBeGreaterThanOrEqual(-max);
      expect(d.x).toBeLessThanOrEqual(max);
    }
  },
};

// ─── P5: glide→drag pickup (синтетический сэмпл трекера) ────────────────────

/** Флик → 6 кадров глайда: возвращает живой глайд с журналом. */
function p5Vertical() {
  const clock = pumpClock();
  const glide: number[] = [];
  let inGlide = false;
  const d = createDrag({
    requestFrame: clock.requestFrame,
    onStep: (x) => {
      if (inGlide) glide.push(x);
      if (!Number.isFinite(x)) throw new Error(`non-finite эмиссия ${x}`);
    },
  });
  d.pointerDown({ x: 0, y: 0, t: 0 });
  for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
  d.pointerUp({ x: 100, y: 0, t: 0.08 });
  inGlide = true;
  let ts = 0;
  for (let i = 0; i < 6; i++) {
    clock.pump(ts);
    ts += 16;
  }
  expect(d.gliding).toBe(true);
  return { d, glide, clock, ts };
}

const P5_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const { d } = p5Vertical();
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 }); // палец ловит объект
    expect(d.dragging).toBe(true);
    expect(d.x).toBe(grabX); // захват БЕЗ телепорта: позиция = точка захвата
  },
  C1() {
    const { d, glide, clock } = p5Vertical();
    const n = glide.length;
    const vBefore = (glide[n - 1]! - glide[n - 2]!) / 0.016;
    expect(vBefore).toBeGreaterThan(100);
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    d.pointerUp({ x: grabX, y: 0, t: 1.001 }); // немедленный release без движения
    expect(d.gliding).toBe(true); // движение продолжилось, не умерло
    const m = glide.length;
    clock.pump(1000);
    clock.pump(1016);
    const vAfter = (glide[m + 1]! - glide[m]!) / 0.016;
    expect(Math.abs(vAfter)).toBeGreaterThan(0.65 * Math.abs(vBefore)); // наследование
    expect(Math.abs(vAfter)).toBeLessThan(1.05 * Math.abs(vBefore)); // без завышения
  },
  SIGN() {
    const { d, glide, clock } = p5Vertical();
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    d.pointerUp({ x: grabX, y: 0, t: 1.001 });
    const m = glide.length;
    clock.pump(1000);
    clock.pump(1016);
    expect(glide[m + 1]! - glide[m]!).toBeGreaterThan(0); // тот же знак (вправо)
  },
  DEGEN() {
    // Характеризация: down БЕЗ глайда → прайора нет, release без движения = 0.
    const clock = pumpClock();
    const d = createDrag({ requestFrame: clock.requestFrame, from: { x: 5 } });
    d.pointerDown({ x: 5, y: 0, t: 0 });
    d.pointerUp({ x: 5, y: 0, t: 0.001 });
    for (let ts = 0; ts <= 5000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBe(5); // скорость ровно 0 → остался на месте
  },
  NONFIN() {
    // Злые координаты захвата во время глайда → эмиссии конечны, оседание есть.
    const { d, clock, ts } = p5Vertical();
    d.pointerDown({ x: Number.NaN, y: Number.POSITIVE_INFINITY, t: 1.0 });
    d.pointerUp({ x: Number.NaN, y: Number.POSITIVE_INFINITY, t: 1.001 });
    for (let t = ts; t <= 20_000 && d.gliding; t += 16) clock.pump(t);
    expect(d.gliding).toBe(false);
    expect(Number.isFinite(d.x)).toBe(true);
    expect(Number.isFinite(d.y)).toBe(true);
  },
  REDUCE() {
    // CHARACTER-switch: флик при reduce снапается в точку покоя без кадров.
    const clock = pumpClock();
    const restXs: number[] = [];
    const d = createDrag({
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(),
      onRest: (x) => restXs.push(x),
    });
    d.pointerDown({ x: 0, y: 0, t: 0 });
    for (let i = 1; i <= 5; i++) d.pointerMove({ x: i * 20, y: 0, t: i * 0.016 });
    d.pointerUp({ x: 100, y: 0, t: 0.08 });
    expect(clock.queue.length).toBe(0); // ни одного кадра
    expect(d.gliding).toBe(false);
    expect(Number.isFinite(d.x)).toBe(true);
    expect(restXs).toHaveLength(1);
  },
  REST() {
    // Удержание дольше окна трекера (0.1s) гасит прайор: скорость ровно 0.
    const { d, clock, ts } = p5Vertical();
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    d.pointerUp({ x: grabX, y: 0, t: 1.5 }); // 500 мс > окна 100 мс
    for (let t = ts; t <= 20_000 && d.gliding; t += 16) clock.pump(t);
    expect(d.x).toBe(grabX); // прайор вытеснен — объект стоит РОВНО в захвате
  },
  SETTLE() {
    const { d, clock, ts } = p5Vertical();
    const grabX = d.x;
    d.pointerDown({ x: grabX, y: 0, t: 1.0 });
    d.pointerUp({ x: grabX, y: 0, t: 1.001 });
    for (let t = ts; t <= 20_000 && d.gliding; t += 16) clock.pump(t);
    expect(d.gliding).toBe(false); // оседание в бюджете
    expect(d.x).toBeGreaterThan(grabX); // импульс пронёс дальше точки захвата
  },
  FINITE() {
    // Guard non-finite уже встроен в onStep вертикали (throw) — полный цикл.
    const { d, glide, clock, ts } = p5Vertical();
    d.pointerDown({ x: d.x, y: 0, t: 1.0 });
    d.pointerUp({ x: d.x, y: 0, t: 1.001 });
    for (let t = ts; t <= 20_000 && d.gliding; t += 16) clock.pump(t);
    expect(glide.length).toBeGreaterThan(3);
    for (const x of glide) expect(Number.isFinite(x)).toBe(true);
  },
};

// ─── P6: compositor→gesture — readCompositorSpring → pointerDown pickup ──────

/** Вертикаль рецепта потребителя (канон gestures-compositor-pickup). */
function p6Vertical(tGrabS = 0.1) {
  let nowMs = 0;
  const fake = fakeWaapiEl();
  const cs = new CompositorSpring({
    spring: S170,
    property: 'transform',
    from: 0,
    to: 300,
    target: fake.el,
    now: () => nowMs,
    format: (v) => `translateX(${v}px)`,
  });
  cs.start();
  nowMs = tGrabS * 1000;
  const read = readCompositorSpring(S170, { from: 0, to: 300, t: tGrabS });
  cs.stop(); // владение переходит жесту
  expect(fake.animations[0]!.cancelled).toBe(true);
  const clock = pumpClock();
  const glide: number[] = [];
  let inGlide = false;
  const d = createDrag({
    from: { x: read.value },
    requestFrame: clock.requestFrame,
    onStep: (x) => {
      if (inGlide) glide.push(x);
    },
  });
  d.pointerDown({ x: read.value, y: 0, t: tGrabS }, { vx: read.velocity });
  return { d, read, glide, clock, beginGlide: () => (inGlide = true), tGrabS };
}

const P6_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const { d, read } = p6Vertical();
    expect(d.x).toBe(read.value); // позиция жеста = аналитическая позиция рана
  },
  C1() {
    const { d, read, glide, clock, beginGlide } = p6Vertical();
    expect(read.velocity).toBeGreaterThan(100); // ран живой
    d.pointerUp({ x: read.value, y: 0, t: 0.101 });
    expect(d.gliding).toBe(true);
    beginGlide();
    clock.pump(0);
    clock.pump(16);
    const vAfter = (glide[1]! - glide[0]!) / 0.016;
    expect(Math.abs(vAfter)).toBeGreaterThan(0.65 * Math.abs(read.velocity));
    expect(Math.abs(vAfter)).toBeLessThan(1.05 * Math.abs(read.velocity));
  },
  SIGN() {
    const { d, read, glide, clock, beginGlide } = p6Vertical();
    d.pointerUp({ x: read.value, y: 0, t: 0.101 });
    beginGlide();
    clock.pump(0);
    clock.pump(16);
    expect(glide[1]! - glide[0]!).toBeGreaterThan(0); // знак рана сохранён
  },
  DEGEN() {
    // Явный прайор «покой» {vx:0, vy:0} — объект остаётся ровно в захвате.
    const { d, read, clock } = p6Vertical();
    d.pointerUp({ x: read.value, y: 0, t: 0.101 });
    // Перехватываем ещё раз и сообщаем покой явно.
    d.pointerDown({ x: d.x, y: 0, t: 0.2 }, { vx: 0, vy: 0 });
    const grabX = d.x;
    d.pointerUp({ x: grabX, y: 0, t: 0.201 });
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBe(grabX);
  },
  NONFIN() {
    // Вырожденный pickup → ровно 0 (нет прайора), не NaN/−0/∞.
    for (const evil of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const clock = pumpClock();
      const d = createDrag({ requestFrame: clock.requestFrame });
      d.pointerDown({ x: 5, y: 5, t: 0 }, { vx: evil, vy: evil });
      d.pointerUp({ x: 5, y: 5, t: 0.001 });
      for (let ts = 0; ts <= 2000 && d.gliding; ts += 16) clock.pump(ts);
      expect(d.gliding).toBe(false);
      expect(d.x + 0).toBe(0);
      expect(d.y + 0).toBe(0);
    }
  },
  REDUCE() {
    // Reduce побеждает внешний прайор: снап без кадров, импульс не течёт.
    const clock = pumpClock();
    const restXs: number[] = [];
    const d = createDrag({
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(),
      onRest: (x) => restXs.push(x),
    });
    d.pointerDown({ x: 10, y: 0, t: 0 }, { vx: 800 });
    d.pointerUp({ x: 10, y: 0, t: 0.001 });
    expect(clock.queue.length).toBe(0); // ни одного кадра
    expect(d.gliding).toBe(false);
    expect(Number.isFinite(d.x)).toBe(true);
    expect(restXs).toHaveLength(1);
  },
  REST() {
    // Удержание дольше окна вытесняет прайор: объект остаётся в точке захвата.
    const { d, read, clock } = p6Vertical();
    d.pointerUp({ x: read.value, y: 0, t: 0.5 }); // 400 мс > окна 100 мс
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.x).toBe(read.value);
  },
  UNITS() {
    // Кросс-подсистемный пин единиц: units/s аналитического чтения ↔ px/s
    // секансов жеста, на ДРУГОМ моменте захвата (t = 0.05).
    const { d, read, glide, clock, beginGlide } = p6Vertical(0.05);
    d.pointerUp({ x: read.value, y: 0, t: 0.051 });
    beginGlide();
    clock.pump(0);
    clock.pump(16);
    const vAfter = (glide[1]! - glide[0]!) / 0.016;
    expect(Math.abs(vAfter)).toBeGreaterThan(0.65 * Math.abs(read.velocity));
    expect(Math.abs(vAfter)).toBeLessThan(1.05 * Math.abs(read.velocity));
  },
  SETTLE() {
    const { d, read, clock } = p6Vertical();
    d.pointerUp({ x: read.value, y: 0, t: 0.101 });
    for (let ts = 0; ts <= 10_000 && d.gliding; ts += 16) clock.pump(ts);
    expect(d.gliding).toBe(false);
    expect(d.x).toBeGreaterThan(read.value + 20); // импульс пронёс дальше захвата
    expect(Number.isFinite(d.x)).toBe(true);
  },
  FINITE() {
    const rnd = lcg(0x5eed_0606); // общий канон fuzz-PRNG (дедуп локального LCG)
    const evil = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e308, -0];
    const pick = (): number =>
      rnd() < 0.3 ? evil[Math.floor(rnd() * evil.length)]! : (rnd() - 0.5) * 2e4;
    for (let run = 0; run < 80; run++) {
      const clock = pumpClock();
      const d = createDrag({
        requestFrame: clock.requestFrame,
        onStep: (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`non-finite эмиссия (${x}, ${y}) на прогоне ${run}`);
          }
        },
      });
      d.pointerDown({ x: pick(), y: pick(), t: 0 }, { vx: pick(), vy: pick() });
      d.pointerUp({ x: pick(), y: pick(), t: 0.02 + rnd() * 0.3 });
      for (let ts = 0; ts <= 40_000 && d.gliding; ts += 16) clock.pump(ts);
      expect(d.gliding).toBe(false);
      expect(Number.isFinite(d.x)).toBe(true);
      expect(Number.isFinite(d.y)).toBe(true);
    }
  },
};

// ─── P7: compositor→live — handoffToLive ─────────────────────────────────────

const HANDOFF_TOL = 1 / 400; // tolerance компилятора linear() (канон M2)

const P7_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const clock = drainClock();
    const seen: number[] = [];
    handoffToLive({
      spring: S170,
      value: 42,
      velocity: 0,
      target: 100,
      requestFrame: clock.requestFrame,
      onChange: (v) => seen.push(v),
    });
    expect(seen[0]).toBe(42); // рождение ровно в точке хендоффа
  },
  C1() {
    // Differential: live-хвост продолжает ОРИГИНАЛЬНУЮ пружину (полугруппа
    // линейной ОДУ) в tolerance; негативный контроль: без скорости — расходится.
    const tStar = 0.08;
    const snap = readCompositorSpring(BOUNCY, { from: 0, to: 100, v0: 0, t: tStar });
    const tailDev = (velocity: number): number => {
      const clock = drainClock();
      const live: number[] = [];
      handoffToLive({
        spring: BOUNCY,
        value: snap.value,
        velocity,
        target: 100,
        requestFrame: clock.requestFrame,
        onChange: (v) => live.push(v),
      });
      clock.drain();
      let maxDev = 0;
      for (let k = 1; k < live.length - 1; k++) {
        const original = readCompositorSpring(BOUNCY, {
          from: 0,
          to: 100,
          v0: 0,
          t: tStar + k * FIXED_DT_S,
        }).value;
        maxDev = Math.max(maxDev, Math.abs(live[k]! - original));
      }
      return maxDev;
    };
    expect(tailDev(snap.velocity)).toBeLessThanOrEqual(HANDOFF_TOL * 100); // C¹ реален
    expect(tailDev(0)).toBeGreaterThan(HANDOFF_TOL * 100 * 10); // потеря скорости кусается
  },
  SIGN() {
    const clock = drainClock();
    const live: number[] = [];
    handoffToLive({
      spring: S170,
      value: 50,
      velocity: -500, // импульс вниз при цели выше
      target: 100,
      requestFrame: clock.requestFrame,
      onChange: (v) => live.push(v),
    });
    clock.step(12);
    expect(Math.min(...live.slice(1))).toBeLessThan(50); // знак не перевёрнут
  },
  DEGEN() {
    // Документированный вырожденный дефолт: target опущен (= value) при
    // ненулевой скорости → нуль-range снапает сразу, скорость гаснет в 0.
    const clock = drainClock();
    const seen: number[] = [];
    const mv = handoffToLive({
      spring: S170,
      value: 70,
      velocity: 800,
      requestFrame: clock.requestFrame,
      onChange: (v) => seen.push(v),
    });
    clock.drain();
    for (const v of seen) expect(v).toBe(70);
    expect(mv.value).toBe(70);
    expect(mv.velocity).toBe(0); // вырожденное → ровно 0
    mv.destroy();
  },
  NONFIN() {
    expect(() =>
      handoffToLive({ spring: S170, value: Number.NaN, velocity: 0, target: 1 }),
    ).toThrow(MotionParamError);
    expect(() =>
      handoffToLive({ spring: S170, value: 0, velocity: Number.POSITIVE_INFINITY, target: 1 }),
    ).toThrow(MotionParamError);
    expect(() =>
      handoffToLive({ spring: S170, value: 0, velocity: 0, target: Number.NaN }),
    ).toThrow(MotionParamError);
    expect(() =>
      handoffToLive({ spring: { mass: -1, stiffness: 1, damping: 1 }, value: 0, velocity: 0, target: 1 }),
    ).toThrow(MotionParamError);
  },
  REST() {
    // Покой на входе → покой на выходе: ни движения, ни фантомной скорости.
    const clock = drainClock();
    const seen: number[] = [];
    const mv = handoffToLive({
      spring: S170,
      value: 25,
      velocity: 0,
      target: 25,
      requestFrame: clock.requestFrame,
      onChange: (v) => seen.push(v),
    });
    clock.drain();
    for (const v of seen) expect(v).toBe(25);
    expect(mv.velocity).toBe(0);
    mv.destroy();
  },
  UNITS() {
    // Секанс первого live-кадра (units за СЕКУНДЫ) ≈ трапеции скоростей концов
    // кадра: пружина сильно ускоряет на [0,dt], поэтому сверка с одной v0 была
    // бы грубой; сдвиг единиц ×1000 кусается и грубой рамкой ниже.
    const clock = drainClock();
    const live: number[] = [];
    const mv = handoffToLive({
      spring: S170,
      value: 30,
      velocity: 400,
      target: 250,
      requestFrame: clock.requestFrame,
      onChange: (v) => live.push(v),
    });
    clock.step(1);
    const v1 = mv.velocity;
    const secant = (live[1]! - live[0]!) / FIXED_DT_S;
    const avg = (400 + v1) / 2;
    expect(Math.abs(secant - avg)).toBeLessThan(0.05 * Math.abs(avg));
    expect(secant).toBeGreaterThan(0.4 * 400); // грубая рамка масштаба units/s
    expect(secant).toBeLessThan(2.5 * 400);
    mv.destroy();
  },
  CLAMP() {
    // Дефолт clamp:false — честный overshoot (паритет с linear()-кривой);
    // clamp:true ограничивает ЭМИТ, но скрытая скорость бит-в-бит та же.
    const mk = (clamp: boolean) => {
      const clock = drainClock();
      const live: number[] = [];
      const mv = handoffToLive({
        spring: BOUNCY,
        value: 0,
        velocity: 900,
        target: 100,
        clamp,
        requestFrame: clock.requestFrame,
        onChange: (v) => live.push(v),
      });
      return { clock, live, mv };
    };
    const honest = mk(false);
    const clamped = mk(true);
    for (let i = 0; i < 60 && honest.clock.queueLength() > 0 && clamped.clock.queueLength() > 0; i++) {
      honest.clock.step(1);
      clamped.clock.step(1);
      expect(clamped.mv.velocity).toBe(honest.mv.velocity); // hidden state не искажён
    }
    honest.clock.drain();
    clamped.clock.drain();
    expect(Math.max(...honest.live)).toBeGreaterThan(100); // overshoot эмитится
    expect(Math.max(...clamped.live)).toBeLessThanOrEqual(100); // CSS-safe кламп
    honest.mv.destroy();
    clamped.mv.destroy();
  },
  SETTLE() {
    const clock = drainClock();
    const live: number[] = [];
    const mv = handoffToLive({
      spring: BOUNCY,
      value: 30,
      velocity: 400,
      target: 250,
      requestFrame: clock.requestFrame,
      onChange: (v) => live.push(v),
    });
    clock.drain();
    expect(live[live.length - 1]).toBe(250); // ровно цель
    expect(mv.value).toBe(250);
    mv.destroy();
  },
  FINITE() {
    const clock = drainClock();
    const live: number[] = [];
    const mv = handoffToLive({
      spring: BOUNCY,
      value: -30,
      velocity: 1e5,
      target: 250,
      requestFrame: clock.requestFrame,
      onChange: (v) => live.push(v),
    });
    clock.drain();
    for (const v of live) expect(Number.isFinite(v)).toBe(true);
    expect(live[live.length - 1]).toBe(250);
    mv.destroy();
  },
};

// ─── P8: presence exit→enter (reversed continuation) ─────────────────────────

/** Вертикаль: exit-ран MotionValue → прерывание enter'ом с наследованием. */
function p8Vertical() {
  const clock = drainClock();
  let exitMv: MotionValue | undefined;
  let enterMv: MotionValue | undefined;
  let inherited: PresenceSnapshot | undefined;
  const enterEmits: number[] = [];
  const p = createPresence({
    initiallyPresent: true,
    onExitStart: (_done, _interrupted, capture) => {
      exitMv = new MotionValue({ initial: 1, spring: STD, requestFrame: clock.requestFrame });
      exitMv.setTarget(0);
      capture(() => ({ value: exitMv!.value, velocity: exitMv!.velocity }));
    },
    onEnterStart: (_done, interrupted) => {
      inherited = interrupted;
      exitMv!.destroy();
      enterMv = new MotionValue({
        initial: interrupted!.value,
        initialVelocity: interrupted!.velocity,
        spring: STD,
        clamp: false, // честный довыбег reversed continuation
        requestFrame: clock.requestFrame,
      });
      enterMv.onChange((v) => enterEmits.push(v));
      enterMv.setTarget(1);
    },
  });
  p.exit();
  clock.step(6); // exit в полёте
  const grabValue = exitMv!.value;
  const grabVelocity = exitMv!.velocity;
  p.enter(); // пользователь передумал
  return {
    p,
    clock,
    enterEmits,
    grabValue,
    grabVelocity,
    inherited: () => inherited,
    enterMv: () => enterMv!,
  };
}

const P8_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const v = p8Vertical();
    expect(v.inherited()!.value).toBe(v.grabValue); // снимок В МОМЕНТ прерывания
    expect(v.enterEmits[0]).toBe(v.grabValue); // enter РОЖДАЕТСЯ в точке захвата
  },
  C1() {
    const v = p8Vertical();
    expect(v.inherited()!.velocity).toBe(v.grabVelocity); // пара снята точно
    expect(v.enterMv().velocity).toBe(v.grabVelocity); // и унаследована бит-в-бит
  },
  SIGN() {
    const v = p8Vertical();
    expect(v.grabVelocity).toBeLessThan(-0.1); // exit ехал вниз
    v.clock.step(10);
    // Импульс вниз сначала продавливает НИЖЕ точки захвата (знак не перевёрнут).
    expect(Math.min(...v.enterEmits.slice(1))).toBeLessThan(v.grabValue);
  },
  DEGEN() {
    // enter из gone: прерывать нечего → снимка нет → рождение из покоя.
    const seen: unknown[] = [];
    const p = createPresence({
      onEnterStart: (_done, interrupted) => {
        seen.push(interrupted);
      },
    });
    p.enter();
    expect(seen).toEqual([undefined]);
  },
  NONFIN() {
    // Битый донор (снимок с NaN) не проглатывается: приёмная MotionValue
    // падает fail-fast — канон fail-fast ядра работает и сквозь presence.
    const p = createPresence({
      initiallyPresent: true,
      onExitStart: (_done, _i, capture) =>
        capture(() => ({ value: Number.NaN, velocity: Number.NaN })),
      onEnterStart: (_done, interrupted) => {
        new MotionValue({
          initial: (interrupted as PresenceSnapshot).value,
          initialVelocity: (interrupted as PresenceSnapshot).velocity,
          spring: STD,
        });
      },
    });
    p.exit();
    expect(() => p.enter()).toThrow(MotionParamError);
  },
  REDUCE() {
    // Reduce: фаз нет — снимок НЕ читается, импульс не переносится.
    const state = { reduce: false };
    const mm = (() => ({ matches: state.reduce })) as unknown as (q: string) => MediaQueryList;
    let reads = 0;
    const p = createPresence<number>({
      initiallyPresent: true,
      matchMedia: mm,
      onExitStart: (_done, _i, capture) =>
        capture(() => {
          reads++;
          return 1;
        }),
    });
    p.exit();
    state.reduce = true;
    p.enter();
    expect(p.state).toBe('present'); // мгновенно, без фазы
    expect(reads).toBe(0);
  },
  REST() {
    // После доигранной фазы наследовать нечего: снимок погашен.
    const seen: unknown[] = [];
    const dones: Array<() => void> = [];
    const p = createPresence<number>({
      onEnterStart: (done, _i, capture) => {
        dones.push(done);
        capture(() => 7);
      },
      onExitStart: (_done, interrupted) => {
        seen.push(interrupted);
      },
    });
    p.enter();
    dones[0]!(); // enter доигран → покой
    p.exit();
    expect(seen).toEqual([undefined]);
  },
  CLAMP() {
    // Снимок сквозь кламп: exit-ран clamp:true в overshoot-фазе — эмит насыщен
    // на цели, но снятая скорость — живой hidden state (не производная клампа).
    const clock = drainClock();
    let exitMv: MotionValue | undefined;
    let inherited: PresenceSnapshot | undefined;
    const p = createPresence({
      initiallyPresent: true,
      onExitStart: (_done, _i, capture) => {
        exitMv = new MotionValue({
          initial: 1,
          spring: UNDER, // ζ≈0.354: overshoot реален
          requestFrame: clock.requestFrame, // clamp по умолчанию true
        });
        exitMv.setTarget(0);
        capture(() => ({ value: exitMv!.value, velocity: exitMv!.velocity }));
      },
      onEnterStart: (_done, interrupted) => {
        inherited = interrupted;
      },
    });
    p.exit();
    // Доводим до кадра, где ЭМИТ клампован на цели (0), но ран ещё жив.
    for (let i = 0; i < 200 && !(exitMv!.value === 0 && exitMv!.velocity !== 0); i++) {
      clock.step(1);
    }
    expect(exitMv!.value).toBe(0); // выход насыщен клампом
    expect(exitMv!.velocity).toBeLessThan(0); // hidden state жив
    const velAtGrab = exitMv!.velocity;
    p.enter();
    expect(inherited!.value).toBe(0);
    expect(inherited!.velocity).toBe(velAtGrab); // кламп не исказил снимок
    exitMv!.destroy();
  },
  SETTLE() {
    const v = p8Vertical();
    v.clock.step(3000);
    expect(v.enterEmits[v.enterEmits.length - 1]).toBe(1); // осели РОВНО на цели enter
    v.enterMv().destroy();
  },
  FINITE() {
    const v = p8Vertical();
    v.clock.step(3000);
    for (const e of v.enterEmits) expect(Number.isFinite(e)).toBe(true);
    v.enterMv().destroy();
  },
};

// ─── P9: css-канал spring→spring (animate, projectCssV0) ─────────────────────

/** Аналитическая скорость прогресса ṗ(t) пружины S170 от покоя (прогресс/с). */
function pdotAt(tS: number): number {
  return readCompositorSpring(S170, { from: 0, to: 1, v0: 0, t: tS }).velocity;
}

/** Числовые значения записей свойства ('42.5px' → 42.5). */
function pxSeries(
  writes: readonly { prop: string; value: string }[],
  prop: string,
): number[] {
  return writes.filter((w) => w.prop === prop).map((w) => parseFloat(w.value));
}

/** Сценарий «css-ран width прерван spring-раном» (канон animate-css-pickup). */
function p9Intercept(opts: {
  initial?: string;
  to1?: string;
  mode1?: Record<string, unknown>;
  seekMs: number;
  to2: string | readonly [string, string];
  matchMedia2?: (q: string) => { matches: boolean };
}) {
  const f = fakeEl({ width: opts.initial ?? '0px' });
  const clock = makeClock();
  const first = animate(
    f.el,
    { width: opts.to1 ?? '100px' },
    { ...(opts.mode1 ?? { spring: S170 }), requestFrame: clock.requestFrame },
  );
  first.seek(opts.seekMs);
  const wMid = pxSeries(f.writes, 'width').at(-1)!;
  animate(
    f.el,
    { width: opts.to2 },
    {
      spring: S170,
      requestFrame: clock.requestFrame,
      ...(opts.matchMedia2 ? { matchMedia: opts.matchMedia2 } : {}),
    },
  );
  clock.step(16); // кадр 1: elapsed 0 (ребейз, p=0)
  clock.step(16); // кадр 2: elapsed 16 мс
  const series = pxSeries(f.writes, 'width');
  const to2v = parseFloat(typeof opts.to2 === 'string' ? opts.to2 : opts.to2[1]);
  const from2 = typeof opts.to2 === 'string' ? wMid : parseFloat(opts.to2[0]);
  return {
    f,
    clock,
    wMid,
    series,
    v: impliedPickupVelocity(S170, from2, to2v, series.at(-1)!, 0.016),
  };
}

const P9_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const r = p9Intercept({ seekMs: 80, to2: '300px' });
    // series[0] — запись seek (захват), series[1] — кадр elapsed 0 нового рана.
    expect(r.series[1]!).toBeCloseTo(r.wMid, 12); // ребейз на захват, не p=0 старого
  },
  C1() {
    const r = p9Intercept({ seekMs: 80, to2: '300px' });
    // Юнитный спан одномерен → доминантная проекция точна: v = ṗ(0.08)·(100−0).
    expect(r.v).toBeCloseTo(pdotAt(0.08) * 100, 6);
  },
  SIGN() {
    // Источник едет ВНИЗ (100px → 0px), перехват продолжает к 0px: унаследованная
    // скорость отрицательна и точна. Цель — ПО ходу движения: css-эмит клампует
    // p на [0,1], ретаргет против импульса дал бы плато (клетка CLAMP), а не
    // честный кадр для аффинной инверсии.
    const r = p9Intercept({ initial: '100px', to1: '0px', seekMs: 80, to2: '0px' });
    expect(r.v).toBeCloseTo(pdotAt(0.08) * (0 - 100), 6);
    expect(r.v).toBeLessThan(0);
  },
  DEGEN() {
    // Явная пара [from,to] отключает подхват: ребейз на явный from, покой.
    const r = p9Intercept({ seekMs: 80, to2: ['10px', '300px'] as const });
    expect(r.series[1]!).toBeCloseTo(10, 12);
    expect(r.v).toBeCloseTo(0, 6); // скорость не наследуется → ровно из покоя
  },
  NONFIN() {
    // Смешанные виды AST (px → var()): скорость не определена → без NaN в стиле.
    const f = fakeEl({ width: '0px' });
    const clock = makeClock();
    const first = animate(f.el, { width: '100px' }, { spring: S170, requestFrame: clock.requestFrame });
    first.seek(80);
    animate(f.el, { width: 'var(--w)' }, { spring: S170, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    expect(allWritesFinite(f.writes)).toBe(true);
  },
  REDUCE() {
    const r = p9Intercept({ seekMs: 80, to2: '300px', matchMedia2: reduceMedia() });
    expect(r.series.at(-1)!).toBe(300); // мгновенный снап в цель
    const writesBefore = r.f.writes.length;
    r.clock.drain(16);
    expect(r.f.writes.length).toBe(writesBefore); // импульс не течёт: кадров нет
  },
  async REST() {
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
    animate(f.el, { width: '300px' }, { spring: S170, requestFrame: clock.requestFrame });
    clock.step(16);
    clock.step(16);
    const v = impliedPickupVelocity(S170, 100, 300, pxSeries(f.writes, 'width').at(-1)!, 0.016);
    expect(v).toBeCloseTo(0, 6); // после оседания — покой
  },
  UNITS() {
    // tween-источник: ṗ = 1/duration_s → v = range/duration·1000 units/s ровно.
    const r = p9Intercept({
      mode1: { duration: 400, ease: linear },
      seekMs: 200,
      to2: '300px',
    });
    expect(r.wMid).toBeCloseTo(50, 9);
    expect(r.v).toBeCloseTo(250, 6);
  },
  CLAMP() {
    // Обратный ретаргет: импульс ОТ новой цели клампится на p=0 в ЭМИТЕ
    // (плато у захвата), но не искажает перенос — без наследования значение
    // сразу падало бы ниже захвата.
    const r = p9Intercept({ seekMs: 80, to2: '0px' });
    expect(r.series.at(-1)!).toBeGreaterThanOrEqual(r.wMid - 1e-9);
  },
  SETTLE() {
    const r = p9Intercept({ seekMs: 80, to2: '300px' });
    r.clock.drain(16);
    expect(pxSeries(r.f.writes, 'width').at(-1)).toBe(300); // ровно цель
  },
  FINITE() {
    const rnd = lcg(0x5eed_0609);
    for (let i = 0; i < 60; i++) {
      const to1 = (rnd() < 0.5 ? -1 : 1) * (20 + rnd() * 580);
      const tMs = 30 + rnd() * 270;
      const to2 = to1 + Math.sign(to1) * (Math.abs(to1) + 50 + rnd() * 300);
      const f = fakeEl({ width: '0px' });
      const clock = makeClock();
      const first = animate(f.el, { width: `${to1}px` }, { spring: S170, requestFrame: clock.requestFrame });
      first.seek(tMs);
      const wMid = pxSeries(f.writes, 'width').at(-1)!;
      animate(f.el, { width: `${to2}px` }, { spring: S170, requestFrame: clock.requestFrame });
      clock.step(16);
      clock.step(16);
      const v = impliedPickupVelocity(S170, wMid, to2, pxSeries(f.writes, 'width').at(-1)!, 0.016);
      const vAnalytic = pdotAt(tMs / 1000) * to1;
      if (Math.abs(v - vAnalytic) > 0.01 * Math.max(Math.abs(vAnalytic), 1)) {
        throw new Error(`drift: to1=${to1} tMs=${tMs} to2=${to2} v=${v} analytic=${vAnalytic}`);
      }
      if (!allWritesFinite(f.writes)) {
        throw new Error(`non-finite write: to1=${to1} tMs=${tMs} to2=${to2}`);
      }
    }
  },
};

// ─── P10: driver-хендл → MotionValue (controls.velocity) ─────────────────────

/** Замороженный хендл: requestFrame копит, время двигает seek. */
function p10Frozen(over: Record<string, unknown> = {}) {
  const steps: number[] = [];
  const c = createDriver({
    from: 0,
    to: 200,
    spring: UNDER,
    onStep: (v) => steps.push(v),
    requestFrame: () => 1, // handle ≠ 0: кадры не идут сами
    ...over,
  });
  return { c, steps };
}

const P10_TESTS: Partial<Record<CheckId, () => void | Promise<void>>> = {
  C0() {
    const { c, steps } = p10Frozen();
    c.seek(0.1);
    const value = steps.at(-1)!;
    const velocity = c.velocity;
    c.cancel();
    const mv = new MotionValue({
      initial: value,
      initialVelocity: velocity,
      spring: UNDER,
      requestFrame: () => 1,
    });
    expect(mv.value).toBe(value); // приёмник рождён ровно в точке захвата
    mv.destroy();
  },
  C1() {
    const { c, steps } = p10Frozen();
    c.seek(0.1);
    const value = steps.at(-1)!;
    const velocity = c.velocity;
    expect(Math.abs(velocity)).toBeGreaterThan(0);
    c.cancel();
    const mv = new MotionValue({
      initial: value,
      initialVelocity: velocity,
      spring: UNDER,
      requestFrame: () => 1,
    });
    expect(mv.velocity).toBe(velocity); // пара унаследована бит-в-бит
    mv.destroy();
  },
  SIGN() {
    const { c } = p10Frozen({ from: 100, to: 0 });
    c.seek(0.05);
    expect(c.velocity).toBeLessThan(0); // движение вниз по значению
    const mv = new MotionValue({
      initial: 50,
      initialVelocity: c.velocity,
      spring: UNDER,
      requestFrame: () => 1,
    });
    expect(mv.velocity).toBeLessThan(0); // знак сквозь стык сохранён
    c.cancel();
    mv.destroy();
  },
  DEGEN() {
    const { c } = p10Frozen({ from: 5, to: 5 }); // вырожденный range
    expect(Object.is(c.velocity, 0)).toBe(true); // ровно 0, не −0
    c.cancel();
  },
  NONFIN() {
    // Битый донор скорости → fail-fast приёмника (не «молча из покоя»).
    expect(
      () => new MotionValue({ initial: 0, spring: UNDER, initialVelocity: Number.NaN }),
    ).toThrow(MotionParamError);
    // Экстремальный seek: скорость андерфлоу-ится в конечный 0, не NaN.
    const { c } = p10Frozen();
    c.seek(1e6);
    expect(Number.isFinite(c.velocity)).toBe(true);
    c.cancel();
  },
  REDUCE() {
    const steps: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: CRIT,
      onStep: (v) => steps.push(v),
      matchMedia: reduceMedia(),
      requestFrame: () => 1,
    });
    expect(steps).toEqual([100]); // CHARACTER-switch: один синхронный снап
    expect(c.velocity).toBe(0); // импульса нет
    const mv = new MotionValue({
      initial: steps.at(-1)!,
      initialVelocity: c.velocity,
      spring: CRIT,
      requestFrame: () => 1,
    });
    expect(mv.velocity).toBe(0); // приёмник рождён в покое
    mv.destroy();
  },
  REST() {
    const { c } = p10Frozen();
    expect(c.velocity).toBe(0); // до старта — покой
    c.seek(0.1);
    expect(c.velocity).not.toBe(0);
    c.complete();
    expect(c.velocity).toBe(0); // после complete — ровно 0
    const b = p10Frozen();
    b.c.seek(0.1);
    b.c.cancel();
    expect(b.c.velocity).toBe(0); // после cancel — ровно 0
  },
  UNITS() {
    // Бит-в-бит оракул единиц: velocity = нормированная скорость · range
    // (units/s из секунд·range; ×1000-сдвиг кусается точным toBe).
    const { c } = p10Frozen();
    for (const t of [0.02, 0.05, 0.1, 0.25]) {
      c.seek(t);
      expect(c.velocity).toBe(springUnchecked(UNDER, t).velocity * 200);
    }
    c.cancel();
  },
  CLAMP() {
    // Одна аналитическая скорость при любом clamp; overshoot-фаза при
    // clamp:true отрицательна (hidden state, не производная насыщенного эмита).
    const a = p10Frozen({ clamp: true });
    const b = p10Frozen({ clamp: false });
    for (const t of [0.08, 0.15, 0.3]) {
      a.c.seek(t);
      b.c.seek(t);
      expect(a.c.velocity).toBe(b.c.velocity);
    }
    a.c.seek(0.3);
    const expected = springUnchecked(UNDER, 0.3).velocity * 200;
    expect(expected).toBeLessThan(0);
    expect(a.c.velocity).toBe(expected);
    a.c.cancel();
    b.c.cancel();
  },
  async SETTLE() {
    const steps: number[] = [];
    const c = createDriver({
      from: 0,
      to: 100,
      spring: CRIT,
      onStep: (v) => steps.push(v),
      requestFrame: () => 0, // non-draining конвенция → setTimeout-fallback
    });
    await c;
    expect(steps.at(-1)).toBe(100); // ровно цель
    expect(c.velocity).toBe(0);
  },
  FINITE() {
    const rnd = lcg(0x5eed_0610);
    const springs = [UNDER, CRIT, OVER];
    for (let i = 0; i < 200; i++) {
      const { c } = p10Frozen({
        from: (rnd() - 0.5) * 2000,
        to: (rnd() - 0.5) * 2000,
        spring: springs[i % springs.length]!,
      });
      for (let s2 = 0; s2 < 3; s2++) {
        c.seek(rnd() * 3);
        if (!Number.isFinite(c.velocity)) throw new Error(`non-finite velocity, прогон ${i}`);
      }
      c.cancel();
      expect(c.velocity).toBe(0);
    }
  },
};

// ─── Сборка матрицы: describe × it из спецификации ───────────────────────────

const TESTS: Record<PairId, Partial<Record<CheckId, () => void | Promise<void>>>> = {
  P1: P1_TESTS,
  P2: P2_TESTS,
  P3: P3_TESTS,
  P4: P4_TESTS,
  P5: P5_TESTS,
  P6: P6_TESTS,
  P7: P7_TESTS,
  P8: P8_TESTS,
  P9: P9_TESTS,
  P10: P10_TESTS,
};

const CHECK_TITLES: Record<CheckId, string> = {
  C0: 'первый кадр приёмника = точка захвата',
  C1: 'скорость унаследована',
  SIGN: 'знак скорости сохранён',
  DEGEN: 'вырожденный стык → ровно 0 / инертен',
  NONFIN: 'non-finite вход → 0 или fail-fast',
  REDUCE: 'reduced-motion: CHARACTER-switch без импульса',
  REST: 'покой → 0',
  UNITS: 'единицы units/s согласованы',
  CLAMP: 'clamp не искажает hidden state',
  SETTLE: 'оседание на цели точное',
  FINITE: 'финитность всех эмиссий',
};

for (const pair of PAIRS) {
  describe(`continuity-матрица ${pair.id}: ${pair.title}`, () => {
    for (const checkId of CHECK_IDS) {
      const impl = TESTS[pair.id][checkId];
      if (MATRIX[pair.id][checkId] === 'covered') {
        it(`${checkId} — ${CHECK_TITLES[checkId]}`, impl!, 30_000);
      }
    }
  });
}

describe('continuity-матрица: спецификация полна (мета-пин)', () => {
  it('каждая клетка PAIRS×CHECKS объявлена: covered ⇔ есть тест, иначе N/A с причиной', () => {
    for (const pair of PAIRS) {
      for (const checkId of CHECK_IDS) {
        const cell = MATRIX[pair.id][checkId];
        const impl = TESTS[pair.id][checkId];
        expect(cell, `${pair.id}×${checkId}: клетка не объявлена`).toBeTruthy();
        if (cell === 'covered') {
          expect(typeof impl, `${pair.id}×${checkId}: covered без теста`).toBe('function');
        } else {
          expect(
            cell.startsWith('N/A: ') && cell.length > 10,
            `${pair.id}×${checkId}: N/A без причины («${cell}»)`,
          ).toBe(true);
          expect(impl, `${pair.id}×${checkId}: N/A при существующем тесте`).toBeUndefined();
        }
      }
    }
  });
});

// ─── Пункт В: один канонический солвер main/compositor (бит-в-бит пин) ───────

describe('пункт В (#93): солвер main-пути и compositor-пути — ОДНА математика', () => {
  const GRID: { name: string; p: SpringParams }[] = [
    { name: 'underdamped ζ≈0.354', p: UNDER },
    { name: 'critical ζ=1', p: CRIT },
    { name: 'overdamped ζ≈2.12', p: OVER },
  ];
  const TS = [0, 0.004, 1 / 60, 0.1, 0.5, 2];
  const V0S = [0, 1.7, -3.2];

  it('readCompositorSpring на нормированном диапазоне 0→1 ≡ solveSpring бит-в-бит (режимы × t × v0)', () => {
    for (const { name, p } of GRID) {
      for (const t of TS) {
        for (const v0 of V0S) {
          const raw = solveSpring(p, t, v0);
          const r = readCompositorSpring(p, { from: 0, to: 1, v0, t });
          expect(r.value, `${name} t=${t} v0=${v0}`).toBe(raw.value);
          expect(r.velocity, `${name} t=${t} v0=${v0}`).toBe(raw.velocity);
        }
      }
    }
  });

  it('денормализация compositor-чтения — тот же порядок операций, что у main-пути: from + value·range, velocity·range', () => {
    const from = 10;
    const to = 210;
    const range = to - from;
    for (const { name, p } of GRID) {
      for (const t of TS) {
        for (const v0 of V0S) {
          const raw = solveSpring(p, t, v0);
          const r = readCompositorSpring(p, { from, to, v0, t });
          expect(r.value, `${name} t=${t} v0=${v0}`).toBe(from + raw.value * range);
          expect(r.velocity, `${name} t=${t} v0=${v0}`).toBe(raw.velocity * range);
        }
      }
    }
  });

  it('springUnchecked (main-путь, v0=0) ≡ solveSpring(…, 0) бит-в-бит', () => {
    for (const { name, p } of GRID) {
      for (const t of TS) {
        const raw = solveSpring(p, t, 0);
        const s = springUnchecked(p, t);
        expect(s.value, `${name} t=${t}`).toBe(raw.value);
        expect(s.velocity, `${name} t=${t}`).toBe(raw.velocity);
      }
    }
  });

  it('makeSpringValueSampler (сегментер compositor) ≡ solveSpring(…).value бит-в-бит', () => {
    for (const { name, p } of GRID) {
      for (const v0 of V0S) {
        const sampler = makeSpringValueSampler(p, v0);
        for (const t of TS) {
          expect(sampler(t), `${name} t=${t} v0=${v0}`).toBe(solveSpring(p, t, v0).value);
        }
      }
    }
  });
});

// ─── Пункт Б: характеризация хендла animate() ────────────────────────────────

describe('пункт Б (#93): хендл animate() — агрегированные контролы БЕЗ velocity (отложено до #127)', () => {
  it('хендл — ровно { finished, play, pause, seek, cancel, stop }; finished — Promise, остальное — функции', () => {
    const f = fakeEl();
    const clock = makeClock();
    const h = animate(f.el, { x: 10 }, { spring: S170, requestFrame: clock.requestFrame });
    expect(Object.keys(h).sort()).toEqual(['cancel', 'finished', 'pause', 'play', 'seek', 'stop']);
    expect(h.finished).toBeInstanceOf(Promise);
    for (const k of ['play', 'pause', 'seek', 'cancel', 'stop'] as const) {
      expect(typeof (h as unknown as Record<string, unknown>)[k]).toBe('function');
    }
    h.cancel();
  });

  it('публичного velocity на хендле НЕТ — решение среза 6: фасад 11198/11200 gz (запас 2 байта), отложено до #127', () => {
    // Аналитическое чтение при этом существует: внутренний capture-канал
    // (groupRecord: numeric[].velocity, css.dpdt) питает C¹-подхват (P3/P9),
    // публичные хендлы с чтением — MotionValue.velocity (P1) и
    // driver controls.velocity (P10). Если этот пин упал — velocity добавили:
    // пересмотрите решение #127 и размерные факты, это осознанная граница.
    const f = fakeEl();
    const clock = makeClock();
    const h = animate(f.el, { x: 10 }, { spring: S170, requestFrame: clock.requestFrame });
    expect('velocity' in h).toBe(false);
    h.cancel();
  });
});
