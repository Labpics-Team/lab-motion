/**
 * test/animate-keyframes-tracks.test.ts — доказательная программа #205:
 * N-keyframe tracks в полном ./animate с общим owner/lifecycle.
 *
 * Классы (RED-гейты issue):
 *   D. Differential N=3/4/11 против НЕЗАВИСИМОГО наивного семплера
 *      (неравномерные/дублированные offsets, точные эндпоинты, числовой и
 *      CSS кодек).
 *   L. Lifecycle: multi-target + stagger, seek/pause/play/cancel/reduced,
 *      один onComplete, естественное завершение в последний стоп.
 *   C. Interruption/C¹: перехват трека в полёте наследует скорость
 *      (числовой канал); zero-width скачок right-biased; residual transform
 *      сохраняется.
 *   H. Hostile: sparse/mutating массивы — snapshot и fail-fast до записей.
 *   V. Валидация times/ease[] (LM168/LM169/LM138), трек+пружина → LM136,
 *      дефолтный режим трека — tween.
 */

import { describe, expect, it } from 'vitest';
import { animate } from '../src/animate/index.js';
import { MotionParamError } from '../src/errors.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

/** Независимый right-biased семплер (структурно другой скан, чем production). */
function naiveTrack(
  stops: readonly number[],
  offsets: readonly number[],
  k: number,
  ease: (u: number) => number = (u) => u,
): number {
  if (k <= 0) return stops[0]!;
  if (k >= 1) return stops[stops.length - 1]!;
  let segment = 0;
  for (let i = 0; i <= offsets.length - 2; i++) {
    if (k >= offsets[i]!) segment = i;
  }
  const span = offsets[segment + 1]! - offsets[segment]!;
  const u = span > 0 ? Math.min(1, Math.max(0, (k - offsets[segment]!) / span)) : 1;
  return stops[segment]! + (stops[segment + 1]! - stops[segment]!) * ease(u);
}

const uniform = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => i / (n - 1));

/** Значение opacity из журнала записей (единственная числовая поверхность). */
const opacityWrites = (writes: readonly { prop: string; value: string }[]): number[] =>
  writes.filter((w) => w.prop === 'opacity').map((w) => Number(w.value));

const noReduce = () => ({ matches: false });

// ─── D. Differential против независимого семплера ────────────────────────────

