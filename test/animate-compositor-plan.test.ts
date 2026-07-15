/**
 * test/animate-compositor-plan.test.ts — планировщик compositor-плана
 * (срез R3a rebuild): паритет LM-кодов с фасадом, C¹-подхват, ownership.
 *
 * ── RED PROOF (авторские мутации, каждая роняет конкретный блок) ─────────────
 * - Убрать снимок владельца из подхвата → «C¹ sharedV0 паритет» RED
 *   (ir перестаёт совпадать с springProgressCurve(spring, v0)).
 * - Писать в стиль во время buildCompositorPlan → «фазовая дисциплина» RED.
 * - Прервать предыдущего владельца в фазе чтения → та же дисциплина RED
 *   (supersede-счётчик обязан быть нулевым до publish).
 * - Снять субнормальный нудж identity-краёв → «симметрия transform-кадров» RED.
 * - Пустить нечисловую пару в explicit-режим → «маршрутизация explicit» RED.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCompositorPlan,
  type CompositorPlanOptions,
  type PlanGroupOwner,
  type PlannedUnitGroup,
  type PlanTarget,
} from '../src/animate/compositor-plan.js';
import type { ProgressSnapshot } from '../src/animate/compositor-unit.js';
import {
  easeProgressCurve,
  springProgressCurve,
} from '../src/animate/linear-compile.js';
import { STANDARD_EASING } from '../src/internal/motion-defaults.js';
import { MotionParamError } from '../src/errors.js';
import { type SpringParams } from '../src/spring.js';

const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };

// ─── Обвязка ─────────────────────────────────────────────────────────────────

interface Target {
  readonly el: PlanTarget;
  readonly writes: { prop: string; value: string }[];
}

function planTarget(initial: Record<string, string> = {}, waapi = true): Target {
  const writes: Target['writes'] = [];
  const el: PlanTarget = {
    style: {
      setProperty(prop: string, value: string): void {
        writes.push({ prop, value });
      },
      getPropertyValue(name: string): string {
        return initial[name] ?? '';
      },
    },
  };
  if (waapi) {
    (el as { animate?: unknown }).animate = () => ({ cancel() {} });
  }
  return { el, writes };
}

function fakeOwner(snapshot?: ProgressSnapshot): {
  readonly owner: PlanGroupOwner;
  readonly journal: string[];
} {
  const journal: string[] = [];
  const owner: PlanGroupOwner = {
    _supersede(replacement?: () => void): void {
      journal.push('supersede');
      replacement?.();
    },
    _rollback(): void {
      journal.push('rollback');
    },
  };
  if (snapshot) owner._snapshot = () => snapshot;
  return { owner, journal };
}

function makeOptions(
  target: Target,
  props: Record<string, unknown>,
  overrides: Partial<CompositorPlanOptions> = {},
): CompositorPlanOptions {
  return {
    _targets: [target.el],
    _props: props,
    _mode: { kind: 'spring', spring: SPRING },
    _seams: { _now: () => 0, _setTimer: () => () => {} },
    _capability: { _linearSupported: true },
    _reducedMotion: false,
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MotionParamError);
    return (error as MotionParamError).code;
  }
  throw new Error('ожидался MotionParamError');
}

/** Публикует прогон группы, эмулируя фасадный commit (канон duplicate). */
function publishRun(
  entry: PlannedUnitGroup,
  snapshot?: ProgressSnapshot,
): ReturnType<typeof fakeOwner> {
  const fake = fakeOwner(snapshot);
  entry._begin();
  entry._publish(fake.owner);
  return fake;
}

// ─── Паритет валидационных LM-кодов с фасадом ────────────────────────────────

