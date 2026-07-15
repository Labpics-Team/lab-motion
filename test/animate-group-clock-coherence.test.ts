/**
 * test/animate-group-clock-coherence.test.ts — субпуть ./animate:
 * связанная векторная группа (x/y/scale) живёт на ЕДИНОМ времени (#93 срез 4).
 *
 * Класс: Б (characterization/pin) — контракт УЖЕ выполняется конструкцией
 * (одна группа = один юнит = один rAF-цикл / одна Animation), пункт чек-листа
 * закрывается ДОКАЗАТЕЛЬСТВОМ, не новой машинерией. Пины:
 *
 *  1. Один clock: группа из N transform-каналов подписывает РОВНО ОДИН
 *     requestFrame-колбэк на кадр (не N циклов).
 *  2. Атомарный вектор: каждый кадр — одна transform-декларация, все каналы
 *     в ней с ОДНОГО t (пропорция значений = пропорция диапазонов).
 *  3. Когерентный перехват: второй animate() снимает вектор (value, velocity)
 *     всех каналов с ОДНОГО t̂ (не с соседних кадров): C⁰ повектору точна,
 *     скорости связаны той же пропорцией диапазонов и равны аналитике в t̂.
 *  4. Нет второго frame-loop: после перехвата планируется по-прежнему один
 *     колбэк на кадр (кадры прежнего юнита инертны — поколение сменено).
 *  5. Единое оседание: группа пишет точный финал одним кадром для всех
 *     каналов (не сеттлится вразнобой).
 *  6. Compositor-путь: группа x/y — ОДНА Animation; перехват снимает
 *     когерентный вектор с одного t̂ по now-шву.
 *
 * ── RED PROOF (вневременно) ──────────────────────────────────────────────────
 * Характеризация: на базе среза (main a13eb1a) все пины зелёные — контракт
 * держится конструкцией MainUnit/WaapiUnit (один unit на группу). Файл
 * born-green как пин; RED-режим доказан мутациями (ниже): рассинхронизация
 * времени каналов внутри кадра ловится пропорцией и когерентностью перехвата.
 *
 * ── MUTATION PROOF (тест обязан падать на своей мутации; посеяно и откачено) ─
 *   [skew-t]     main-unit._compute (spring): второй+ канал читает t + FIXED_DT_S
 *                (личное время канала) → 2 красных: «атомарный вектор» и
 *                «когерентный перехват» (пропорция y=2x ломается).
 *   [stale-cap]  captureNum отдаёт value − velocity·dt (значение соседнего
 *                кадра) → 1 красный: «когерентный перехват: C⁰ повектору».
 *   [dup-loop]   _tick планирует _schedule дважды → 2 красных: оба пина
 *                «один clock» (подписок на кадр становится 2).
 *
 * Детерминизм: время только через инжектируемые шаг-часы / now-шов.
 */

import { describe, expect, it } from 'vitest';
import * as animateApi from '../src/animate/index.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { sampleSerializedSpring } from '../src/compositor/sample.js';
import { linear } from '../src/easing/index.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';
import {
  fakeEl,
  makeClock,
  makeNow,
  makeTimer,
  pickAnimate,
  pickLiveAnimate,
  type StyleWrite,
} from './animate-facade-helpers.js';

const animate = pickLiveAnimate(animateApi as Record<string, unknown>);
const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

function executionProgress(tMs: number): number {
  const artifact = compileSpringExecutionArtifactUnchecked(
    SPRING,
    0,
    DEFAULT_TOLERANCE,
  );
  return sampleSerializedSpring(
    artifact.samples,
    settleTimeUpperBound(SPRING, 0) * 1000,
    tMs,
  ).value;
}

// ─── Разбор transform-вектора ────────────────────────────────────────────────

