/**
 * test/animate-compositor-unit.test.ts — исполнительный WAAPI-юнит поверх
 * ProgressCurveIR (срез R2 rebuild): lazy-commit, hostile host, ownership.
 *
 * ── RED PROOF (авторские мутации, каждая роняет конкретный блок) ─────────────
 * - Стартовать в конструкторе (убрать microtask-батч) → «ноль DOM до коммита»
 *   и «N юнитов = 1 microtask» RED.
 * - Читать anim.currentTime в снимке → «read-once hostile-поля» RED
 *   (getter-счётчик обязан остаться нулевым).
 * - Снять транзакционный замок → «реентрантный cancel из animate» RED.
 * - Пропустить снятие частичного эффекта при броске setTimer → «транзакционный
 *   старт» RED (host cancel обязан быть вызван).
 * - Отдать offsets кадров не из IR-пар → «explicit keyframes» RED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCompositorUnitBatch,
  createCompositorUnit,
  type CompositorUnitPlan,
  type CompositorUnitTarget,
} from '../src/animate/compositor-unit.js';
import { toLinear, type ProgressCurveIR } from '../src/animate/linear-compile.js';
import { type SetTimerFn } from '../src/compositor/core.js';
import { MotionParamError } from '../src/errors.js';

// ─── Детерминированная обвязка: часы, таймеры, microtask-очередь ─────────────

interface TimerEntry {
  readonly cb: () => void;
  readonly ms: number;
  alive: boolean;
}

function makeTimer(): { entries: TimerEntry[]; setTimer: SetTimerFn; fire: (i?: number) => void } {
  const entries: TimerEntry[] = [];
  return {
    entries,
    setTimer: (cb, ms) => {
      const entry: TimerEntry = { cb, ms, alive: true };
      entries.push(entry);
      return () => {
        entry.alive = false;
      };
    },
    fire(index = entries.length - 1): void {
      const entry = entries[index]!;
      if (!entry.alive) return;
      entry.alive = false;
      entry.cb();
    },
  };
}

function makeClock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (next) => { t = next; } };
}

interface HostAnimOptions {
  readonly pause?: boolean;
  readonly play?: boolean;
  readonly commitStyles?: boolean;
}

interface HostAnim {
  readonly anim: Record<string, unknown>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly pause: ReturnType<typeof vi.fn>;
  readonly play: ReturnType<typeof vi.fn>;
  readonly commitStyles: ReturnType<typeof vi.fn>;
  readonly currentTimeGets: () => number;
  readonly currentTimeSets: () => number[];
}

/** Host Animation с hostile-инструментами: read-once счётчики currentTime. */
function makeHostAnim(options: HostAnimOptions = {}): HostAnim {
  const cancel = vi.fn();
  const pause = vi.fn();
  const play = vi.fn();
  const commitStyles = vi.fn();
  let gets = 0;
  const sets: number[] = [];
  const anim: Record<string, unknown> = { cancel };
  if (options.pause !== false) anim['pause'] = pause;
  if (options.play !== false) anim['play'] = play;
  if (options.commitStyles !== false) anim['commitStyles'] = commitStyles;
  Object.defineProperty(anim, 'currentTime', {
    configurable: true,
    get() {
      gets++;
      return 0;
    },
    set(value: number) {
      sets.push(value);
    },
  });
  Object.defineProperty(anim, 'finished', {
    configurable: true,
    get(): never {
      throw new Error('finished getter must never be read');
    },
  });
  return {
    anim,
    cancel,
    pause,
    play,
    commitStyles,
    currentTimeGets: () => gets,
    currentTimeSets: () => sets,
  };
}

interface FakeTarget {
  readonly el: CompositorUnitTarget;
  readonly writes: { prop: string; value: string }[];
  readonly calls: {
    keyframes: Record<string, string | number>[];
    timing: Record<string, unknown>;
    host: HostAnim;
  }[];
}

