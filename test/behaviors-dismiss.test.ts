/**
 * test/behaviors-dismiss.test.ts — drag-to-dismiss: порог по смещению/скорости,
 * направление, возврат с унаследованной скоростью, детерминизм pointer-cancel,
 * reduced-motion, cancel/destroy. Класс А/Б.
 *
 * MUTATION-мишени: #2 velocity на возврате, #6 порог dismiss.
 */

import { describe, expect, it } from 'vitest';
import { createDragDismiss } from '../src/behaviors/index.js';
import { makeClock, reduceMedia, pt } from './behaviors-helpers.js';

describe('./behaviors drag-to-dismiss — порог по смещению', () => {
  it('drag за порог 100 → dismiss в dismissTarget, dismissed=true, onDismiss', () => {
    const clock = makeClock();
    let dismissedCb = 0;
    const d = createDragDismiss({
      distanceThreshold: 100,
      requestFrame: clock.requestFrame,
      onDismiss: () => dismissedCb++,
    });
    d.pointerDown(pt(0, 0, 0));
    d.pointerMove(pt(0, 150, 0.2));
    d.pointerMove(pt(0, 150, 0.4));
    d.pointerUp(pt(0, 150, 0.5)); // за порогом, velocity ~0
    expect(d.state.phase).toBe('release');
    clock.drain(16);
    expect(d.state.dismissed).toBe(true);
    expect(dismissedCb).toBe(1);
    expect(d.state.phase).toBe('settle');
  });

  it('РОВНО на пороге (offset==100) → dismiss (мутант #6: >= не >)', () => {
    const clock = makeClock();
    const d = createDragDismiss({ distanceThreshold: 100, requestFrame: clock.requestFrame });
    d.pointerDown(pt(0, 0, 0));
    d.pointerMove(pt(0, 100, 0.2));
    d.pointerMove(pt(0, 100, 0.4));
    d.pointerUp(pt(0, 100, 0.5)); // velocity 0, offset ровно 100
    clock.drain(16);
    expect(d.state.dismissed).toBe(true);
  });
});

describe('./behaviors drag-to-dismiss — порог по скорости', () => {
  it('малое смещение, но быстрый флик → dismiss по velocity', () => {
    const clock = makeClock();
    const d = createDragDismiss({
      distanceThreshold: 100,
      velocityThreshold: 500,
      requestFrame: clock.requestFrame,
    });
    d.pointerDown(pt(0, 0, 0));
    d.pointerMove(pt(0, 30, 0.03));
    d.pointerUp(pt(0, 30, 0.03)); // v=30/0.03=1000 > 500
    clock.drain(16);
    expect(d.state.dismissed).toBe(true);
  });
});

describe('./behaviors drag-to-dismiss — возврат при недостигнутом пороге', () => {
  it('малый медленный drag → возврат к 0 (не dismissed)', () => {
    const clock = makeClock();
    const d = createDragDismiss({
      distanceThreshold: 100,
      velocityThreshold: 500,
      requestFrame: clock.requestFrame,
    });
    d.pointerDown(pt(0, 0, 0));
    d.pointerMove(pt(0, 40, 0.3));
    d.pointerMove(pt(0, 40, 0.6));
    d.pointerUp(pt(0, 40, 0.7));
    clock.drain(16);
    expect(d.state.dismissed).toBe(false);
    expect(d.state.value).toBeCloseTo(0, 3);
    expect(d.state.phase).toBe('settle');
  });

  it('возврат НАСЛЕДУЕТ скорость момента отпускания (мутант #2)', () => {
    const clock = makeClock();
    const seenVel: number[] = [];
    const d = createDragDismiss({
      distanceThreshold: 1000, // заведомо не dismiss → всегда возврат
      velocityThreshold: 100000,
      requestFrame: clock.requestFrame,
      onChange: (s) => {
        if (s.phase === 'release') seenVel.push(s.velocity);
      },
    });
    d.pointerDown(pt(0, 0, 0));
    d.pointerMove(pt(0, 80, 0.04));
    d.pointerUp(pt(0, 80, 0.04)); // быстрый, но не за порогом → возврат с v≠0
    clock.step(16);
    expect(Math.max(...seenVel.map(Math.abs))).toBeGreaterThan(50);
  });
});

describe('./behaviors drag-to-dismiss — направление', () => {
  it('direction=-1: отрицательное смещение закрывает, положительное — возврат', () => {
    const clockA = makeClock();
    const up = createDragDismiss({
      distanceThreshold: 100,
      direction: -1,
      requestFrame: clockA.requestFrame,
    });
    up.pointerDown(pt(0, 0, 0));
    up.pointerMove(pt(0, -150, 0.2));
    up.pointerMove(pt(0, -150, 0.4));
    up.pointerUp(pt(0, -150, 0.5));
    clockA.drain(16);
    expect(up.state.dismissed).toBe(true);

    const clockB = makeClock();
    const up2 = createDragDismiss({
      distanceThreshold: 100,
      direction: -1,
      requestFrame: clockB.requestFrame,
    });
    up2.pointerDown(pt(0, 0, 0));
    up2.pointerMove(pt(0, 150, 0.2)); // ПРОТИВ направления dismiss
    up2.pointerMove(pt(0, 150, 0.4));
    up2.pointerUp(pt(0, 150, 0.5));
    clockB.drain(16);
    expect(up2.state.dismissed).toBe(false);
  });
});

describe('./behaviors drag-to-dismiss — pointer-cancel детерминизм', () => {
  it('cancel даже за порогом → возврат домой, НЕ dismiss', () => {
    const clock = makeClock();
    const d = createDragDismiss({ distanceThreshold: 100, requestFrame: clock.requestFrame });
    d.pointerDown(pt(0, 0, 0));
    d.pointerMove(pt(0, 200, 0.1)); // за порогом
    d.pointerCancel();
    clock.drain(16);
    expect(d.state.dismissed).toBe(false);
    expect(d.state.value).toBeCloseTo(0, 3);
  });
});

describe('./behaviors drag-to-dismiss — reduced-motion', () => {
  it('dismiss снапает в target мгновенно (без кадров), результат сохранён', () => {
    const clock = makeClock();
    const d = createDragDismiss({
      distanceThreshold: 100,
      dismissTarget: 800,
      requestFrame: clock.requestFrame,
      matchMedia: reduceMedia(true) as unknown as (q: string) => MediaQueryList,
    });
    d.pointerDown(pt(0, 0, 0));
    d.pointerMove(pt(0, 150, 0.2));
    d.pointerUp(pt(0, 150, 0.3));
    expect(clock.rafCalls()).toBe(0);
    expect(d.state.dismissed).toBe(true);
    expect(d.state.value).toBeCloseTo(800, 3);
  });
});
