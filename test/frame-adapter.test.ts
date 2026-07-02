/**
 * test/frame-adapter.test.ts — asRequestFrame: ядро на общем кадровом цикле.
 *
 * Класс D11 («N живых значений = N rAF-колбэков на кадр») закрывается
 * ИНВЕРСИЕЙ зависимости: ядро не знает про ./frame — адаптер превращает
 * общий цикл в RequestFrameFn и входит через существующий шов инъекции.
 *
 * Классы тестов:
 *   В (differential): журналы onChange-эмиссий own-rAF vs shared-loop
 *     бит-в-бит (Object.is, включая -0/NaN-различимость) на одном и том же
 *     детерминированном step-клоке — физика не смещается ни на бит.
 *   А (behavior): D11-пин (один requestFrame на кадр при N живых значениях),
 *     сон/пробуждение цикла, churn (значение settled — цикл жив для соседей),
 *     re-entrancy (setTarget из чужого onChange).
 *
 * RED-proof: до реализации asRequestFrame файл падает на импорте (экспорта
 * нет). Mutation-цели: адаптер возвращает 0 вместо ненулевого handle →
 * «handle ненулевой» красный (ядро включило бы двойной setTimeout-путь);
 * подписка не {once:true} → D11-пин двойных вызовов красный.
 */

import { describe, expect, it } from 'vitest';
import { MotionValue, type RequestFrameFn } from '../src/index.js';
import { asRequestFrame, createFrameLoop } from '../src/frame/index.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;
const UNDERDAMPED = { mass: 1, stiffness: 200, damping: 8 } as const;
const DT_MS = 1000 / 60;

/** Детерминированный step-клок: копит колбэки, step() раздаёт единый ts. */
function makeStepClock() {
  let pending: Array<(ts?: number) => void> = [];
  let now = 0;
  const requestFrame: RequestFrameFn = (cb) => {
    pending.push(cb);
    return 1;
  };
  return {
    requestFrame,
    step(): void {
      now += DT_MS;
      const batch = pending;
      pending = [];
      for (const cb of batch) cb(now);
    },
    pendingCount: () => pending.length,
  };
}

/** Побитовое сравнение журналов (Object.is различает -0 и NaN). */
function expectJournalsBitIdentical(a: number[], b: number[], label: string): void {
  expect(b.length, `${label}: длина журналов`).toBe(a.length);
  for (let i = 0; i < a.length; i++) {
    expect(Object.is(a[i], b[i]), `${label}[${i}]: ${a[i]} vs ${b[i]}`).toBe(true);
  }
}

describe('./frame asRequestFrame — differential own-rAF vs shared-loop (Класс В)', () => {
  interface Scenario {
    readonly name: string;
    readonly spring: { mass: number; stiffness: number; damping: number };
    readonly frames: number;
    /** Кадр → новая цель (ретаргет в полёте со smooth-pickup). */
    readonly retargets?: Readonly<Record<number, number>>;
  }

  const scenarios: Scenario[] = [
    { name: 'critically-ish damped, простой полёт', spring: SPRING, frames: 120 },
    { name: 'underdamped, ретаргет в полёте (v0-pickup)', spring: UNDERDAMPED, frames: 160, retargets: { 12: -0.5, 40: 2 } },
    { name: 'overdamped, дальняя цель', spring: { mass: 2, stiffness: 80, damping: 60 }, frames: 200, retargets: { 90: 0 } },
  ];

  for (const sc of scenarios) {
    it(`журналы бит-в-бит: ${sc.name}`, () => {
      const run = (requestFrame: RequestFrameFn, step: () => void): number[] => {
        const journal: number[] = [];
        const mv = new MotionValue({ initial: 0, spring: sc.spring, requestFrame });
        mv.onChange((v) => journal.push(v));
        mv.setTarget(1);
        for (let f = 1; f <= sc.frames; f++) {
          const retarget = sc.retargets?.[f];
          if (retarget !== undefined) mv.setTarget(retarget);
          step();
        }
        mv.destroy();
        return journal;
      };

      const clockA = makeStepClock();
      const journalOwn = run(clockA.requestFrame, clockA.step);

      const clockB = makeStepClock();
      const loop = createFrameLoop({ requestFrame: clockB.requestFrame });
      const journalShared = run(asRequestFrame(loop), clockB.step);
      loop.cancelAll();

      expect(journalOwn.length).toBeGreaterThan(0);
      expectJournalsBitIdentical(journalOwn, journalShared, sc.name);
    });
  }

  it('журналы бит-в-бит: два значения interleaved на одном цикле', () => {
    const run = (
      makeRequestFrame: () => RequestFrameFn,
      step: () => void,
    ): [number[], number[]] => {
      const j1: number[] = [];
      const j2: number[] = [];
      const mv1 = new MotionValue({ initial: 0, spring: SPRING, requestFrame: makeRequestFrame() });
      const mv2 = new MotionValue({ initial: 5, spring: UNDERDAMPED, requestFrame: makeRequestFrame() });
      mv1.onChange((v) => j1.push(v));
      mv2.onChange((v) => j2.push(v));
      mv1.setTarget(1);
      mv2.setTarget(-3);
      for (let f = 1; f <= 150; f++) step();
      mv1.destroy();
      mv2.destroy();
      return [j1, j2];
    };

    const clockA = makeStepClock();
    const [ownJ1, ownJ2] = run(() => clockA.requestFrame, clockA.step);

    const clockB = makeStepClock();
    const loop = createFrameLoop({ requestFrame: clockB.requestFrame });
    const [sharedJ1, sharedJ2] = run(() => asRequestFrame(loop), clockB.step);
    loop.cancelAll();

    expectJournalsBitIdentical(ownJ1, sharedJ1, 'mv1');
    expectJournalsBitIdentical(ownJ2, sharedJ2, 'mv2');
  });
});

