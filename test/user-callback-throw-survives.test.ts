/**
 * user-callback-throw-survives.test.ts — бросок из ПОЛЬЗОВАТЕЛЬСКОГО колбэка не
 * убивает кадровый цикл и не подвешивает Promise.
 *
 * ЧТО БЫЛО СЛОМАНО (аудит 2026-07-25). `onStep` вызывается в теле кадра, и
 * бросок из него улетал ДО снятия single-flight флага и ДО перепланирования
 * следующего кадра. Итог одинаков во всех трёх циклах пакета:
 *   • drive.ts   — `tickActive` оставался взведён, `scheduleFrame` не вызывался;
 *   • driver.ts  — то же с `_tickActive`;
 *   • timeline   — `_tickActive` сбрасывался (finally там был), но
 *     перепланирование стояло СНАРУЖИ finally и пропускалось, а `_loopRunning`
 *     оставался true, поэтому `ensureLoop()` отказывался перезапуститься.
 * Прогон умирал НАВСЕГДА, возвращённый Promise не оседал НИКОГДА: `await
 * drive(...)` / `await timeline` висел вечно, и весь код после await — снятие
 * слушателей, восстановление стиля, освобождение ресурса — не выполнялся.
 * Ни `play()`, ни `pause()+play()`, ни `seek()` прогон не воскрешали.
 *
 * Триггер — не экзотика, а самый обычный сбой приложения: запись в узел,
 * удалённый из DOM, или setState после unmount. Пакет при этом ничего не
 * сообщал: в rAF-путях исключение из кадра проглатывается хостом, а `await`
 * просто молчал.
 *
 * ЗАКОН СЕЙЧАС. Снятие флага И перепланирование — в `finally`. Исключение
 * подписчика уходит хосту (это его баг, он обязан быть виден), но прогон
 * продолжается и доходит до естественного settle, поэтому Promise оседает.
 *
 * Mutation proof: вынести reschedule из finally обратно наружу в любом из трёх
 * файлов → RED на соответствующем блоке («цикл мёртв: очередь пуста»).
 */

import { describe, expect, it } from 'vitest';
import { drive } from '../src/drive.js';
import { createDriver } from '../src/driver.js';
import { createTimeline } from '../src/timeline/index.js';

/** Дренируемые часы: очередь кадров видна тесту. */
function stepClock(): {
  queue: Array<(ts?: number) => void>;
  requestFrame: (cb: (ts?: number) => void) => number;
  drain: (max?: number) => number;
} {
  const queue: Array<(ts?: number) => void> = [];
  return {
    queue,
    requestFrame: (cb) => queue.push(cb),
    drain(max = 4000) {
      let thrown = 0;
      for (let i = 0; i < max && queue.length > 0; i++) {
        try {
          queue.shift()!();
        } catch {
          thrown++; // хост «проглатывает» — ровно как rAF браузера
        }
      }
      return thrown;
    },
  };
}

const NO_REDUCE = (() => ({ matches: false })) as unknown as
  (query: string) => { matches: boolean };
const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;

/** onStep, который бросает ровно один раз на N-м вызове. */
function throwOnce(n: number): { step: (v: number) => void; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    step: () => {
      calls++;
      if (calls === n) throw new Error('узел удалён из DOM');
    },
  };
}

describe('кадровый цикл переживает бросок из onStep', () => {
  it('drive: прогон доходит до конца и Promise оседает', async () => {
    const clock = stepClock();
    const onStep = throwOnce(3);
    let settled = false;
    const promise = drive({
      from: 0, to: 100, spring: SPRING,
      onStep: onStep.step,
      requestFrame: clock.requestFrame,
      matchMedia: NO_REDUCE,
    }) as unknown as Promise<unknown>;
    void promise.then(() => { settled = true; });

    const thrown = clock.drain();
    expect(thrown, 'бросок обязан дойти до хоста, а не быть проглочен').toBe(1);
    // Прогон продолжился далеко за упавший кадр и естественно сошёлся.
    expect(onStep.calls()).toBeGreaterThan(10);
    expect(clock.queue.length, 'цикл мёртв: очередь пуста').toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled, 'Promise так и не осел — await висел бы вечно').toBe(true);
  });

  it('createDriver: то же для скраб-драйвера', async () => {
    const clock = stepClock();
    const onStep = throwOnce(3);
    let settled = false;
    const controls = createDriver({
      from: 0, to: 100, spring: SPRING,
      onStep: onStep.step,
      requestFrame: clock.requestFrame,
      matchMedia: NO_REDUCE,
    });
    void (controls as unknown as Promise<unknown>).then(() => { settled = true; });

    expect(clock.drain()).toBe(1);
    expect(onStep.calls()).toBeGreaterThan(10);
    expect(clock.queue.length, 'цикл мёртв: очередь пуста').toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled, 'Promise так и не осел').toBe(true);
  });

  it('createTimeline: то же, и прогон доходит до конца шкалы', async () => {
    const clock = stepClock();
    const onStep = throwOnce(3);
    let settled = false;
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 0.5, onStep: onStep.step }],
      requestFrame: clock.requestFrame,
      matchMedia: NO_REDUCE,
    });
    void (tl as unknown as Promise<unknown>).then(() => { settled = true; });

    expect(clock.drain()).toBe(1);
    expect(clock.queue.length, 'цикл мёртв: очередь пуста').toBe(0);
    // Виртуальное время дошло до конца, а не замерло на упавшем кадре.
    expect(tl.time).toBeCloseTo(tl.totalDuration, 6);
    expect(tl.progress).toBeCloseTo(1, 6);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled, 'Promise так и не осел — await timeline висел бы вечно').toBe(true);
  });

  it('колбэк, бросающий КАЖДЫЙ кадр, тоже завершает прогон (не вечный цикл)', () => {
    // Узел удалён навсегда: onStep будет падать до самого конца. Прогон обязан
    // дойти до settle по собственному критерию сходимости — он от onStep не
    // зависит, — а не крутиться бесконечно и не умирать на первом же броске.
    const clock = stepClock();
    let calls = 0;
    drive({
      from: 0, to: 100, spring: SPRING,
      onStep: () => { calls++; throw new Error('всегда'); },
      requestFrame: clock.requestFrame,
      matchMedia: NO_REDUCE,
    });
    const thrown = clock.drain();
    expect(thrown).toBe(calls);
    expect(calls).toBeGreaterThan(10);
    expect(clock.queue.length, 'цикл не остановился').toBe(0);
  });
});