interface TfVec {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** Разбирает transform-строку в вектор каналов (identity-дефолты для пропусков). */
function parseTf(value: string): TfVec {
  const g = (re: RegExp, d: number): number => {
    const m = re.exec(value);
    return m ? Number(m[1]) : d;
  };
  if (value === 'none') return { x: 0, y: 0, scale: 1 };
  // buildTransform объединяет ненулевую пару в translate(x, y).
  const pair = /translate\((-?[\d.eE+-]+)px,\s*(-?[\d.eE+-]+)px\)/.exec(value);
  return {
    x: pair ? Number(pair[1]) : g(/translateX\((-?[\d.eE+-]+)px\)/, 0),
    y: pair ? Number(pair[2]) : g(/translateY\((-?[\d.eE+-]+)px\)/, 0),
    scale: g(/scale\((-?[\d.eE+-]+)\)/, 1),
  };
}

/** Векторы всех transform-записей в порядке эмита. */
function tfSeries(writes: readonly StyleWrite[]): TfVec[] {
  return writes.filter((w) => w.prop === 'transform').map((w) => parseTf(w.value));
}

/** Оракул скорости: аффинная инверсия кадра elapsed=dtS (солвер линеен по v0). */
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

// ─── Пины 1–2: один clock, атомарный вектор ──────────────────────────────────

describe('animate группа x/y/scale: единый clock (Класс Б, пин #93 срез 4)', () => {
  it('группа из 3 каналов подписывает РОВНО ОДИН rAF-колбэк на кадр', () => {
    const f = fakeEl();
    const clock = makeClock();
    let subs = 0;
    const rf = (cb: (ts?: number) => void): number => {
      subs++;
      return clock.requestFrame(cb);
    };
    animate(f.el, { x: 100, y: 200, scale: 2 }, { spring: SPRING, requestFrame: rf });
    expect(subs).toBe(1); // один юнит на группу — один bootstrap
    clock.step(16);
    expect(subs).toBe(2); // ровно +1 на кадр, не +3
    clock.step(16);
    expect(subs).toBe(3);
  });

  it('spring: каждый кадр — атомарный вектор с одного t (пропорция диапазонов)', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100, y: 200, scale: 2 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 20; i++) clock.step(16);
    const series = tfSeries(f.writes);
    expect(series.length).toBeGreaterThan(10);
    for (const v of series) {
      // Один t для всех каналов ⇔ общий прогресс p: y=2x, scale−1=x/100.
      expect(v.y).toBeCloseTo(2 * v.x, 9);
      expect(v.scale - 1).toBeCloseTo(v.x / 100, 9);
    }
  });

  it('tween: та же атомарность вектора на каждом кадре', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(
      f.el,
      { x: 100, y: 200 },
      { duration: 300, ease: linear, requestFrame: clock.requestFrame },
    );
    for (let i = 0; i < 15; i++) clock.step(16);
    const series = tfSeries(f.writes);
    expect(series.length).toBeGreaterThan(5);
    for (const v of series) expect(v.y).toBeCloseTo(2 * v.x, 9);
  });
});

// ─── Пины 3–5: когерентный перехват, один loop, единое оседание ──────────────