function fakeTarget(
  animImpl?: (
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ) => unknown,
  animOptions?: HostAnimOptions,
): FakeTarget {
  const writes: FakeTarget['writes'] = [];
  const calls: FakeTarget['calls'] = [];
  const el: CompositorUnitTarget = {
    style: {
      setProperty(prop: string, value: string): void {
        writes.push({ prop, value });
      },
    },
    animate(keyframes, timing): unknown {
      if (animImpl) return animImpl(keyframes, timing);
      const host = makeHostAnim(animOptions);
      calls.push({ keyframes, timing, host });
      return host.anim;
    },
  };
  return { el, writes, calls };
}

/** Рукотворный IR: сегменты 0→0.8 (u≤0.5, наклон 1.6) и 0.8→1 (наклон 0.4). */
const IR: ProgressCurveIR = { durationMs: 1000, points: [0, 0, 0.5, 0.8, 1, 1] };

interface Fixture {
  readonly target: FakeTarget;
  readonly clock: ReturnType<typeof makeClock>;
  readonly timer: ReturnType<typeof makeTimer>;
  readonly plan: CompositorUnitPlan;
}

function makeFixture(overrides: Partial<CompositorUnitPlan> = {}, animOptions?: HostAnimOptions): Fixture {
  const target = fakeTarget(undefined, animOptions);
  const clock = makeClock();
  const timer = makeTimer();
  const plan: CompositorUnitPlan = {
    el: target.el,
    group: 'opacity',
    keyframes: [0, 100],
    ir: IR,
    delayMs: 0,
    seams: { now: clock.now, setTimer: timer.setTimer },
    capability: { linearSupported: true },
    ...overrides,
  };
  return { target, clock, timer, plan };
}

let tasks: Array<() => void> = [];
const flushBatch = (): void => {
  while (tasks.length) tasks.shift()!();
};

beforeEach(() => {
  __resetCompositorUnitBatch();
  tasks = [];
  vi.stubGlobal('queueMicrotask', (cb: () => void) => {
    tasks.push(cb);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCompositorUnitBatch();
});

// ─── Lazy-commit и microtask-батч ────────────────────────────────────────────

describe('compositor-unit: lazy-commit', () => {
  it('конструктор не трогает DOM; N юнитов коммитятся одним microtask', () => {
    const fixtures = [makeFixture(), makeFixture(), makeFixture()];
    for (const f of fixtures) expect(createCompositorUnit(f.plan)).toBeDefined();

    expect(tasks).toHaveLength(1);
    for (const f of fixtures) {
      expect(f.target.calls).toHaveLength(0);
      expect(f.target.writes).toHaveLength(0);
    }
    flushBatch();
    for (const f of fixtures) expect(f.target.calls).toHaveLength(1);
  });

  it('cancel до коммита = ноль DOM-вызовов, finished резолвится', async () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    unit.cancel();
    flushBatch();

    expect(f.target.calls).toHaveLength(0);
    expect(f.target.writes).toHaveLength(0);
    expect(f.timer.entries).toHaveLength(0);
    await expect(unit.finished).resolves.toBeUndefined();
  });

  it('юнит, созданный во время коммита, уходит в следующий microtask (epoch)', () => {
    const late = makeFixture();
    const early = makeFixture();
    let created = false;
    const spawning = fakeTarget((keyframes, timing) => {
      if (!created) {
        created = true;
        createCompositorUnit(late.plan);
      }
      const host = makeHostAnim();
      spawning.calls.push({ keyframes, timing, host });
      return host.anim;
    });
    createCompositorUnit({ ...early.plan, el: spawning.el });

    expect(tasks).toHaveLength(1);
    tasks.shift()!();
    // Новый юнит не влился в уже идущий flush — у него собственная очередь.
    expect(tasks).toHaveLength(1);
    expect(late.target.calls).toHaveLength(0);
    flushBatch();
    expect(late.target.calls).toHaveLength(1);
  });

  it('виртуальная пауза до коммита: flush не стартует host, play стартует', () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    unit.pause();
    flushBatch();
    expect(f.target.calls).toHaveLength(0);

    unit.play();
    expect(f.target.calls).toHaveLength(1);
    expect(f.target.writes).toHaveLength(0);
  });

  it('виртуальный seek до коммита смещает delay эмиссии без DOM-вызовов', () => {
    const f = makeFixture({ delayMs: 100 });
    const unit = createCompositorUnit(f.plan)!;
    unit.seek(400);
    expect(f.target.calls).toHaveLength(0);
    expect(f.target.writes).toHaveLength(0);

    flushBatch();
    expect(f.target.calls[0]!.timing['delay']).toBe(100 - 400);
  });
});

