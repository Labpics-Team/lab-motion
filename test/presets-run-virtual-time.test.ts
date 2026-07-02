/**
 * test/presets-run-virtual-time.test.ts — runPreset(): управляемый frame-loop
 * (t3 ch01-motion-presets). Дисциплина keyframes(): ОДИН clock на все треки,
 * injectable requestFrame, thenable controls.
 *
 * TDD RED-proof: написан до runPreset — импорт падает. Далее: сломать
 * единый clock (пер-трековые лупы) → бит-идентичность мультитрека RED.
 *
 * Классы: А (unit-контролы), В (детерминизм virtual-time).
 */

import { describe, expect, it } from 'vitest';
import {
  runPreset,
  type PresetSpec,
  type PresetValues,
} from '../src/presets/index.js';

const spec2track: PresetSpec = {
  duration: 1,
  tracks: [
    { property: 'scale', values: [1, 2, 1] },
    { property: 'opacity', values: [1, 0, 1] },
  ],
};

/** Ручной прокач: requestFrame копит колбэки, тест дренирует с явными ts. */
function makePump() {
  const queue: Array<(ts?: number) => void> = [];
  const requestFrame = (cb: (ts?: number) => void): number => {
    queue.push(cb);
    return queue.length; // ненулевой handle → без timeout-fallback
  };
  const drain = (steps: number, dtMs: number, startMs = 0): void => {
    let ts = startMs;
    for (let i = 0; i < steps && queue.length > 0; i++) {
      ts += dtMs;
      const cb = queue.shift()!;
      cb(ts);
    }
  };
  return { queue, requestFrame, drain };
}

describe('presets — runPreset: virtual-time детерминизм', () => {
  it('В: два прогона с одинаковым clock → бит-идентичные последовательности', () => {
    const run = (): PresetValues[] => {
      const frames: PresetValues[] = [];
      const pump = makePump();
      runPreset(spec2track, {
        onUpdate: (v) => frames.push({ ...v }),
        requestFrame: pump.requestFrame,
      });
      pump.drain(200, 16);
      return frames;
    };
    const a = run();
    const b = run();
    expect(a.length).toBeGreaterThan(10);
    expect(a).toEqual(b);
  });

  it('А: мультитрек согласован — один момент t даёт значения ОБОИХ треков в одном onUpdate', () => {
    // Mutation proof: раздельные keyframes()-лупы на трек → в кадре только одно свойство → RED
    const pump = makePump();
    const frames: PresetValues[] = [];
    runPreset(spec2track, {
      onUpdate: (v) => frames.push({ ...v }),
      requestFrame: pump.requestFrame,
    });
    pump.drain(30, 16);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) {
      expect(typeof f.scale).toBe('number');
      expect(typeof f.opacity).toBe('number');
    }
  });

  it('А: естественное завершение → финальная поза, thenable резолвится', async () => {
    const pump = makePump();
    const frames: PresetValues[] = [];
    const controls = runPreset(spec2track, {
      onUpdate: (v) => frames.push({ ...v }),
      requestFrame: pump.requestFrame,
    });
    pump.drain(200, 16);
    await controls;
    const last = frames[frames.length - 1]!;
    expect(last.scale).toBeCloseTo(1, 12);
    expect(last.opacity).toBeCloseTo(1, 12);
    expect(controls.progress).toBe(1);
  });

  it('А: pause/play — пауза замораживает virtual-time, play продолжает', () => {
    const pump = makePump();
    const frames: PresetValues[] = [];
    const controls = runPreset(spec2track, {
      onUpdate: (v) => frames.push({ ...v }),
      requestFrame: pump.requestFrame,
    });
    pump.drain(5, 16);
    const atPause = controls.time;
    controls.pause();
    pump.drain(20, 16, 5 * 16);
    expect(controls.time).toBe(atPause);
    const framesAtPause = frames.length;
    controls.play();
    pump.drain(5, 16, 1000);
    expect(controls.time).toBeGreaterThan(atPause);
    expect(frames.length).toBeGreaterThan(framesAtPause);
  });

  it('А: seek(t) эмитирует позу в t; seek(NaN) — no-op; seek(∞) → complete', () => {
    const pump = makePump();
    const frames: PresetValues[] = [];
    const controls = runPreset(spec2track, {
      onUpdate: (v) => frames.push({ ...v }),
      requestFrame: pump.requestFrame,
    });
    controls.pause();
    controls.seek(0.5);
    const afterSeek = frames[frames.length - 1]!;
    expect(afterSeek.scale).toBeCloseTo(2, 12);
    expect(controls.time).toBeCloseTo(0.5, 12);

    const before = controls.time;
    controls.seek(Number.NaN);
    expect(controls.time).toBe(before);

    controls.seek(Infinity);
    expect(controls.progress).toBe(1);
  });

  it('А: cancel() останавливает в текущей позиции (time < totalDuration) и резолвит', async () => {
    const pump = makePump();
    const controls = runPreset(spec2track, { requestFrame: pump.requestFrame });
    pump.drain(3, 16);
    controls.cancel();
    await controls;
    // Семантика settled→progress=1 — домовая (keyframes); ранняя остановка
    // видна по виртуальному времени, не дошедшему до конца.
    expect(controls.time).toBeLessThan(controls.totalDuration);
    expect(controls.time).toBeGreaterThan(0);
  });

  it('А: ошибки в onUpdate изолируются — луп доживает до конца', async () => {
    const pump = makePump();
    let calls = 0;
    const controls = runPreset(spec2track, {
      onUpdate: () => {
        calls++;
        throw new Error('хостильный колбэк');
      },
      requestFrame: pump.requestFrame,
    });
    pump.drain(200, 16);
    await controls;
    expect(calls).toBeGreaterThan(10);
    expect(controls.progress).toBe(1);
  });

  it('А: totalDuration учитывает delay и repeat', () => {
    const pump = makePump();
    const controls = runPreset(
      { ...spec2track, delay: 0.5, repeat: 1 },
      { requestFrame: pump.requestFrame },
    );
    expect(controls.totalDuration).toBeCloseTo(2.5, 12);
  });
});