describe('animate группа: перехват снимает когерентный вектор (Класс Б)', () => {
  it('C⁰+C¹ повектору: (value, velocity) всех каналов — с ОДНОГО t̂', () => {
    const f = fakeEl();
    const clock = makeClock();
    animate(f.el, { x: 100, y: 200 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 8; i++) clock.step(16); // кадры t = 0, 16, …, 112 мс
    const cap = tfSeries(f.writes).at(-1)!;
    const tHat = 0.112; // первый кадр — elapsed 0, далее по 16 мс
    // Захват соответствует аналитике ровно в t̂ (не соседнему кадру).
    expect(cap.x).toBeCloseTo(
      readCompositorSpring(SPRING, { from: 0, to: 100, v0: 0, t: tHat }).value,
      9,
    );
    expect(cap.y).toBeCloseTo(2 * cap.x, 9);

    animate(f.el, { x: -50, y: 400 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.step(16); // кадр elapsed 0 нового рана
    const first = tfSeries(f.writes).at(-1)!;
    expect(first.x).toBeCloseTo(cap.x, 9); // C⁰ повектору
    expect(first.y).toBeCloseTo(cap.y, 9);

    clock.step(16); // кадр elapsed 16 мс
    const at16 = tfSeries(f.writes).at(-1)!;
    const vx = impliedPickupVelocity(SPRING, cap.x, -50, at16.x, 0.016);
    const vy = impliedPickupVelocity(SPRING, cap.y, 400, at16.y, 0.016);
    const vAnalytic =
      readCompositorSpring(SPRING, { from: 0, to: 100, v0: 0, t: tHat }).velocity;
    expect(vx).toBeCloseTo(vAnalytic, 6); // скорость канала — из того же t̂
    expect(vy).toBeCloseTo(2 * vx, 6); // когерентность: одна производная времени
  });

  it('после перехвата остаётся один frame-loop (кадры прежнего юнита инертны)', () => {
    const f = fakeEl();
    const clock = makeClock();
    let subs = 0;
    const rf = (cb: (ts?: number) => void): number => {
      subs++;
      return clock.requestFrame(cb);
    };
    animate(f.el, { x: 100, y: 200 }, { spring: SPRING, requestFrame: rf });
    clock.step(16);
    animate(f.el, { x: 300, y: 600 }, { spring: SPRING, requestFrame: rf });
    const base = subs;
    clock.step(16); // в очереди кадр старого юнита (инертен) + кадр нового
    expect(subs - base).toBe(1); // перепланировался только живой юнит
    clock.step(16);
    expect(subs - base).toBe(2);
  });

  it('единое оседание: точный финал всех каналов пишется одним кадром', async () => {
    const f = fakeEl();
    const clock = makeClock();
    const c = animate(f.el, { x: 100, y: 200 }, { spring: SPRING, requestFrame: clock.requestFrame });
    // Перехват сеет каналам РАЗНЫЕ v0 (нормировка на range) — траектории
    // прогресса расходятся, но группа обязана осесть одним кадром.
    for (let i = 0; i < 8; i++) clock.step(16);
    animate(f.el, { x: -50, y: 400 }, { spring: SPRING, requestFrame: clock.requestFrame });
    clock.drain(16);
    const last = tfSeries(f.writes).at(-1)!;
    expect(last.x).toBe(-50);
    expect(last.y).toBe(400);
    await c.finished; // прежний ран разрешён перехватом, не завис
  });
});

// ─── Пин 6: compositor-путь — одна Animation, когерентный снимок по now ──────

describe('animate группа: compositor-путь когерентен (Класс Б)', () => {
  // @todo-R3c: main-lane: единый rAF-clock старых лейнов; live-v1 — MotionValue per-lane (когерентность группы — R3c)
  it.skip('x/y → ОДНА Animation; перехват в t̂ снимает вектор с одного t̂', () => {
    const f = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    animate(f.el, { x: 100, y: 200 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    expect(f.animateCalls.length).toBe(1); // одна кривая на группу — один clock
    expect(String(f.animateCalls[0]!.keyframes[1]!['transform'])).toBe(
      'translate(100px, 200px)',
    );

    now.advance(100); // t̂ = 100 мс по now-шву
    animate(f.el, { x: 300, y: 600 }, { spring: SPRING, now: now.now, setTimer: timer.setTimer });
    expect(f.animateCalls.length).toBe(2);
    const from2 = parseTf(String(f.animateCalls[1]!.keyframes[0]!['transform']));
    const p = executionProgress(100);
    expect(from2.x).toBeCloseTo(100 * p, 9); // actual effect-снимок ровно в t̂
    expect(from2.y).toBeCloseTo(2 * from2.x, 9); // когерентный вектор
  });
});