// ─── Режимы исполнения ───────────────────────────────────────────────────────

describe('compositor-unit: режимы исполнения', () => {
  it('linear(): два кадра + easing из toLinear(ir.points), делэй при > 0', () => {
    const f = makeFixture({
      group: 'transform',
      keyframes: ['translateX(0px)', 'translateX(100px)'],
      delayMs: 250,
    });
    createCompositorUnit(f.plan);
    flushBatch();

    const call = f.target.calls[0]!;
    expect(call.keyframes).toEqual([
      { transform: 'translateX(0px)' },
      { transform: 'translateX(100px)' },
    ]);
    expect(call.timing).toMatchObject({
      duration: 1000,
      easing: toLinear(IR.points),
      delay: 250,
      fill: 'both',
      iterations: 1,
      composite: 'replace',
    });
  });

  it('linear(): нулевой delay не эмитится в timing', () => {
    const f = makeFixture();
    createCompositorUnit(f.plan);
    flushBatch();
    expect('delay' in f.target.calls[0]!.timing).toBe(false);
  });

  it('explicit keyframes: offsets кадров = ir-пары, значения — лерп from/to', () => {
    const f = makeFixture({
      capability: { linearSupported: false },
      keyframes: [10, 20],
    });
    createCompositorUnit(f.plan);
    flushBatch();

    const call = f.target.calls[0]!;
    expect(call.keyframes).toEqual([
      { opacity: 10, offset: 0 },
      { opacity: 10 + 10 * 0.8, offset: 0.5 },
      { opacity: 20, offset: 1 },
    ]);
    // Прогресс уже разложен в кадры — easing-строка не эмитится вовсе.
    expect('easing' in call.timing).toBe(false);
  });

  it('explicit + нечисловая пара → честный undefined-отказ без DOM и батча', () => {
    const f = makeFixture({
      capability: { linearSupported: false },
      keyframes: ['red', 'blue'],
      group: 'color',
    });
    expect(createCompositorUnit(f.plan)).toBeUndefined();
    expect(tasks).toHaveLength(0);
    expect(f.target.calls).toHaveLength(0);
    expect(f.target.writes).toHaveLength(0);
  });
});

// ─── Hostile host ────────────────────────────────────────────────────────────