describe('compositor-plan: паритет LM-кодов', () => {
  it('таблица кейсов animate-error-codes воспроизводится планировщиком', () => {
    const t = (): Target => planTarget();
    const run = (props: Record<string, unknown>): unknown =>
      buildCompositorPlan(makeOptions(t(), props));

    expect(codeOf(() => run({ transform: 'none' }))).toBe('LM140');
    expect(codeOf(() => run({ x: [0] }))).toBe('LM141');
    expect(codeOf(() => run({ x: Number.NaN }))).toBe('LM142');
    expect(codeOf(() => run({ x: [0, Number.NaN] }))).toBe('LM142');
    expect(codeOf(() => run({ opacity: Number.POSITIVE_INFINITY }))).toBe('LM142');
    expect(codeOf(() => run({ backgroundColor: Number.NaN }))).toBe('LM142');
    expect(codeOf(() => run({ backgroundColor: {} }))).toBe('LM143');
    expect(codeOf(() => run({ '--gap': {} }))).toBe('LM143');
    expect(codeOf(() => run({ backgroundColor: 'not-a-value' }))).toBe('LM144');
    expect(codeOf(() => run({ '--gap': 'not-a-value' }))).toBe('LM144');

    const target = planTarget();
    expect(codeOf(() => buildCompositorPlan(
      makeOptions(target, { x: 1 }, { _delayMs: -1 }),
    ))).toBe('LM139');
    expect(codeOf(() => buildCompositorPlan(
      makeOptions(target, { x: 1 }, { _targetDelays: [Number.NaN] }),
    ))).toBe('LM139');
  });

  it('валидные грамматики value-движка планировщик принимает без броска', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(target, {
      width: '120px',
      '--gap': 'var(--other, 4px)',
      backgroundColor: '#a1b2c3',
      borderWidth: ['+=2px', '10px'],
    }));
    // 4 css-группы, все скомпилированы в юниты (linear-режим).
    expect(result._plans).toHaveLength(4);
    expect(result._live).toHaveLength(0);
  });

  it('LM150 — импульс у числовой границы непредставим и в новой модели', () => {
    const target = planTarget();
    const first = buildCompositorPlan(
      makeOptions(target, { x: [0, Number.MAX_VALUE] }),
    );
    publishRun(first._plans[0]!, { _value: 1, _velocity: 0.5 });

    expect(codeOf(() => buildCompositorPlan(
      makeOptions(target, { x: Number.MAX_VALUE }),
    ))).toBe('LM150');
  });
});

// ─── Группировка, residuals, кадры ───────────────────────────────────────────

describe('compositor-plan: группировка и кадры', () => {
  it('шортхенды сливаются в transform, css уходит в kebab-группы', () => {
    const target = planTarget({ 'background-color': 'rgb(1, 2, 3)' });
    const result = buildCompositorPlan(makeOptions(target, {
      x: 10,
      rotate: 90,
      opacity: 0.5,
      backgroundColor: '#fff',
    }));

    const groups = result._plans.map((p) => p._group).sort();
    expect(groups).toEqual(['background-color', 'opacity', 'transform']);
    const transform = result._plans.find((p) => p._group === 'transform')!;
    expect(transform._plan._keyframes[1]).toBe('translateX(10px) rotate(90deg)');
    const opacity = result._plans.find((p) => p._group === 'opacity')!;
    expect(opacity._plan._keyframes).toEqual([1, 0.5]); // from — дефолт браузера
    const css = result._plans.find((p) => p._group === 'background-color')!;
    // Холодный from — прочитанный стиль КАК ЕСТЬ, без цветового движка.
    expect(css._plan._keyframes).toEqual(['rgb(1, 2, 3)', '#fff']);
  });

  it('scale разворачивается в оси; uniform-запись остаётся компактной', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(target, { scale: [1, 2] }));
    expect(result._plans[0]!._plan._keyframes[1]).toBe('scale(2)');
  });

  it('residual-канал замораживается в ОБОИХ кадрах нового прогона', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { rotate: 45 }));
    const fake = publishRun(first._plans[0]!);
    first._plans[0]!._settle(fake.owner, true);

    const second = buildCompositorPlan(makeOptions(target, { x: 10 }));
    const [from, to] = second._plans[0]!._plan._keyframes;
    expect(String(from)).toContain('rotate(45deg)');
    expect(String(to)).toContain('rotate(45deg)');
    expect(String(to)).toContain('translateX(10px)');
  });

  it('симметрия transform-кадров: списки функций совпадают по построению', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { rotate: 45 }));
    const fake = publishRun(first._plans[0]!);
    first._plans[0]!._settle(fake.owner, true);

    // x стартует из identity (0): без нуджа from-кадр опустил бы translateX
    // и браузер провалился бы в matrix-интерполяцию.
    const second = buildCompositorPlan(makeOptions(target, { x: 10 }));
    const [from, to] = second._plans[0]!._plan._keyframes as [string, string];
    const sequence = (s: string): string => (s.match(/[a-zA-Z]+\(/g) ?? []).join('');
    expect(sequence(from)).toBe(sequence(to));
    expect(from).toContain('translateX(5e-324px)'); // визуально ровно 0
  });
});

