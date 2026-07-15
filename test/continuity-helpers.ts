/**
 * test/continuity-helpers.ts — общие фикстуры differential continuity сьюта
 * (#93, срез 6). НЕ тест-файл (vitest его не собирает как сьют).
 *
 * Здесь живут ТОЛЬКО кросс-парные хелперы матрицы: три канона часов пакета
 * (virtual-clock со stamps, pump-clock жестов, drain-clock FIXED_DT), оракул
 * восстановления унаследованной скорости (impliedPickupVelocity — аффинная
 * инверсия линейного по v0 солвера), matchMedia-стаб и duck-typed WAAPI-элемент.
 * Хелперы фасада ./animate РЕИСПОЛЬЗУЮТСЯ из animate-facade-helpers (реэкспорт),
 * не копируются.
 */

import { readCompositorSpring } from '../src/compositor/index.js';
import type { SpringParams } from '../src/spring.js';

// ─── Реэкспорт фикстур фасада (канон: не копипастить) ────────────────────────

export {
  allWritesFinite,
  fakeEl,
  lcg,
  makeClock,
  numericSeries,
  pickAnimate,
  pickLiveAnimate,
  translateXSeries,
  type StyleWrite,
} from './animate-facade-helpers.js';

// ─── Виртуальный клок со stamps (канон motion-value-velocity-read) ───────────

export interface VirtualClock {
  requestFrame(cb: (ts?: number) => void): number;
  /** Дренировать n кадров, продвигая ts на dtMs; каждый ts пишется в stamps. */
  drain(n?: number): void;
  drainAll(max?: number): void;
  readonly stamps: number[];
  queueLength(): number;
}

/**
 * Step-clock с журналом timestamps: handle ≠ 0 (rAF-путь, без setTimeout-шима),
 * оракулы воспроизводят elapsed бит-в-бит той же арифметикой, что тики ядра:
 * (ts − startTs) / 1000.
 */
export function makeVirtualClock(dtMs = 1000 / 60): VirtualClock {
  const queue: Array<(ts?: number) => void> = [];
  const stamps: number[] = [];
  let ts = 0;
  let handle = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    drain(n = 1): void {
      for (let i = 0; i < n; i++) {
        const cb = queue.shift();
        if (!cb) break;
        ts += dtMs;
        stamps.push(ts);
        cb(ts);
      }
    },
    drainAll(max = 3000): void {
      let i = 0;
      while (queue.length > 0 && i++ < max) this.drain(1);
    },
    stamps,
    queueLength: () => queue.length,
  };
}

// ─── Pump-clock жестов (канон gestures-*: ts в мс подаётся снаружи) ──────────

export interface PumpClock {
  requestFrame(cb: (ts?: number) => void): number;
  pump(ts: number): void;
  readonly queue: Array<(ts?: number) => void>;
}

export function pumpClock(): PumpClock {
  const queue: Array<(ts?: number) => void> = [];
  let handle = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    pump(ts: number): void {
      const cbs = queue.splice(0);
      for (const cb of cbs) cb(ts);
    },
    queue,
  };
}

// ─── Drain-clock (канон compositor-handoff: ts не передаётся → FIXED_DT_S) ───

export interface DrainClock {
  requestFrame(cb: (ts?: number) => void): number;
  step(frames: number): void;
  drain(cap?: number): number;
  queueLength(): number;
}

export function drainClock(): DrainClock {
  const queue: Array<(ts?: number) => void> = [];
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return queue.length; // ≠ 0 после push
    },
    step(frames: number): void {
      for (let i = 0; i < frames && queue.length > 0; i++) queue.shift()!();
    },
    drain(cap = 100_000): number {
      let n = 0;
      while (queue.length > 0 && n < cap) {
        queue.shift()!();
        n++;
      }
      return n;
    },
    queueLength: () => queue.length,
  };
}

// ─── matchMedia-стаб ─────────────────────────────────────────────────────────

/** matchMedia-стаб с фиксированным ответом (reduce=true по умолчанию). */
export function reduceMedia(matches = true): (q: string) => MediaQueryList {
  return () => ({ matches }) as unknown as MediaQueryList;
}

// ─── Duck-typed WAAPI-элемент (журнал .animate + spy-cancel) ─────────────────

export interface FakeWaapiEl {
  animations: { cancelled: boolean; cancel(): void }[];
  el: {
    animate(
      keyframes: Record<string, string | number>[],
      timing: Record<string, unknown>,
    ): { cancelled: boolean; cancel(): void };
  };
}

export function fakeWaapiEl(): FakeWaapiEl {
  const animations: FakeWaapiEl['animations'] = [];
  return {
    animations,
    el: {
      animate() {
        const anim = {
          cancelled: false,
          cancel(): void {
            this.cancelled = true;
          },
        };
        animations.push(anim);
        return anim;
      },
    },
  };
}

// ─── Оракул восстановления унаследованной скорости ───────────────────────────

/**
 * Восстанавливает v0 (units/s) нового spring-рана из значения его кадра при
 * elapsed=dtS. Солвер линеен по v0 (линейное ОДУ ⇒ value(t) аффинно по v0),
 * поэтому инверсия точна до машинной погрешности; только публичная поверхность.
 * Тот же оракул, что в animate-tween/css-velocity-pickup (вынесен сюда — дедуп).
 */
export function impliedPickupVelocity(
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