describe('compositor-unit: hostile host', () => {
  it('бросающий animate: без частичных эффектов, finished реджектится причиной', async () => {
    const boom = new Error('host animate boom');
    const target = fakeTarget(() => {
      throw boom;
    });
    const f = makeFixture({ el: target.el });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    expect(target.writes).toHaveLength(0);
    await expect(unit.finished).rejects.toThrow('host animate boom');
    // Терминализированный юнит остаётся безопасным для повторных контролов.
    unit.cancel();
    unit.play();
    expect(target.writes).toHaveLength(0);
  });

  it('animate вернул объект без cancel → LM155, партиал не остаётся', async () => {
    const target = fakeTarget(() => ({}));
    const f = makeFixture({ el: target.el });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    await expect(unit.finished).rejects.toMatchObject({ code: 'LM155' });
    expect(target.writes).toHaveLength(0);
  });

  it('бросок setTimer после старта снимает уже созданный host-effect', async () => {
    const f = makeFixture();
    const throwingTimer: SetTimerFn = () => {
      throw new Error('timer unavailable');
    };
    const unit = createCompositorUnit({
      ...f.plan,
      seams: { now: f.clock.now, setTimer: throwingTimer },
    })!;
    flushBatch();

    expect(f.target.calls).toHaveLength(1);
    expect(f.target.calls[0]!.host.cancel).toHaveBeenCalledTimes(1);
    await expect(unit.finished).rejects.toThrow('timer unavailable');
  });

  it('read-once: снимок/контролы не читают currentTime и finished хоста', () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const host = f.target.calls[0]!.host;

    f.clock.set(250);
    unit._snapshot();
    unit.seek(400);
    unit.pause();
    unit.play();
    expect(host.currentTimeGets()).toBe(0);
    // Запись при seek легальна — сеттер не является чтением hostile-поля.
    expect(host.currentTimeSets()).toEqual([400]);
  });

  it('реентрантный cancel из animate гасится замком, юнит остаётся управляемым', async () => {
    let reentered = false;
    const target = fakeTarget((keyframes, timing) => {
      if (!reentered) {
        reentered = true;
        unit.cancel(); // hostile host дергает контрол прямо из старта
      }
      const host = makeHostAnim();
      target.calls.push({ keyframes, timing, host });
      return host.anim;
    });
    const f = makeFixture({ el: target.el });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    // Реентрантный вызов не оборвал транзакцию старта: юнит живой.
    expect(target.calls).toHaveLength(1);
    unit.cancel();
    expect(target.calls[0]!.host.cancel).toHaveBeenCalledTimes(1);
    await expect(unit.finished).resolves.toBeUndefined();
  });

  it('реентрантная смена владельца из старта → LM157 в finished', async () => {
    const target = fakeTarget(() => {
      unit._supersede();
      return makeHostAnim().anim;
    });
    const f = makeFixture({ el: target.el });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    await expect(unit.finished).rejects.toMatchObject({ code: 'LM157' });
  });
});

// ─── Контролы, снимок, завершение ────────────────────────────────────────────