// ─── C¹-подхват: sharedV0-канон числовых каналов ─────────────────────────────

describe('compositor-plan: C¹ подхват (канон sharedV0)', () => {
  it('снимок владельца деривирует from/velocity, ir компилируется с общим v0', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 100 }));
    publishRun(first._plans[0]!, { _value: 0.5, _velocity: 1.2 });

    const second = buildCompositorPlan(makeOptions(target, { x: 200 }));
    const entry = second._plans[0]!;
    // from = 0 + 100·0.5 = 50; velocity = 100·1.2 = 120/с; v0 = 120/(200−50).
    expect(entry._plan._keyframes[0]).toBe('translateX(50px)');
    const expected = springProgressCurve(SPRING, 120 / 150)!;
    expect(entry._plan._ir.points).toEqual(expected.points);
    expect(entry._plan._ir.durationMs).toBe(expected.durationMs);
  });

  it('явная пара [from, to] отключает подхват — рестарт из покоя (v0=0)', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 100 }));
    publishRun(first._plans[0]!, { _value: 0.5, _velocity: 1.2 });

    const second = buildCompositorPlan(makeOptions(target, { x: [10, 110] }));
    expect(second._plans[0]!._plan._keyframes[0]).toBe('translateX(10px)');
    expect(second._plans[0]!._plan._ir.points)
      .toEqual(springProgressCurve(SPRING, 0)!.points);
  });

  it('разошедшиеся v0 каналов одной группы → честный живой путь', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 100 }));
    publishRun(first._plans[0]!, { _value: 0.5, _velocity: 1.2 });

    // y холодный (v0=0), x несёт импульс → единой кривой группы нет.
    const second = buildCompositorPlan(makeOptions(target, { x: 200, y: 300 }));
    expect(second._plans).toHaveLength(0);
    expect(second._live).toHaveLength(1);
    expect(second._live[0]!._reason).toBe('v0-mismatch');
    // Живой путь получает подхваченные абсолютные величины.
    const x = second._live[0]!._numeric.find((c) => c._key === 'x')!;
    expect(x._from).toBe(50);
    expect(x._velocity).toBeCloseTo(120, 12);
  });

  it('непредставимая кривая (потолок сетки) → живой путь curve-budget', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(target, { x: 10 }, {
      _mode: { kind: 'spring', spring: { mass: 1, stiffness: 1e20, damping: 26 } },
    }));
    expect(result._plans).toHaveLength(0);
    expect(result._live[0]!._reason).toBe('curve-budget');
  });
});

// ─── CSS-шов C¹ ──────────────────────────────────────────────────────────────

describe('compositor-plan: css-шов formatCssAt', () => {
  function withCssRun(target: Target, formatCssAt?: CompositorPlanOptions['formatCssAt']) {
    const first = buildCompositorPlan(makeOptions(
      target,
      { backgroundColor: ['#000', '#fff'] },
      { _formatCssAt: formatCssAt },
    ));
    publishRun(first._plans[0]!, { _value: 0.5, _velocity: 0.9 });
    return buildCompositorPlan(makeOptions(
      target,
      { backgroundColor: '#0f0' },
      { _formatCssAt: formatCssAt },
    ));
  }

  it('шов даёт значение середины полёта: from = formatCssAt(from, to, p)', () => {
    const calls: [string | number, string | number, number][] = [];
    const seam = (
      from: string | number,
      to: string | number,
      p: number,
    ): string => {
      calls.push([from, to, p]);
      return 'rgb(128, 128, 128)';
    };
    const second = withCssRun(planTarget(), seam);
    expect(calls).toContainEqual(['#000', '#fff', 0.5]);
    expect(second._plans[0]!._plan._keyframes).toEqual(['rgb(128, 128, 128)', '#0f0']);
  });

  it('без шва — честный C⁰-рестарт с from = текущий to (директива)', () => {
    const second = withCssRun(planTarget(), undefined);
    expect(second._plans[0]!._plan._keyframes).toEqual(['#fff', '#0f0']);
  });
});

