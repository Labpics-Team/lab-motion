/**
 * test/behaviors-helpers.ts — общие фикстуры тестов субпутя ./behaviors.
 *
 * НЕ тест-файл (не сьют vitest): детерминированные шаг-часы, seeded-LCG и
 * reduceMedia переиспользуются из projection-helpers (единый источник фикстур
 * пакета — конвенция test/smart-helpers.ts). jsdom НЕ используется, node-env.
 *
 * RED-канон: типы публичной поверхности — ЛОКАЛЬНЫЕ копии; тесты обращаются к
 * модулю через namespace-import + pick-хелперы (на заглушке каждый тест падает
 * СВОИМ ассертом «… is not a function», а не link-ошибкой).
 */

export { lcg, makeClock, reduceMedia, type StepClock } from './projection-helpers.js';

// ─── Локальная копия контракта (RED-фаза) ────────────────────────────────────

export type BehaviorPhaseLike = 'idle' | 'follow' | 'release' | 'settle';

export interface BehaviorPointLike {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** Точка ввода. */
export function pt(x: number, y: number, t: number): BehaviorPointLike {
  return { x, y, t };
}

/**
 * Прогнать один жест по оси y: down в y0, серия move к y1 равномерно за `durS`
 * секунд, up в y1. Возвращает последнюю точку (для up вызывающий сам решает).
 * Скорость на отпускании ≈ (y1−y0)/durS (в пределах окна трекера 0.1s).
 */
export function flickY(
  ctrl: {
    pointerDown(p: BehaviorPointLike): void;
    pointerMove(p: BehaviorPointLike): void;
    pointerUp(p: BehaviorPointLike): void;
  },
  y0: number,
  y1: number,
  durS: number,
  steps = 5,
  x = 0,
): void {
  ctrl.pointerDown(pt(x, y0, 0));
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    ctrl.pointerMove(pt(x, y0 + (y1 - y0) * f, durS * f));
  }
  ctrl.pointerUp(pt(x, y1, durS));
}

/** То же по оси x. */
export function flickX(
  ctrl: {
    pointerDown(p: BehaviorPointLike): void;
    pointerMove(p: BehaviorPointLike): void;
    pointerUp(p: BehaviorPointLike): void;
  },
  x0: number,
  x1: number,
  durS: number,
  steps = 5,
  y = 0,
): void {
  ctrl.pointerDown(pt(x0, y, 0));
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    ctrl.pointerMove(pt(x0 + (x1 - x0) * f, y, durS * f));
  }
  ctrl.pointerUp(pt(x1, y, durS));
}

/** Все конечны? (для fuzz-гейта финитности). */
export function allFinite(...xs: number[]): boolean {
  return xs.every((x) => Number.isFinite(x) && !Object.is(x, -0));
}
