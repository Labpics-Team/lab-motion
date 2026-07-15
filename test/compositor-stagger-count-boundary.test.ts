/**
 * Строгая граница compositor-stagger не должна наследовать forgiving-clamp
 * публичного stagger: иначе plan.count расходится с delays.length, а хвост
 * группы бесшумно получает нулевые задержки.
 */

import { describe, expect, it } from 'vitest';
import {
  compileStaggerPlan,
  CompositorStaggerGroup,
} from '../src/compositor/stagger/index.js';
import { stagger, type StaggerOptions } from '../src/stagger/index.js';
import { MotionParamError } from '../src/errors.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;
const MAX_STAGGER_COUNT = 100_000;

/** Независимый оракул прежнего двухпроходного алгоритма, не импортирующий SSOT. */
function legacyStagger(count: number, options: StaggerOptions): number[] {
  if (count === 0) return [];
  if (count === 1) return [0];
  if (options.reducedMotion === true) return new Array<number>(count).fill(0);

  const gapInput = options.gap;
  const gap = gapInput != null && Number.isFinite(gapInput) && gapInput >= 0
    ? gapInput
    : 50;
  const from = options.from ?? 'first';
  const ease = typeof options.easing === 'function'
    ? options.easing
    : (value: number): number => value;
  const columnsInput = options.grid?.columns;
  const columns = columnsInput != null && Number.isFinite(columnsInput) && columnsInput >= 1
    ? Math.floor(columnsInput)
    : undefined;
  const result = new Array<number>(count);

  if (columns != null) {
    const rows = Math.ceil(count / columns);
    if (from === 'edges') {
      const lastRow = rows - 1;
      const lastColumn = columns - 1;
      for (let index = 0; index < count; index++) {
        const row = Math.floor(index / columns);
        const column = index % columns;
        result[index] = Math.min(
          Math.min(row, lastRow - row),
          Math.min(column, lastColumn - column),
        );
      }
    } else {
      let originRow: number;
      let originColumn: number;
      if (from === 'first') {
        originRow = originColumn = 0;
      } else if (from === 'last') {
        originRow = Math.floor((count - 1) / columns);
        originColumn = (count - 1) % columns;
      } else if (from === 'center') {
        originRow = (rows - 1) / 2;
        originColumn = (columns - 1) / 2;
      } else {
        const rawOrigin = typeof from === 'number' ? from : 0;
        const origin = Number.isFinite(rawOrigin)
          ? Math.max(0, Math.min(count - 1, Math.round(rawOrigin)))
          : 0;
        originRow = Math.floor(origin / columns);
        originColumn = origin % columns;
      }
      for (let index = 0; index < count; index++) {
        const rowDelta = Math.floor(index / columns) - originRow;
        const columnDelta = index % columns - originColumn;
        const distance = Math.sqrt(rowDelta * rowDelta + columnDelta * columnDelta);
        result[index] = Number.isFinite(distance) ? distance : 0;
      }
    }
  } else if (from === 'first') {
    for (let index = 0; index < count; index++) result[index] = index;
  } else if (from === 'last') {
    for (let index = 0; index < count; index++) result[index] = count - 1 - index;
  } else if (from === 'center') {
    const center = (count - 1) / 2;
    for (let index = 0; index < count; index++) result[index] = Math.abs(index - center);
  } else if (from === 'edges') {
    for (let index = 0; index < count; index++) {
      result[index] = Math.min(index, count - 1 - index);
    }
  } else {
    const rawOrigin = typeof from === 'number' ? from : 0;
    const origin = Number.isFinite(rawOrigin)
      ? Math.max(0, Math.min(count - 1, Math.round(rawOrigin)))
      : 0;
    for (let index = 0; index < count; index++) result[index] = Math.abs(index - origin);
  }

  let maxDistance = 0;
  for (const distance of result) {
    if (Number.isFinite(distance) && distance > maxDistance) maxDistance = distance;
  }
  for (let index = 0; index < count; index++) {
    if (maxDistance === 0 || gap === 0) {
      result[index] = 0;
      continue;
    }
    const distance = result[index]!;
    const position = Number.isFinite(distance) ? distance / maxDistance : 0;
    const easedPosition = ease(position);
    const delay = Number.isFinite(easedPosition)
      ? easedPosition * maxDistance * gap
      : 0;
    result[index] = Number.isFinite(delay) && delay >= 0 ? delay : 0;
  }
  return result;
}

function expectLm017(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MotionParamError);
    expect((error as MotionParamError).code).toBe('LM017');
    return;
  }
  throw new Error('Ожидалась LM017');
}