// ─── Ownership: duplicate, LM157, settle ─────────────────────────────────────

describe('compositor-plan: ownership', () => {
  it('duplicate target одного вызова прерывает юнит того же commit', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(target, { x: 10 }, {
      _targets: [target.el, target.el],
    }));
    expect(result._plans).toHaveLength(2);

    const firstOwner = publishRun(result._plans[0]!);
    expect(firstOwner.journal).toEqual([]);
    publishRun(result._plans[1]!);
    // Второй publish той же (el, group) прервал владельца первого.
    expect(firstOwner.journal).toEqual(['supersede']);
  });

  it('LM157 — реентри commit-резерва той же записи', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(target, { x: 10 }, {
      _targets: [target.el, target.el],
    }));
    result._plans[0]!._begin();
    expect(codeOf(() => result._plans[1]!._begin())).toBe('LM157');
    // Откат резерва возвращает запись в штатный цикл.
    result._plans[0]!._rollback();
    result._plans[1]!._begin();
    result._plans[1]!._publish(fakeOwner().owner);
  });

  it('бросок supersede прежнего владельца откатывает successor', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 10 }));
    const stubborn = fakeOwner();
    stubborn.owner._supersede = () => {
      throw new Error('previous refuses');
    };
    first._plans[0]!._begin();
    first._plans[0]!._publish(stubborn.owner);

    const second = buildCompositorPlan(makeOptions(target, { x: 20 }));
    const successor = fakeOwner();
    second._plans[0]!._begin();
    expect(() => second._plans[0]!._publish(successor.owner)).toThrow('previous refuses');
    expect(successor.journal).toEqual(['rollback']);
    // Прежний владелец жив, запись не в transition: повторная попытка штатна.
    const third = buildCompositorPlan(makeOptions(target, { x: 30 }));
    third._plans[0]!._begin();
  });

  it('settle(natural) пишет цели в реестр — следующий план стартует из них', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 10 }));
    const fake = publishRun(first._plans[0]!);
    first._plans[0]!._settle(fake.owner, true);

    const second = buildCompositorPlan(makeOptions(target, { x: 20 }));
    expect(second._plans[0]!._plan._keyframes[0]).toBe('translateX(10px)');
    expect(second._plans[0]!._plan._ir.points)
      .toEqual(springProgressCurve(SPRING, 0)!.points);
  });

  it('прерывание publish пишет терминальный снимок прерванного в реестр', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 100 }));
    publishRun(first._plans[0]!, { _value: 0.25, _velocity: 0 });

    // Дубликат прерывает: реестр обязан узнать позу 25 (снимок ДО supersede).
    const second = buildCompositorPlan(makeOptions(target, { x: [0, 1] }));
    publishRun(second._plans[0]!);
    const cold = fakeOwner();
    second._plans[0]!._settle(cold.owner, true); // не владелец — no-op
    const third = buildCompositorPlan(makeOptions(target, { rotate: 5 }));
    // residual x берётся из терминальной записи прерванного прогона: 25.
    expect(String(third._plans[0]!._plan._keyframes[1])).toContain('translateX(25px)');
  });
});

// ─── Фазовая дисциплина ──────────────────────────────────────────────────────

describe('compositor-plan: фазовая дисциплина', () => {
  it('buildCompositorPlan не делает записей и не прерывает владельцев', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 100 }));
    const fake = publishRun(first._plans[0]!, { _value: 0.5, _velocity: 1 });
    const writesBefore = target.writes.length;

    const reads = { props: 0 };
    const props = {
      get x(): number {
        reads.props++;
        return 200;
      },
    };
    buildCompositorPlan(makeOptions(target, props as Record<string, unknown>));

    expect(target.writes.length).toBe(writesBefore); // ноль записей в стиль
    expect(fake.journal).toEqual([]); // владелец не прерван фазой чтения
    expect(reads.props).toBe(1); // hostile getter прочитан один раз
  });
});

// ─── Reduced-motion ──────────────────────────────────────────────────────────

