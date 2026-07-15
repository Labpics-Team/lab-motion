/**
 * Враждебные runtime-границы фасада ./animate: цели, delay-capture и host-clock.
 * Проверки идут через публичную траекторию; deep-import нужен только для SSOT cap.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fullApi from '../src/animate/index.js';
import {
  collectBoundedArrayLike,
  MAX_ANIMATE_TARGETS,
} from '../src/animate/targets.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import { MotionParamError } from '../src/errors.js';
import type { FrameLoop } from '../src/frame/index.js';
import {
  fakeEl,
  makeClock,
  pickAnimate,
  pickLiveAnimate,
  translateXSeries,
  type AnimateFn,
} from './animate-facade-helpers.js';

const engines: ReadonlyArray<readonly [string, AnimateFn]> = [
  ['full', pickLiveAnimate(fullApi as Record<string, unknown>)],
];
const SPRING = { mass: 1, stiffness: 170, damping: 26 };
const linear = (t: number): number => t;

afterEach(() => vi.unstubAllGlobals());

it('bounded helper принимает точную границу 100 000', () => {
  expect(collectBoundedArrayLike({ length: MAX_ANIMATE_TARGETS }))
    .toHaveLength(MAX_ANIMATE_TARGETS);
});

it.each([-1, 1.5, NaN, Infinity, -Infinity, MAX_ANIMATE_TARGETS + 1])(
  'bounded helper отклоняет length=%s до чтения индекса',
  (length) => {
    let reads = 0;
    const source = {
      length,
      get 0() {
        reads++;
        return undefined;
      },
    };
    expect(() => collectBoundedArrayLike(source)).toThrow(MotionParamError);
    expect(reads).toBe(0);
  },
);

function makeHostClock(): {
  requestFrame(cb: (ts?: number) => void): number;
  emit(ts: number | undefined): void;
  pending(): number;
} {
  let queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  return {
    requestFrame(cb) {
      queue.push(cb);
      return ++handle;
    },
    emit(ts) {
      const batch = queue;
      queue = [];
      for (const cb of batch) cb(ts);
    },
    pending: () => queue.length,
  };
}

function expectedSpring(from: number, to: number, velocity: number, t = 0.016): number {
  return readCompositorSpring(SPRING, {
    from,
    to,
    v0: velocity / (to - from),
    t,
  }).value;
}

for (const [name, animate] of engines) {
  // @todo-R3c: old-lane: play-throw контракт старого MainUnit; политика live — R3c
  it.skip(`${name}: неудачный play восстанавливает paused и допускает повтор`, () => {
    let queue: Array<(ts?: number) => void> = [];
    let fail = false;
    const requestFrame = (cb: (ts?: number) => void): number => {
      if (fail) throw new Error('resume schedule failed');
      queue.push(cb);
      return 1;
    };
    const emit = (ts: number): void => {
      const batch = queue;
      queue = [];
      for (const cb of batch) cb(ts);
    };
    const target = fakeEl();
    const controls = animate(target.el, { x: [0, 100] }, {
      duration: 32,
      requestFrame,
    });
    controls.pause();
    emit(0); // гасит уже поставленный инертный callback и открывает новый schedule

    fail = true;
    expect(() => controls.play()).toThrow('resume schedule failed');
    fail = false;
    expect(() => controls.play()).not.toThrow();
    expect(queue).toHaveLength(1);

    emit(10);
    emit(26);
    emit(42);
    expect(translateXSeries(target.writes).at(-1)).toBe(100);
  });

  describe(`${name}: ограниченная граница целей`, () => {
    it('прямая цель проверяется до length и не читает hostile getter', () => {
      const target = fakeEl();
      let lengthReads = 0;
      Object.defineProperty(target.el, 'length', {
        get() {
          lengthReads++;
          throw new Error('length не должен читаться');
        },
      });
      const controls = animate(target.el, { x: [0, 1] }, {
        duration: 10,
        requestFrame: () => 1,
      });
      expect(lengthReads).toBe(0);
      controls.cancel();
    });

    it.each([-1, 1.5, NaN, Infinity, -Infinity, 100_001, Number.MAX_SAFE_INTEGER])(
      'отклоняет length=%s до чтения индексов и побочных эффектов',
      (length) => {
        const target = fakeEl();
        const requestFrame = vi.fn(() => 1);
        let itemReads = 0;
        const hostile = {
          length,
          get 0() {
            itemReads++;
            return target.el;
          },
        };
        expect(() =>
          animate(hostile, { x: [0, 1] }, { duration: 10, requestFrame }),
        ).toThrow(MotionParamError);
        expect(itemReads).toBe(0);
        expect(requestFrame).not.toHaveBeenCalled();
        expect(target.writes).toEqual([]);
      },
    );

    it('снимает length и каждый индекс ровно один раз', () => {
      const target = fakeEl();
      let lengthReads = 0;
      let itemReads = 0;
      const stateful = {
        get length() {
          lengthReads++;
          return lengthReads === 1 ? 1 : 0;
        },
        get 0() {
          itemReads++;
          return target.el;
        },
      };
      const controls = animate(stateful, { x: [0, 1] }, {
        duration: 10,
        requestFrame: () => 1,
      });
      expect(lengthReads).toBe(1);
      expect(itemReads).toBe(1);
      controls.cancel();
    });

    it('selector сохраняет document receiver и ограничивает возвращённый список', () => {
      let itemReads = 0;
      let calls = 0;
      let queryReads = 0;
      let selector = '';
      const doc: Record<string, unknown> = {};
      Object.defineProperty(doc, 'querySelectorAll', {
        get() {
          queryReads++;
          return function (this: unknown, value: string) {
            if (this !== doc) throw new TypeError('Illegal invocation');
            calls++;
            selector = value;
            return {
              length: 100_001,
              get 0() {
                itemReads++;
                return fakeEl().el;
              },
            };
          };
        },
      });
      vi.stubGlobal('document', doc);
      expect(() => animate('.item', { x: [0, 1] }, { duration: 10 }))
        .toThrow(MotionParamError);
      expect(queryReads).toBe(1);
      expect(calls).toBe(1);
      expect(selector).toBe('.item');
      expect(itemReads).toBe(0);
    });
  });

  describe(`${name}: capture до delay`, () => {
    // @todo-R3c: old-lane: capture-до-delay семантика старых лейнов; live — R3c
    it.skip('не переносит скорость неподвижного delayed tween в numeric и CSS-канал', () => {
      const target = fakeEl({ '--gap': '0px' });
      const clock = makeClock();
      animate(target.el, { x: [0, 100], '--gap': ['0px', '100px'] }, {
        duration: 400,
        ease: linear,
        delay: 500,
        requestFrame: clock.requestFrame,
      });
      animate(target.el, { x: 200, '--gap': '200px' }, {
        spring: SPRING,
        requestFrame: clock.requestFrame,
      });
      clock.step(16);
      clock.step(16);

      const expected = expectedSpring(0, 200, 0);
      expect(translateXSeries(target.writes).at(-1)).toBeCloseTo(expected, 8);
      const gap = Number.parseFloat(
        target.writes.filter(({ prop }) => prop === '--gap').at(-1)!.value,
      );
      expect(gap).toBeCloseTo(expected, 8);
    });

    // @todo-R3c: old-lane: capture-до-delay семантика старых лейнов; live — R3c
    it.skip('seek активирует delayed tween и сохраняет его реальную скорость', () => {
      const target = fakeEl();
      const clock = makeClock();
      const delayed = animate(target.el, { x: [0, 100] }, {
        duration: 400,
        ease: linear,
        delay: 500,
        requestFrame: clock.requestFrame,
      });
      delayed.seek(200);
      animate(target.el, { x: 200 }, { spring: SPRING, requestFrame: clock.requestFrame });
      clock.step(16);
      clock.step(16);
      expect(translateXSeries(target.writes).at(-1))
        .toBeCloseTo(expectedSpring(50, 200, 250), 7);
    });

    // @todo-R3c: old-lane: capture-до-delay семантика старых лейнов; live — R3c
    it.skip('неудачный preflight capture не уничтожает seeded v0 delayed spring', () => {
      const target = fakeEl();
      const clock = makeClock();
      const source = animate(target.el, { x: [0, 100] }, {
        duration: 400,
        ease: linear,
        requestFrame: clock.requestFrame,
      });
      source.seek(200);
      animate(target.el, { x: 300 }, {
        spring: SPRING,
        delay: 32,
        requestFrame: clock.requestFrame,
      });

      const bad = fakeEl().el;
      Object.defineProperty(bad, 'animate', {
        get() {
          throw new Error('late full plan');
        },
      });
      expect(() => animate([target.el, bad], { x: 400 }, { duration: 100 }))
        .toThrow('late full plan');

      clock.step(16);
      clock.step(16);
      clock.step(16);
      // Full на третьем кадре logical=delay: local=0; mini имеет иной clock contract.
      if (name === 'full') clock.step(16);
      expect(translateXSeries(target.writes).at(-1))
        .toBeCloseTo(expectedSpring(50, 300, 250), 7);
    });
  });

  describe(`${name}: нефинитный timestamp`, () => {
    // @todo-R3c: old-lane: timestamp-контракт кадрового цикла закрыт тестами MotionValue; live-обёртка — R3c
    it.skip.each([NaN, Infinity, -Infinity])(
      '%s даёт ровно fixed-step и сбрасывает baseline без скачка',
      async (badTs) => {
        const target = fakeEl();
        const clock = makeHostClock();
        const onComplete = vi.fn();
        const controls = animate(target.el, { x: [0, 100] }, {
          duration: 1_000,
          ease: linear,
          requestFrame: clock.requestFrame,
          onComplete,
        });

        clock.emit(10); // конечный baseline, t=0
        clock.emit(badTs); // один шаг 1000/60 мс
        const afterFallback = translateXSeries(target.writes).at(-1)!;
        expect(afterFallback).toBeCloseTo(100 / 60, 10);
        expect(onComplete).not.toHaveBeenCalled();

        clock.emit(1_000_000); // новая эпоха: dt=0, без прыжка
        expect(translateXSeries(target.writes).at(-1)).toBe(afterFallback);
        clock.emit(1_000_016);
        expect(translateXSeries(target.writes).at(-1)).toBeCloseTo(100 * (16 + 1_000 / 60) / 1_000, 10);

        clock.emit(1_001_016);
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(translateXSeries(target.writes).at(-1)).toBe(100);
        expect(clock.pending()).toBe(0);
        await expect(controls.finished).resolves.toBeUndefined();
      },
    );

    // @todo-R3c: old-lane: timestamp-контракт кадрового цикла закрыт тестами MotionValue; live-обёртка — R3c
    it.skip('переполнение конечной дельты использует один fixed-step', () => {
      const target = fakeEl();
      const clock = makeHostClock();
      const controls = animate(target.el, { x: [0, 100] }, {
        duration: 1_000,
        ease: linear,
        requestFrame: clock.requestFrame,
      });
      clock.emit(-Number.MAX_VALUE);
      clock.emit(Number.MAX_VALUE);
      expect(translateXSeries(target.writes).at(-1)).toBeCloseTo(100 / 60, 10);
      clock.emit(0);
      expect(translateXSeries(target.writes).at(-1)).toBeCloseTo(100 / 60, 10);
      controls.cancel();
    });
  });
}