describe('compositor-unit: контролы и аналитический снимок', () => {
  it('снимок — бинарный поиск+lerp по ir.points, скорость из соседних пар', () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    // До коммита время прогона не течёт: снимок — стартовая пара IR.
    expect(unit._snapshot()).toEqual({ value: 0, velocity: 0 });
    flushBatch();

    f.clock.set(250); // u=0.25, первый сегмент: 0→0.8 на половине оси
    expect(unit._snapshot().value).toBeCloseTo(0.4, 12);
    expect(unit._snapshot().velocity).toBeCloseTo(1.6, 12);

    f.clock.set(750); // u=0.75, второй сегмент: 0.8→1
    expect(unit._snapshot().value).toBeCloseTo(0.9, 12);
    expect(unit._snapshot().velocity).toBeCloseTo(0.4, 12);

    f.clock.set(5000); // за дедлайном — терминальная пара, скорость нулевая
    expect(unit._snapshot()).toEqual({ value: 1, velocity: 0 });
  });

  it('delay сдвигает активное окно снимка', () => {
    const f = makeFixture({ delayMs: 500 });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    f.clock.set(250); // ещё в delay-фазе
    expect(unit._snapshot()).toEqual({ value: 0, velocity: 0 });
    f.clock.set(750); // u=0.25
    expect(unit._snapshot().value).toBeCloseTo(0.4, 12);
  });

  it('pause замораживает позицию через host pause, play возобновляет', () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const host = f.target.calls[0]!.host;

    f.clock.set(250);
    unit.pause();
    expect(host.pause).toHaveBeenCalledTimes(1);
    expect(f.timer.entries[0]!.alive).toBe(false); // плечо завершения снято

    f.clock.set(900); // время идёт — позиция стоит
    expect(unit._snapshot().value).toBeCloseTo(0.4, 12);

    unit.play();
    expect(host.play).toHaveBeenCalledTimes(1);
    const rearmed = f.timer.entries.at(-1)!;
    expect(rearmed.alive).toBe(true);
    expect(rearmed.ms).toBe(750); // остаток дедлайна от замороженных 250 мс
    f.clock.set(900 + 200);
    expect(unit._snapshot().value).toBeCloseTo(0.4 + 1.6 * 0.2, 12);
  });

  it('host без pause: числовая группа держится аналитическим инлайн-hold', () => {
    const f = makeFixture({}, { pause: false, play: false });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const first = f.target.calls[0]!.host;

    f.clock.set(500);
    unit.pause();
    // Поза из IR (SSOT артефакта), затем effect снимается.
    expect(f.target.writes).toEqual([{ prop: 'opacity', value: '80' }]);
    expect(first.cancel).toHaveBeenCalledTimes(1);

    unit.play();
    // Возобновление — ре-эмиссия со смещением в середину активной фазы.
    expect(f.target.calls).toHaveLength(2);
    expect(f.target.calls[1]!.timing['delay']).toBe(-500);
  });

  it('host без pause: нечисловая пара фиксируется commitStyles хоста', () => {
    const f = makeFixture(
      { group: 'color', keyframes: ['red', 'blue'] },
      { pause: false },
    );
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const host = f.target.calls[0]!.host;

    unit.pause();
    expect(host.commitStyles).toHaveBeenCalledTimes(1);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    expect(f.target.writes).toHaveLength(0);
  });

  it('seek живого прогона пишет currentTime и переармирует завершение', () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const host = f.target.calls[0]!.host;

    f.clock.set(100);
    unit.seek(800);
    expect(host.currentTimeSets()).toEqual([800]);
    const rearmed = f.timer.entries.at(-1)!;
    expect(rearmed.alive).toBe(true);
    expect(rearmed.ms).toBe(200);
    expect(unit._snapshot().value).toBeCloseTo(0.8 + 0.4 * (0.8 - 0.5), 12);
  });

  it('hostile сеттер currentTime → транзакционная ре-эмиссия с той позиции', () => {
    let anims = 0;
    const target = fakeTarget((keyframes, timing) => {
      const host = makeHostAnim();
      if (anims++ === 0) {
        Object.defineProperty(host.anim, 'currentTime', {
          configurable: true,
          set() {
            throw new Error('currentTime is read-only');
          },
        });
      }
      target.calls.push({ keyframes, timing, host });
      return host.anim;
    });
    const f = makeFixture({ el: target.el });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    unit.seek(600);
    expect(target.calls).toHaveLength(2);
    expect(target.calls[0]!.host.cancel).toHaveBeenCalledTimes(1);
    expect(target.calls[1]!.timing['delay']).toBe(-600);
    expect(unit._snapshot().value).toBeCloseTo(0.8 + 0.4 * (0.6 - 0.5), 12);
  });

  it('seek на числовой паузе двигает уже записанную инлайн-позу', () => {
    const f = makeFixture({}, { pause: false, play: false });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    f.clock.set(500);
    unit.pause();
    unit.seek(250);
    expect(f.target.writes).toEqual([
      { prop: 'opacity', value: '80' },
      { prop: 'opacity', value: '40' },
    ]);
    expect(unit._snapshot().value).toBeCloseTo(0.4, 12);
  });

  it('cancel живого прогона: инлайн-фиксация текущей позы до host cancel', async () => {
    const order: string[] = [];
    const target = fakeTarget((keyframes, timing) => {
      const host = makeHostAnim();
      host.cancel.mockImplementation(() => order.push('host-cancel'));
      target.calls.push({ keyframes, timing, host });
      return host.anim;
    });
    target.el.style.setProperty = (prop, value): void => {
      target.writes.push({ prop, value });
      order.push(`write:${prop}=${value}`);
    };
    const f = makeFixture({ el: target.el });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    f.clock.set(250);
    unit.cancel();
    expect(order).toEqual(['write:opacity=40', 'host-cancel']);
    await expect(unit.finished).resolves.toBeUndefined();
  });

  it('естественное завершение: финальная поза из плана, effect снимается', async () => {
    const f = makeFixture({ keyframes: [0, 100] });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const host = f.target.calls[0]!.host;

    expect(f.timer.entries[0]!.ms).toBe(1000);
    f.clock.set(1000);
    f.timer.fire(0);
    expect(f.target.writes).toEqual([{ prop: 'opacity', value: '100' }]);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    await expect(unit.finished).resolves.toBeUndefined();
  });

  it('дедлайн выше int32-клампа добирается повторными плечами таймера', () => {
    const huge: ProgressCurveIR = { durationMs: 2 ** 32, points: IR.points };
    const f = makeFixture({ ir: huge });
    createCompositorUnit(f.plan);
    flushBatch();

    expect(f.timer.entries[0]!.ms).toBe(2 ** 31 - 1);
    f.clock.set(2 ** 31);
    f.timer.fire(0);
    // Позиция ещё до дедлайна — то же плечо переармировано, не завершение.
    expect(f.target.writes).toHaveLength(0);
    expect(f.timer.entries).toHaveLength(2);
    expect(f.timer.entries[1]!.alive).toBe(true);
  });
});