describe('compositor-plan: reduced-motion', () => {
  it('план со снап-семантикой: юниты не создаются, писатель финала отдельный', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(
      target,
      { x: 10, opacity: [0, 0.5] },
      { _reducedMotion: true },
    ));
    expect(result._plans).toHaveLength(0);
    expect(result._live).toHaveLength(0);
    expect(result._snaps).toHaveLength(2);
    expect(target.writes).toHaveLength(0); // план — только чтения

    for (const snap of result._snaps) snap._commit();
    expect(target.writes).toEqual([
      { prop: 'transform', value: 'translateX(10px)' },
      { prop: 'opacity', value: '0.5' },
    ]);
  });

  it('снап прерывает прежнего владельца, финал пишется его replacement', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 100 }));
    const fake = publishRun(first._plans[0]!, { _value: 0.5, _velocity: 0 });

    const reduced = buildCompositorPlan(makeOptions(
      target,
      { x: 200 },
      { _reducedMotion: true },
    ));
    reduced._snaps[0]!._commit();
    expect(fake.journal).toEqual(['supersede']);
    expect(target.writes).toEqual([{ prop: 'transform', value: 'translateX(200px)' }]);

    // Реестр закоммичен: следующий план стартует из снап-финала.
    const next = buildCompositorPlan(makeOptions(target, { x: 300 }));
    expect(next._plans[0]!._plan._keyframes[0]).toBe('translateX(200px)');
  });

  it('политика фасада: matchMedia-шов читается при отсутствии перекрытия', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(target, { x: 10 }, {
      _reducedMotion: undefined,
      _matchMedia: () => ({ matches: true }),
    }));
    expect(result._snaps).toHaveLength(1);
    expect(result._plans).toHaveLength(0);
  });
});

// ─── Маршрутизация ───────────────────────────────────────────────────────────

describe('compositor-plan: маршрутизация', () => {
  it('tween-режим: одна кривая easeProgressCurve на весь план, подхват C⁰', () => {
    const target = planTarget();
    const first = buildCompositorPlan(makeOptions(target, { x: 100 }));
    publishRun(first._plans[0]!, { _value: 0.5, _velocity: 1.2 });

    const second = buildCompositorPlan(makeOptions(target, { x: 200 }, {
      _mode: { kind: 'tween', durationMs: 240, ease: STANDARD_EASING },
    }));
    const entry = second._plans[0]!;
    expect(entry._plan._keyframes[0]).toBe('translateX(50px)'); // value-continuity
    const expected = easeProgressCurve(STANDARD_EASING, 240);
    expect(entry._plan._ir.points).toEqual(expected.points);
    expect(entry._plan._ir.durationMs).toBe(240);
  });

  it('explicit-режим: нечисловая пара → живой путь, числовая → юнит', () => {
    const target = planTarget();
    const result = buildCompositorPlan(makeOptions(
      target,
      { x: 10, opacity: [0, 1] },
      { _capability: { _linearSupported: false } },
    ));
    expect(result._plans).toHaveLength(1);
    expect(result._plans[0]!._group).toBe('opacity');
    expect(result._plans[0]!._plan._keyframes).toEqual([0, 1]);
    expect(result._live).toHaveLength(1);
    expect(result._live[0]!._group).toBe('transform');
    expect(result._live[0]!._reason).toBe('explicit-non-numeric');
  });

  it('цель без WAAPI → живой путь с подхваченными каналами', () => {
    const target = planTarget({}, false);
    const result = buildCompositorPlan(makeOptions(target, { x: 10 }));
    expect(result._plans).toHaveLength(0);
    expect(result._live[0]!._reason).toBe('no-waapi');
    expect(result._live[0]!._numeric).toEqual([
      { _key: 'x', _from: 0, _to: 10, _velocity: 0 },
    ]);
  });

  it('пер-целевые задержки и signal доносятся до планов юнитов', () => {
    const a = planTarget();
    const b = planTarget();
    const signal = {
      aborted: false,
      addEventListener(): void {},
      removeEventListener(): void {},
    };
    const result = buildCompositorPlan(makeOptions(a, { x: 10 }, {
      _targets: [a.el, b.el],
      _targetDelays: [100, 250],
      _signal: signal,
    }));
    expect(result._plans.map((p) => p._plan._delayMs)).toEqual([100, 250]);
    expect(result._plans[0]!._plan._signal).toBe(signal);
  });
});