describe('compositor stagger: строгая граница count', () => {
  it('count=100000 сохраняет точную длину и конечный хвост', () => {
    const plan = compileStaggerPlan({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      count: MAX_STAGGER_COUNT,
      gap: 1,
    });

    expect(plan.count).toBe(MAX_STAGGER_COUNT);
    expect(plan.delays).toHaveLength(MAX_STAGGER_COUNT);
    expect(plan.delays.at(-1)).toBe(MAX_STAGGER_COUNT - 1);
    expect(Number.isFinite(plan.delays.at(-1))).toBe(true);
  });

  it('count=100001 отклоняется LM017 до валидации пружины и materialization', () => {
    expectLm017(() => compileStaggerPlan({
      spring: { mass: -1, stiffness: 0, damping: -1 },
      property: '',
      from: Number.NaN,
      to: Number.POSITIVE_INFINITY,
      count: MAX_STAGGER_COUNT + 1,
    }));
  });

  it('огромный integer отклоняется LM017 до пружины и массива задержек', () => {
    expectLm017(() => compileStaggerPlan({
      spring: { mass: -1, stiffness: 0, damping: -1 },
      property: '',
      from: Number.NaN,
      to: Number.POSITIVE_INFINITY,
      count: Number.MAX_SAFE_INTEGER,
    }));
  });

  it('hostile count отклоняется LM017 без coercion и до остальных полей', () => {
    let coercions = 0;
    const hostile = {
      valueOf(): never {
        coercions++;
        throw new Error('count не должен приводиться к числу');
      },
    };
    for (const count of [Symbol('count'), 1n, hostile]) {
      expectLm017(() => compileStaggerPlan({
        spring: { mass: -1, stiffness: 0, damping: -1 },
        property: '',
        from: Number.NaN,
        to: Number.POSITIVE_INFINITY,
        count: count as unknown as number,
      }));
    }
    expect(coercions).toBe(0);
  });

  it('группа не может получить обрезанный план и нулевой хвост', () => {
    const targets = new Array<undefined>(MAX_STAGGER_COUNT + 1);
    expectLm017(() => new CompositorStaggerGroup({
      spring: { mass: -1, stiffness: 0, damping: -1 },
      property: '',
      from: Number.NaN,
      to: Number.POSITIVE_INFINITY,
      targets,
    }));
  });

  it('публичный stagger сохраняет forgiving-clamp на 100001', () => {
    const delays = stagger(MAX_STAGGER_COUNT + 1, { gap: 1 });
    expect(delays).toHaveLength(MAX_STAGGER_COUNT);
    expect(delays.at(-1)).toBe(MAX_STAGGER_COUNT - 1);
  });
});

describe('compositor stagger: seeded differential с публичным scheduler', () => {
  it('forgiving-граница гасит нечисловой результат easing до арифметики', () => {
    const hostileResults = [
      Symbol('delay'),
      1n,
      { valueOf(): never { throw new Error('арифметика не должна начаться'); } },
    ];

    for (const hostileResult of hostileResults) {
      const easing = (() => hostileResult) as unknown as (value: number) => number;
      expect(stagger(4, { easing })).toEqual([0, 0, 0, 0]);
      expect(compileStaggerPlan({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
        count: 4,
        staggerEasing: easing,
      }).delays).toEqual([0, 0, 0, 0]);
    }
  });

  it('совпадает для всех origins, grid, easing, reduced-motion и hostile-значений', () => {
    let state = 0x51a66e2d;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const origins = [
      'first',
      'last',
      'center',
      'edges',
      -10,
      2.4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ] as const;
    const easings = [
      undefined,
      (t: number): number => t,
      (t: number): number => t * t,
      (): number => Number.NaN,
      (): number => Number.POSITIVE_INFINITY,
      (t: number): number => -t,
    ] as const;
    const gaps = [undefined, 0, 13, -1, Number.NaN, Number.POSITIVE_INFINITY] as const;
    const columns = [undefined, 1, 3, 17, 0, Number.NaN, Number.POSITIVE_INFINITY] as const;

    for (let iteration = 0; iteration < 168; iteration++) {
      const count = 2 + Math.floor(random() * 63);
      const from = origins[iteration % origins.length]!;
      const easing = easings[iteration % easings.length];
      const gap = gaps[(iteration * 5 + 1) % gaps.length];
      const columnCount = columns[(iteration * 3 + 2) % columns.length];
      const reducedMotion = iteration % 4 === 0;
      const grid = columnCount === undefined ? undefined : { columns: columnCount };
      const options: StaggerOptions = { from, easing, gap, grid, reducedMotion };

      const expected = legacyStagger(count, options);
      expect(stagger(count, options)).toEqual(expected);
      const actual = compileStaggerPlan({
        spring: SPRING,
        property: 'opacity',
        from: 0,
        to: 1,
        count,
        gap,
        staggerFrom: from,
        staggerEasing: easing,
        grid,
        reducedMotion,
      }).delays;

      expect(actual).toEqual(expected);
    }
  });
});