describe('#205/D дифференциал трека против независимого семплера', () => {
  it.each([
    [3, [0, 1, 0.25]],
    [4, [0, 1, -0.5, 0.75]],
    [11, [0, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.5, 1]],
  ] as const)('N=%d: равномерные offsets, линейный изинг', (_n, stops) => {
    const clock = makeClock();
    const target = fakeEl();
    const durationMs = 800;
    animate(target.el, { opacity: [...stops] }, {
      duration: durationMs,
      ease: (u) => u,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    const values = opacityWrites(target.writes);
    expect(values.length).toBeGreaterThan(10);
    const offsets = uniform(stops.length);
    for (let i = 0; i < values.length - 1; i++) {
      const k = (16 * i) / durationMs;
      expect(
        Math.abs(values[i]! - naiveTrack(stops, offsets, k)),
        `k=${k}`,
      ).toBeLessThanOrEqual(1e-9);
    }
    // Естественный финал — точно последний стоп.
    expect(values[values.length - 1]).toBe(stops[stops.length - 1]);
  });

  it('authored times: неравномерные offsets + per-segment изинги', () => {
    const clock = makeClock();
    const target = fakeEl();
    const stops = [0, 1, 0.5];
    const times = [0, 0.2, 1];
    const easeIn = (u: number): number => u * u;
    const easeOut = (u: number): number => 1 - (1 - u) * (1 - u);
    animate(target.el, { opacity: stops }, {
      duration: 500,
      times,
      ease: [easeIn, easeOut],
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    const values = opacityWrites(target.writes);
    for (let i = 0; i < values.length - 1; i++) {
      const k = (16 * i) / 500;
      const segment = k >= 0.2 ? 1 : 0;
      const expected = naiveTrack(stops, times, k, segment === 0 ? easeIn : easeOut);
      expect(Math.abs(values[i]! - expected), `k=${k}`).toBeLessThanOrEqual(1e-9);
    }
  });

  it('CSS-кодек: цветовой трек интерполируется по сегментам и оседает в финале', () => {
    const clock = makeClock();
    const target = fakeEl();
    animate(target.el, {
      backgroundColor: ['rgb(0, 0, 0)', 'rgb(200, 100, 0)', 'rgb(0, 0, 250)'],
    }, {
      duration: 400,
      ease: (u) => u,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    const writes = target.writes.filter((w) => w.prop === 'background-color');
    expect(writes.length).toBeGreaterThan(5);
    // Середина первого сегмента (k=0.25 → u=0.5): между чёрным и оранжевым.
    const mid = writes[Math.round((0.25 * 400) / 16)]!.value;
    const channels = /rgb\((\d+), (\d+), (\d+)\)/.exec(mid);
    expect(channels).not.toBeNull();
    expect(Number(channels![1])).toBeGreaterThan(50);
    expect(Number(channels![1])).toBeLessThan(200);
    // Финал — точно последний стоп.
    expect(writes[writes.length - 1]!.value).toBe('rgb(0, 0, 250)');
  });

  it('zero-width скачок right-biased: на дубликате offset виден поздний стоп', () => {
    const clock = makeClock();
    const target = fakeEl();
    animate(target.el, { opacity: [0, 0.1, 0.2, 0.3] }, {
      duration: 320, // k-шаг 16/320 = 0.05: k=0.5 попадает на дубликат ровно
      times: [0, 0.5, 0.5, 1],
      ease: (u) => u,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    const values = opacityWrites(target.writes);
    const beforeJump = values[Math.round((0.45 * 320) / 16)]!;
    const atJump = values[Math.round((0.5 * 320) / 16)]!;
    expect(beforeJump).toBeLessThan(0.1 + 1e-9); // сегмент 0 → приближение к 0.1
    expect(atJump).toBeGreaterThanOrEqual(0.2 - 1e-9); // right-bias: стоп 0.2 уже виден
  });
});

// ─── L. Lifecycle ────────────────────────────────────────────────────────────

describe('#205/L lifecycle трека', () => {
  it('multi-target + stagger: оба оседают в последний стоп, onComplete один раз', async () => {
    const clock = makeClock();
    const a = fakeEl();
    const b = fakeEl();
    let completions = 0;
    const controls = animate([a.el, b.el], { opacity: [0, 1, 0.5] }, {
      duration: 200,
      stagger: 48,
      onComplete: () => { completions++; },
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    await controls.finished;
    expect(completions).toBe(1);
    expect(opacityWrites(a.writes).at(-1)).toBe(0.5);
    expect(opacityWrites(b.writes).at(-1)).toBe(0.5);
    // Каскад: вторая цель стартует позже (меньше кадров при том же drain).
    expect(opacityWrites(b.writes).length).toBeLessThan(opacityWrites(a.writes).length + 1);
  });

  it('seek позиционирует трек по своему k; pause замораживает', () => {
    const clock = makeClock();
    const target = fakeEl();
    const controls = animate(target.el, { opacity: [0, 1, 0.5] }, {
      duration: 400,
      ease: (u) => u,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    controls.pause();
    controls.seek(100); // k=0.25 → сегмент 0, u=0.5 → 0.5
    const values = opacityWrites(target.writes);
    expect(Math.abs(values[values.length - 1]! - 0.5)).toBeLessThanOrEqual(1e-9);
    controls.seek(300); // k=0.75 → сегмент 1, u=0.5 → 0.75
    expect(Math.abs(opacityWrites(target.writes).at(-1)! - 0.75)).toBeLessThanOrEqual(1e-9);
  });

  it('cancel сохраняет текущую позу; reduced публикует последний стоп без кадров', async () => {
    const clock = makeClock();
    const target = fakeEl();
    const controls = animate(target.el, { opacity: [0, 1, 0.5] }, {
      duration: 400,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.step(16);
    clock.step(16);
    controls.cancel();
    const frames = opacityWrites(target.writes).length;
    clock.drain(16);
    expect(opacityWrites(target.writes).length).toBe(frames); // кадры остановлены
    await controls.finished;

    const reducedTarget = fakeEl();
    animate(reducedTarget.el, { opacity: [0, 1, 0.5] }, {
      duration: 400,
      requestFrame: clock.requestFrame,
      matchMedia: () => ({ matches: true }),
    });
    const reducedValues = opacityWrites(reducedTarget.writes);
    expect(reducedValues).toEqual([0.5]); // мгновенный финал, ноль кадров
  });
});

// ─── C. Interruption / C¹ / композиция ───────────────────────────────────────

describe('#205/C прерывание и композиция', () => {
  it('перехват трека наследует скорость: pickup-старт обгоняет rest-старт', () => {
    const spring = { mass: 1, stiffness: 120, damping: 14 };
    const run = (explicitFrom: boolean): number => {
      const clock = makeClock();
      const target = fakeEl();
      animate(target.el, { opacity: [0, 1, 0.5] }, {
        duration: 400,
        ease: (u) => u,
        requestFrame: clock.requestFrame,
        matchMedia: noReduce,
      });
      // До k≈0.3 (сегмент 0, восходящий, скорость > 0).
      for (let i = 0; i < 8; i++) clock.step(16);
      const position = opacityWrites(target.writes).at(-1)!;
      animate(target.el, explicitFrom ? { opacity: [position, 1] } : { opacity: 1 }, {
        spring,
        requestFrame: clock.requestFrame,
        matchMedia: noReduce,
      });
      clock.step(16);
      clock.step(16);
      return opacityWrites(target.writes).at(-1)!;
    };
    const withPickup = run(false);   // подхват value+velocity (C¹)
    const fromRest = run(true);      // явная пара отключает подхват (v0=0)
    // Унаследованная положительная скорость двигает pickup-путь заметно дальше.
    expect(withPickup).toBeGreaterThan(fromRest + 1e-4);
  });

  it('residual transform: трек x не сбрасывает прежний rotate', async () => {
    const clock = makeClock();
    const target = fakeEl();
    const first = animate(target.el, { rotate: 45 }, {
      duration: 100,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    await first.finished;
    animate(target.el, { x: [0, 20, 10] }, {
      duration: 200,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.step(16);
    clock.step(16);
    const lastTransform = target.writes.filter((w) => w.prop === 'transform').at(-1)!;
    expect(lastTransform.value).toContain('rotate(45deg)');
    expect(lastTransform.value).toContain('translateX(');
  });
});

// ─── H. Hostile ──────────────────────────────────────────────────────────────

describe('#205/H hostile-массивы', () => {
  it('sparse-кортеж → LM142 до каких-либо записей', () => {
    const clock = makeClock();
    const target = fakeEl();
    const sparse: (number | undefined)[] = [0, undefined, 1];
    let caught: unknown;
    try {
      animate(target.el, { opacity: sparse as never }, {
        duration: 100,
        requestFrame: clock.requestFrame,
        matchMedia: noReduce,
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe('LM142');
    expect(target.writes).toEqual([]);
  });

  it('stateful getter читается ровно один раз (snapshot до валидации)', () => {
    const clock = makeClock();
    const target = fakeEl();
    let reads = 0;
    const hostile = [0, 0, 1];
    Object.defineProperty(hostile, 1, {
      get() { reads++; return 0.5; },
    });
    animate(target.el, { opacity: hostile }, {
      duration: 100,
      ease: (u) => u,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    expect(reads).toBe(1);
    clock.drain(16);
    expect(opacityWrites(target.writes).at(-1)).toBe(1);
  });
});

// ─── V. Валидация ────────────────────────────────────────────────────────────

describe('#205/V контракт times/ease[]/режима', () => {
  const el = () => fakeEl().el;
  const throwsCode = (code: string, fn: () => unknown): void => {
    let caught: unknown;
    try { fn(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe(code);
  };

  it('трек без options легален: дефолтный tween-режим', async () => {
    const clock = makeClock();
    const target = fakeEl();
    const controls = animate(target.el, { opacity: [0, 1, 0.25] }, {
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    await controls.finished;
    expect(opacityWrites(target.writes).at(-1)).toBe(0.25);
  });

  it('трек + явная пружина → LM136 синхронно', () => {
    throwsCode('LM136', () => animate(el(), { opacity: [0, 1, 0.5] }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
    }));
  });

  it('times + пружина → LM136 (times — грамматика keyframe-движка)', () => {
    throwsCode('LM136', () => animate(el(), { opacity: [0, 1] }, {
      spring: { mass: 1, stiffness: 170, damping: 26 },
      times: [0, 1],
    }));
  });

  it('матрица некорректных times → LM168', () => {
    for (const times of [
      5 as never,                    // не массив
      [0],                           // длина < 2
      [0.1, 1],                      // первый ≠ 0
      [0, 0.9],                      // последний ≠ 1
      [0, Number.NaN, 1],            // не конечное
      [0, 0.7, 0.3, 1],              // убывание
      [0, 2, 1] as never,            // вне [0,1] и убывание к последнему
    ]) {
      throwsCode('LM168', () => animate(el(), { opacity: [0, 1, 0.5] }, {
        duration: 100,
        times: times as never,
      }));
    }
  });

  it('несовпадение топологии с times → LM168 (пары/дестинации включительно)', () => {
    throwsCode('LM168', () => animate(el(), { opacity: [0, 1] }, {
      duration: 100,
      times: [0, 0.5, 1],
    }));
    throwsCode('LM168', () => animate(el(), { opacity: 1 }, {
      duration: 100,
      times: [0, 1],
    }));
    throwsCode('LM168', () => animate(el(), { x: [0, 10, 0], opacity: [0, 1] }, {
      duration: 100,
      times: [0, 0.5, 1],
    }));
  });

  it('ease[]: пустой → LM169; не-функция → LM138; длина ≠ N−1 → LM169', () => {
    throwsCode('LM169', () => animate(el(), { opacity: [0, 1, 0.5] }, {
      duration: 100,
      ease: [] as never,
    }));
    throwsCode('LM138', () => animate(el(), { opacity: [0, 1, 0.5] }, {
      duration: 100,
      ease: [(u: number) => u, 'linear'] as never,
    }));
    throwsCode('LM169', () => animate(el(), { opacity: [0, 1, 0.5] }, {
      duration: 100,
      ease: [(u: number) => u],
    }));
  });

  it('кортеж длины 1 → LM141; пары остаются легальными', () => {
    throwsCode('LM141', () => animate(el(), { opacity: [1] as never }, { duration: 100 }));
    const clock = makeClock();
    expect(() => animate(el(), { opacity: [0, 1] }, {
      duration: 100,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    })).not.toThrow();
  });

  it('смешение пар и треков БЕЗ times легально (каждый канал со своей сеткой)', async () => {
    const clock = makeClock();
    const target = fakeEl();
    const controls = animate(target.el, { opacity: [0, 1], x: [0, 20, 10] }, {
      duration: 200,
      requestFrame: clock.requestFrame,
      matchMedia: noReduce,
    });
    clock.drain(16);
    await controls.finished;
    expect(opacityWrites(target.writes).at(-1)).toBe(1);
    expect(target.writes.filter((w) => w.prop === 'transform').at(-1)!.value)
      .toContain('translateX(10px)');
  });
});