// ─── Ownership-протокол ──────────────────────────────────────────────────────

describe('compositor-unit: ownership', () => {
  it('_supersede: hold числовой позы → replacement → снятие effect', async () => {
    const order: string[] = [];
    const target = fakeTarget((keyframes, timing) => {
      const host = makeHostAnim();
      host.cancel.mockImplementation(() => order.push('host-cancel'));
      target.calls.push({ keyframes, timing, host });
      return host.anim;
    });
    target.el.style.setProperty = (prop, value): void => {
      target.writes.push({ prop, value });
      order.push('hold');
    };
    const f = makeFixture({ el: target.el });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    f.clock.set(250);
    unit._supersede(() => order.push('replacement'));
    expect(order).toEqual(['hold', 'replacement', 'host-cancel']);
    await expect(unit.finished).resolves.toBeUndefined();
    // Терминализированный владелец больше не реагирует.
    unit._supersede(() => order.push('late'));
    expect(order).toHaveLength(3);
  });

  it('бросок replacement оставляет старого владельца живым и повторяемым', () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const host = f.target.calls[0]!.host;

    expect(() =>
      unit._supersede(() => {
        throw new Error('successor failed');
      })).toThrow('successor failed');
    expect(host.cancel).not.toHaveBeenCalled();
    expect(f.timer.entries[0]!.alive).toBe(true);

    // Повторная передача владения после отказа successor — штатная.
    unit._supersede();
    expect(host.cancel).toHaveBeenCalledTimes(1);
  });

  it('_rollback снимает effect без инлайн-записей', async () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();
    const host = f.target.calls[0]!.host;

    f.clock.set(400);
    unit._rollback();
    expect(f.target.writes).toHaveLength(0);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    await expect(unit.finished).resolves.toBeUndefined();
  });
});

// ─── dispose и AbortSignal ───────────────────────────────────────────────────

describe('compositor-unit: dispose и signal', () => {
  it('[Symbol.dispose] — это cancel (using-совместимость)', async () => {
    const f = makeFixture();
    const unit = createCompositorUnit(f.plan)!;
    const dispose = (unit as unknown as Record<symbol, () => void>)[Symbol.dispose]!;
    dispose.call(unit);
    flushBatch();

    expect(f.target.calls).toHaveLength(0);
    await expect(unit.finished).resolves.toBeUndefined();
  });

  it('abort до коммита = pre-commit cancel без DOM', async () => {
    const controller = new AbortController();
    const f = makeFixture({ signal: controller.signal });
    const unit = createCompositorUnit(f.plan)!;
    controller.abort();
    flushBatch();

    expect(f.target.calls).toHaveLength(0);
    await expect(unit.finished).resolves.toBeUndefined();
  });

  it('abort живого прогона = cancel-семантика с фиксацией позы', () => {
    const controller = new AbortController();
    const f = makeFixture({ signal: controller.signal });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    f.clock.set(250);
    controller.abort();
    expect(f.target.writes).toEqual([{ prop: 'opacity', value: '40' }]);
    expect(f.target.calls[0]!.host.cancel).toHaveBeenCalledTimes(1);
    void unit;
  });

  it('уже отменённый signal рождает завершённый юнит: ноль DOM и батча', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = makeFixture({ signal: controller.signal });
    const unit = createCompositorUnit(f.plan)!;

    expect(tasks).toHaveLength(0);
    expect(f.target.calls).toHaveLength(0);
    await expect(unit.finished).resolves.toBeUndefined();
    unit.play(); // контролы мертвы, но безопасны
    expect(f.target.calls).toHaveLength(0);
  });

  it('слушатель abort снимается при завершении (нет удержания юнита)', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const signal = { aborted: false, addEventListener, removeEventListener };
    const f = makeFixture({ signal });
    const unit = createCompositorUnit(f.plan)!;
    flushBatch();

    f.clock.set(1000);
    f.timer.fire(0);
    await expect(unit.finished).resolves.toBeUndefined();
    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      addEventListener.mock.calls[0]![1],
    );
  });
});

