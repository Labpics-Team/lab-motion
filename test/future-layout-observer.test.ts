/**
 * test/future-layout-observer.test.ts — RED: observer clock.
 *
 * Спека: «OBSERVER CLOCK»; RED-Фаза п.10 (Observer планируется на каждую
 * строку), п.11 (Observer создаёт объект на кадр), п.12 (после main-thread
 * block callback replay-ит очередь старых samples).
 *
 * RED PROOF: src/future-layout/index.ts — заглушка `export {}`; каждый тест
 * падает СВОИМ ассертом через pick-хелпер (канон animate-facade-helpers).
 */

import { describe, expect, it } from 'vitest';
import * as surface from '../src/future-layout/index.js';
import {
  makeClock,
  makeSurfaceWorld,
  pickCreateSurfaceObserver,
  pickSurfacePlan,
  type SurfaceFrameViewLike,
} from './future-layout-helpers.js';

const mod = surface as unknown as Record<string, unknown>;
const createSurfaceObserver = pickCreateSurfaceObserver(mod);
const planSurface = pickSurfacePlan(mod);

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

describe('observer clock: один callback на доставленный main-thread frame', () => {
  it('RED п.10: observer планируется ОДИН раз на frame, не на строку', () => {
    const world = makeSurfaceWorld(10_000);
    const plan = planSurface(SPRING, 240, 360);
    const frames: SurfaceFrameViewLike[] = [];
    const observer = createSurfaceObserver(plan.artifact, (f) => frames.push({ ...f }));
    const clock = makeClock();

    observer.start(clock);
    clock.step(16);
    // Ровно один callback на один доставленный frame независимо от 10 000 строк:
    expect(frames.length).toBe(1);
    clock.step(16);
    expect(frames.length).toBe(2);
    observer.stop();
    expect(world.rows.length).toBeLessThanOrEqual(25); // materialized bounded
  });

  it('RED п.11: ноль frame-аллокаций — borrowed view переиспользуется', () => {
    const plan = planSurface(SPRING, 240, 360);
    const seen: SurfaceFrameViewLike[] = [];
    const observer = createSurfaceObserver(plan.artifact, (f) => seen.push(f));
    const clock = makeClock();

    observer.start(clock);
    clock.step(16);
    clock.step(16);
    clock.step(16);
    observer.stop();
    // Вариант B (borrowed view): один и тот же объект на каждый callback.
    expect(seen.length).toBe(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
  });

  it('RED п.12: после блокировки main thread очередь старых samples НЕ replay-ится', () => {
    const plan = planSurface(SPRING, 240, 360);
    const seen: SurfaceFrameViewLike[] = [];
    const observer = createSurfaceObserver(plan.artifact, (f) => seen.push({ ...f }));
    const clock = makeClock();

    observer.start(clock);
    clock.step(16);
    // Main thread заморожен ≥1000ms: время уходит вперёд без доставленных кадров.
    clock.step(1200);
    observer.stop();

    // Нет backlog: суммарно 2 доставленных callback, второй — текущее состояние.
    expect(seen.length).toBe(2);
    expect(seen[1].time).toBeGreaterThanOrEqual(1200);
    expect(seen[1].width).toBeGreaterThan(seen[0].width);
  });

  it('observer — единственный источник rAF: без него ноль запросов, с ним ровно один на кадр', () => {
    const plan = planSurface(SPRING, 240, 360);
    const clock = makeClock();
    // Plan сам по себе не планирует ни одного rAF (effects живут в CSS-слое).
    expect(plan.effectCount).toBe(5);
    expect(clock.rafCalls()).toBe(0);
    expect(clock.pending()).toBe(0);

    const seen: SurfaceFrameViewLike[] = [];
    const observer = createSurfaceObserver(plan.artifact, (f) => seen.push({ ...f }));
    observer.start(clock);
    // Старт observer'а — ровно один запрос кадра, без очереди.
    expect(clock.rafCalls()).toBe(1);
    expect(clock.pending()).toBe(1);

    clock.step(16);
    expect(seen.length).toBe(1);
    // Один доставленный кадр → ровно один следующий запрос (нет накопления).
    expect(clock.rafCalls()).toBe(2);
    expect(clock.pending()).toBe(1);

    observer.stop();
    clock.step(16);
    // Запрошенный кадр доставлен после stop как no-op: callback не вызывается,
    // новая очередь не создаётся.
    expect(seen.length).toBe(1);
    expect(clock.pending()).toBe(0);
    expect(clock.rafCalls()).toBe(2);
  });
});
