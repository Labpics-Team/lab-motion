import { describe, expect, it } from 'vitest';
import { keyframes } from '../src/keyframes/index.js';
import { runPreset } from '../src/presets/index.js';

type FrameCallback = (timestamp?: number) => void;

interface RunnerControls extends PromiseLike<void> {
  readonly time: number;
  play(): void;
  pause(): void;
  cancel(): void;
}

interface RunnerCase {
  readonly label: string;
  start(requestFrame: (callback: FrameCallback) => number, onWrite: () => void): RunnerControls;
}

const runners = [
  {
    label: 'keyframes',
    start: (requestFrame, onWrite) => keyframes({
      values: [0, 100],
      duration: 10,
      requestFrame,
      onStep: onWrite,
    }),
  },
  {
    label: 'runPreset',
    start: (requestFrame, onWrite) => runPreset({
      duration: 10,
      tracks: [{ property: 'x', values: [0, 100] }],
    }, {
      requestFrame,
      onUpdate: onWrite,
    }),
  },
] satisfies readonly RunnerCase[];

describe.each(runners)('$label — scheduler throw leaves one re-armable owner', ({ start }) => {
  it.each([
    { rearm: 'play', failureAt: 2 },
    { rearm: 'pause-play', failureAt: 3 },
  ] as const)(
    '$rearm after reservation $failureAt throws',
    async ({ rearm, failureAt }) => {
      const failure = new Error(`reservation ${failureAt} failed`);
      const reservations: Array<{ readonly callback: FrameCallback; readonly ordinal: number }> = [];
      let scheduleDepth = 0;
      let maxScheduleDepth = 0;
      let scheduleCalls = 0;
      let writes = 0;
      let controls!: RunnerControls;

      const requestFrame = (callback: FrameCallback): number => {
        scheduleDepth++;
        maxScheduleDepth = Math.max(maxScheduleDepth, scheduleDepth);
        try {
          const ordinal = ++scheduleCalls;
          reservations.push({ callback, ordinal });
          if (ordinal === failureAt) {
            // Реентрантный host видит занятую in-flight заявку: откат начинается
            // только после выхода host-вызова из транзакции.
            controls.play();
            controls.pause();
            controls.play();
            throw failure;
          }
          return ordinal;
        } finally {
          scheduleDepth--;
        }
      };

      controls = start(requestFrame, () => { writes++; });
      let settlements = 0;
      void controls.then(() => { settlements++; });

      let thrown: unknown;
      for (let ordinal = 1; ordinal < failureAt; ordinal++) {
        const fire = (): void => reservations[ordinal - 1]!.callback(ordinal * 16);
        if (ordinal === failureAt - 1) {
          try {
            fire();
          } catch (error) {
            thrown = error;
          }
        } else {
          expect(fire).not.toThrow();
        }
      }

      expect(thrown).toBe(failure);
      expect(scheduleCalls).toBe(failureAt);
      expect(maxScheduleDepth).toBe(1);
      expect(writes).toBe(failureAt - 1);

      const failedTime = controls.time;
      if (rearm === 'pause-play') controls.pause();
      controls.play();
      expect(scheduleCalls).toBe(failureAt + 1);

      // Повторный play не может установить конкурирующего писателя.
      controls.play();
      expect(scheduleCalls).toBe(failureAt + 1);

      // Все callback-и неудачного цикла устарели: даже терминальный timestamp
      // не завершает runner и не перезаписывает свежую заявку.
      for (const reservation of reservations.slice(0, failureAt)) {
        expect(() => reservation.callback(1_000_000)).not.toThrow();
      }
      await Promise.resolve();
      expect({ time: controls.time, writes, settlements, scheduleCalls }).toEqual({
        time: failedTime,
        writes: failureAt - 1,
        settlements: 0,
        scheduleCalls: failureAt + 1,
      });

      const fresh = reservations[failureAt]!;
      expect(fresh.ordinal).toBe(failureAt + 1);
      expect(() => fresh.callback(64)).not.toThrow();
      expect(controls.time).toBeGreaterThan(failedTime);
      expect(writes).toBe(failureAt);
      expect(scheduleCalls).toBe(failureAt + 2);

      const freshTime = controls.time;
      for (const reservation of reservations.slice(0, failureAt + 1)) {
        expect(() => reservation.callback(2_000_000)).not.toThrow();
      }
      expect({ time: controls.time, writes, settlements, scheduleCalls }).toEqual({
        time: freshTime,
        writes: failureAt,
        settlements: 0,
        scheduleCalls: failureAt + 2,
      });

      controls.cancel();
      await controls;
      expect(settlements).toBe(1);
    },
  );

  it('a reservation thrown from play is itself re-armable', async () => {
    const tailFailure = new Error('tail reservation failed');
    const playFailure = new Error('play reservation failed');
    const reservations: FrameCallback[] = [];
    let scheduleCalls = 0;
    let writes = 0;

    const controls = start((callback) => {
      const ordinal = ++scheduleCalls;
      reservations.push(callback);
      if (ordinal === 2) throw tailFailure;
      if (ordinal === 3) throw playFailure;
      return ordinal;
    }, () => { writes++; });

    let thrown: unknown;
    try {
      reservations[0]!(16);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(tailFailure);
    expect(scheduleCalls).toBe(2);

    thrown = undefined;
    try {
      controls.play();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(playFailure);
    expect(scheduleCalls).toBe(3);

    controls.play();
    controls.play();
    expect(scheduleCalls).toBe(4);

    const recoveredTime = controls.time;
    const recoveredWrites = writes;
    reservations[1]!(1_000_000);
    reservations[2]!(1_000_000);
    expect({ time: controls.time, writes, scheduleCalls }).toEqual({
      time: recoveredTime,
      writes: recoveredWrites,
      scheduleCalls: 4,
    });

    reservations[3]!(32);
    expect(controls.time).toBeGreaterThan(recoveredTime);
    expect(writes).toBe(recoveredWrites + 1);
    expect(scheduleCalls).toBe(5);

    controls.cancel();
    await controls;
  });
});