// ─── Валидация границы плана ─────────────────────────────────────────────────

describe('compositor-unit: LM-граница плана', () => {
  function expectCode(build: () => unknown, code: string): void {
    let caught: unknown;
    try {
      build();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MotionParamError);
    expect((caught as MotionParamError).code).toBe(code);
    expect(tasks).toHaveLength(0); // граница падает до записи в батч
  }

  it('каждое нарушение границы получает свой канонический код', () => {
    const base = makeFixture().plan;
    const broken = <K extends keyof CompositorUnitPlan>(
      key: K,
      value: unknown,
    ): CompositorUnitPlan =>
      ({ ...base, [key]: value }) as CompositorUnitPlan;

    expectCode(() => createCompositorUnit(broken('seams', {})), 'LM156');
    expectCode(
      () => createCompositorUnit(broken('el', { style: { setProperty() {} } })),
      'LM153',
    );
    expectCode(() => createCompositorUnit(broken('el', { animate() {} })), 'LM148');
    expectCode(() => createCompositorUnit(broken('group', '')), 'LM010');
    expectCode(() => createCompositorUnit(broken('keyframes', [0])), 'LM141');
    expectCode(() => createCompositorUnit(broken('keyframes', [Number.NaN, 1])), 'LM142');
    expectCode(() => createCompositorUnit(broken('keyframes', [{}, 1])), 'LM143');
    expectCode(() => createCompositorUnit(broken('delayMs', -1)), 'LM139');
    expectCode(() => createCompositorUnit(broken('delayMs', Number.NaN)), 'LM139');
    expectCode(
      () => createCompositorUnit(broken('ir', { durationMs: 0, points: IR.points })),
      'LM137',
    );
    expectCode(
      () => createCompositorUnit(broken('ir', { durationMs: 1000, points: [0, 0] })),
      'LM159',
    );
    expectCode(
      () =>
        createCompositorUnit(
          broken('ir', { durationMs: 1000, points: [0, 0, 0.5, 0.8, 1] }),
        ),
      'LM159',
    );
    expectCode(
      () =>
        createCompositorUnit(
          broken('ir', { durationMs: 1000, points: [0, 0, 0.5, Number.NaN, 1, 1] }),
        ),
      'LM159',
    );
    expectCode(() => createCompositorUnit(broken('signal', { aborted: false })), 'LM156');
  });

  it('hostile capability не считается доказанным linear()', () => {
    const f = makeFixture({
      capability: { linearSupported: 'yes' as unknown as boolean },
      keyframes: [0, 1],
    });
    createCompositorUnit(f.plan);
    flushBatch();
    // Мусорная capability маршрутизируется в безопасные явные кадры.
    expect(f.target.calls[0]!.keyframes.length).toBe(IR.points.length / 2);
  });
});

// ─── Детерминизм ─────────────────────────────────────────────────────────────

describe('compositor-unit: детерминизм', () => {
  it('одинаковые планы дают идентичные host-журналы (без глобальных часов)', () => {
    const run = (): { keyframes: unknown; timing: unknown; writes: unknown } => {
      const f = makeFixture({ delayMs: 50, keyframes: [0, 10] });
      const unit = createCompositorUnit(f.plan)!;
      flushBatch();
      f.clock.set(300);
      unit.seek(700);
      f.clock.set(1100);
      f.timer.fire(f.timer.entries.length - 1);
      return {
        keyframes: f.target.calls.map((c) => c.keyframes),
        timing: f.target.calls.map((c) => c.timing),
        writes: f.target.writes,
      };
    };
    expect(run()).toEqual(run());
  });
});