describe('./frame asRequestFrame — класс D11 и жизненный цикл', () => {
  it('N живых значений = ОДИН requestFrame на кадр (D11-пин)', () => {
    const clock = makeStepClock();
    const loop = createFrameLoop({ requestFrame: clock.requestFrame });
    const adapter = asRequestFrame(loop);

    const values = Array.from(
      { length: 5 },
      (_, i) => new MotionValue({ initial: i, spring: UNDERDAMPED, requestFrame: adapter }),
    );
    for (const mv of values) mv.setTarget(100);

    // Bootstrap: пять setTarget → у клока цикла ровно ОДНА заявка на кадр.
    expect(clock.pendingCount()).toBe(1);

    for (let f = 0; f < 20; f++) {
      clock.step();
      // Все 5 живы (далеко от цели) — заявка на следующий кадр снова одна.
      expect(clock.pendingCount(), `кадр ${f}`).toBe(1);
    }

    for (const mv of values) mv.destroy();
    loop.cancelAll();
  });

  it('handle адаптера ненулевой — двойной setTimeout-путь ядра не включается', () => {
    const loop = createFrameLoop({ requestFrame: () => 1 });
    const adapter = asRequestFrame(loop);
    const handle = adapter(() => {});
    expect(typeof handle).toBe('number');
    expect(handle).not.toBe(0);
    loop.cancelAll();
  });

  it('цикл засыпает, когда все значения settled, и просыпается на setTarget', () => {
    const clock = makeStepClock();
    const loop = createFrameLoop({ requestFrame: clock.requestFrame });
    const mv = new MotionValue({ initial: 0, spring: SPRING, requestFrame: asRequestFrame(loop) });

    mv.setTarget(1);
    let guard = 0;
    while (clock.pendingCount() > 0 && guard++ < 2000) clock.step();
    expect(guard).toBeLessThan(2000); // сошлось
    expect(clock.pendingCount()).toBe(0); // цикл спит: ни одной заявки

    mv.setTarget(0); // пробуждение
    expect(clock.pendingCount()).toBe(1);
    mv.destroy();
    loop.cancelAll();
  });

  it('churn: одно значение settled — цикл продолжает обслуживать соседа', () => {
    const clock = makeStepClock();
    const loop = createFrameLoop({ requestFrame: clock.requestFrame });
    const adapter = asRequestFrame(loop);

    const fast = new MotionValue({ initial: 0, spring: { mass: 1, stiffness: 500, damping: 50 }, requestFrame: adapter });
    const slow = new MotionValue({ initial: 0, spring: { mass: 3, stiffness: 40, damping: 8 }, requestFrame: adapter });
    const slowJournal: number[] = [];
    slow.onChange((v) => slowJournal.push(v));
    fast.setTarget(1);
    slow.setTarget(1);

    let guard = 0;
    while (clock.pendingCount() > 0 && guard++ < 5000) clock.step();
    expect(guard).toBeLessThan(5000);
    // Оба дошли: быстрый settled раньше, но цикл жил, пока жив медленный.
    expect(fast.value).toBe(1);
    expect(slow.value).toBe(1);
    expect(slowJournal.length).toBeGreaterThan(20);

    fast.destroy();
    slow.destroy();
    loop.cancelAll();
  });

  it('re-entrancy: setTarget соседа из onChange не срывает кадр и детерминирован', () => {
    const run = (makeRequestFrame: () => RequestFrameFn, step: () => void): number[] => {
      const journal: number[] = [];
      const a = new MotionValue({ initial: 0, spring: SPRING, requestFrame: makeRequestFrame() });
      const b = new MotionValue({ initial: 0, spring: UNDERDAMPED, requestFrame: makeRequestFrame() });
      let kicked = false;
      a.onChange((v) => {
        if (!kicked && v > 0.5) {
          kicked = true;
          b.setTarget(10); // ре-ентрантный запуск из чужого эмита
        }
      });
      b.onChange((v) => journal.push(v));
      a.setTarget(1);
      for (let f = 0; f < 200; f++) step();
      a.destroy();
      b.destroy();
      return journal;
    };

    const clockA = makeStepClock();
    const ownJournal = run(() => clockA.requestFrame, clockA.step);

    const clockB = makeStepClock();
    const loop = createFrameLoop({ requestFrame: clockB.requestFrame });
    const sharedJournal = run(() => asRequestFrame(loop), clockB.step);
    loop.cancelAll();

    expect(ownJournal.length).toBeGreaterThan(0);
    expectJournalsBitIdentical(ownJournal, sharedJournal, 're-entrancy');
  });
});
