/**
 * test/animate-facade-helpers.ts — общие фикстуры тестов субпутя ./animate.
 *
 * НЕ тест-файл (не собирается vitest'ом как сьют): duck-typed элементы,
 * детерминированные шаг-часы и seeded-PRNG — конвенции пакета
 * (см. test/compositor-fallback-matrix.test.ts, animate-overflow-finiteness-fuzz).
 */

// ─── Типы публичной поверхности (локальная копия для RED-фазы) ────────────────
// Тесты обращаются к модулю через namespace-import + каст: на пустой заглушке
// каждый тест падает СВОИМ ассертом (RED for the right reason), а не link-ошибкой.

export interface AnimateControlsLike {
  readonly finished: Promise<void>;
  play(): void;
  pause(): void;
  seek(tMs: number): void;
  cancel(): void;
  stop(): void;
}

export type AnimateFn = (
  target: unknown,
  props: Record<string, unknown>,
  options?: Record<string, unknown>,
) => AnimateControlsLike;

/** Достаёт animate из namespace-модуля (undefined на RED-заглушке). */
export function pickAnimate(mod: Record<string, unknown>): AnimateFn {
  return mod['animate'] as AnimateFn;
}

// ─── Duck-typed элемент ───────────────────────────────────────────────────────

/** Запись одной инлайн-записи стиля. */
export interface StyleWrite {
  readonly prop: string;
  readonly value: string;
}

export interface FakeElement {
  el: {
    style: {
      setProperty(name: string, value: string): void;
      getPropertyValue(name: string): string;
    };
    animate?: (
      keyframes: Record<string, string | number>[],
      timing: Record<string, unknown>,
    ) => { cancel: () => void };
  };
  /** Журнал всех setProperty-записей (в порядке вызова). */
  writes: StyleWrite[];
  /** Журнал вызовов .animate (compositor-путь). */
  animateCalls: { keyframes: Record<string, string | number>[]; timing: Record<string, unknown> }[];
  /** Число вызовов cancel() у выданных Animation. */
  cancels: number;
}

/**
 * Фейк-Element: style с журналом записей; withWaapi=true добавляет .animate
 * (duck-контракт supportsWaapi) со spy-cancel.
 */
export function fakeEl(
  initialStyle: Record<string, string> = {},
  withWaapi = false,
): FakeElement {
  const inline = new Map<string, string>(Object.entries(initialStyle));
  const writes: StyleWrite[] = [];
  const animateCalls: FakeElement['animateCalls'] = [];
  const fake: FakeElement = {
    writes,
    animateCalls,
    cancels: 0,
    el: {
      style: {
        setProperty(name: string, value: string): void {
          writes.push({ prop: name, value });
          inline.set(name, value);
        },
        getPropertyValue(name: string): string {
          return inline.get(name) ?? '';
        },
      },
    },
  };
  if (withWaapi) {
    fake.el.animate = (keyframes, timing) => {
      animateCalls.push({ keyframes, timing });
      return {
        cancel: () => {
          fake.cancels++;
        },
      };
    };
  }
  return fake;
}

// ─── Детерминированные шаг-часы (draining, handle ≠ 0) ───────────────────────

export interface StepClock {
  /** Инжектируемый requestFrame (handle ≠ 0 → без setTimeout-шима). */
  requestFrame(cb: (ts?: number) => void): number;
  /** Продвинуть время на dtMs и вызвать все накопленные колбэки с новым ts. */
  step(dtMs: number): void;
  /** step, пока очередь не опустеет (или maxSteps). Возвращает число шагов. */
  drain(dtMs?: number, maxSteps?: number): number;
  /** Текущий ts (мс). */
  readonly now: number;
}

export function makeClock(startTs = 0): StepClock {
  let ts = startTs;
  let queue: Array<(t?: number) => void> = [];
  let handle = 0;
  return {
    requestFrame(cb: (t?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    step(dtMs: number): void {
      ts += dtMs;
      const batch = queue;
      queue = [];
      for (const cb of batch) cb(ts);
    },
    drain(dtMs = 16, maxSteps = 5000): number {
      let steps = 0;
      while (queue.length > 0 && steps < maxSteps) {
        this.step(dtMs);
        steps++;
      }
      return steps;
    },
    get now(): number {
      return ts;
    },
  };
}

// ─── Управляемые часы для CompositorSpring (now-шов) ─────────────────────────

export interface ManualNow {
  now(): number;
  advance(ms: number): void;
}

export function makeNow(start = 0): ManualNow {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

// ─── Инжектируемый таймер (SetTimerFn-шов) ───────────────────────────────────

export interface ManualTimer {
  setTimer(cb: () => void, ms: number): () => void;
  /** Запланированные и ещё не отменённые таймеры. */
  pending(): { ms: number }[];
  /** Выполнить все таймеры с задержкой <= upToMs (в порядке планирования). */
  fire(upToMs?: number): void;
}

export function makeTimer(): ManualTimer {
  const timers: { cb: () => void; ms: number; cancelled: boolean; fired: boolean }[] = [];
  return {
    setTimer(cb: () => void, ms: number): () => void {
      const rec = { cb, ms, cancelled: false, fired: false };
      timers.push(rec);
      return () => {
        rec.cancelled = true;
      };
    },
    pending() {
      return timers.filter((t) => !t.cancelled && !t.fired).map((t) => ({ ms: t.ms }));
    },
    fire(upToMs = Infinity): void {
      for (const t of timers) {
        if (!t.cancelled && !t.fired && t.ms <= upToMs) {
          t.fired = true;
          t.cb();
        }
      }
    },
  };
}

// ─── Seeded PRNG (Park-Miller LCG — конвенция fuzz-тестов пакета) ────────────

export function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

// ─── Разбор записанных значений ──────────────────────────────────────────────

/** Читает конечный translateX без предположений о десятичной форме Number#toString. */
export function readTranslateX(value: string): number | undefined {
  const marker = 'translateX(';
  const start = value.indexOf(marker);
  if (start === -1) return undefined;
  if (value.indexOf(marker, start + marker.length) !== -1) return Number.NaN;
  const end = value.indexOf(')', start + marker.length);
  if (end === -1) return Number.NaN;
  const token = value.slice(start + marker.length, end);
  const match = /^([+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?)px$/.exec(token);
  if (match === null) return Number.NaN;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Достаёт из журнала все значения канала translateX (px) в порядке записи. */
export function translateXSeries(writes: readonly StyleWrite[]): number[] {
  const out: number[] = [];
  for (const w of writes) {
    if (w.prop !== 'transform') continue;
    if (w.value === 'none') {
      out.push(0);
      continue;
    }
    const value = readTranslateX(w.value);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** Все значения записей данного свойства как числа (для opacity и т.п.). */
export function numericSeries(writes: readonly StyleWrite[], prop: string): number[] {
  return writes.filter((w) => w.prop === prop).map((w) => Number(w.value));
}

/** true, если ни одна запись не содержит NaN/Infinity (текстово и численно). */
export function allWritesFinite(writes: readonly StyleWrite[]): boolean {
  for (const w of writes) {
    if (/NaN|Infinity/i.test(w.value)) return false;
    for (const m of w.value.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
      if (!Number.isFinite(Number(m[0]))) return false;
    }
  }
  return true;
}
