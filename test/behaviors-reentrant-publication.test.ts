import { describe, expect, it } from 'vitest';
import { createBottomSheet, createPullToRefresh } from '../src/behaviors/index.js';

describe('./behaviors — reentrant publication ownership', () => {
  it('nested publication cuts off stale outer fanout', () => {
    const sheet = createBottomSheet({ snapPoints: [0, 300] });
    let nested = false;
    const late: Array<{ phase: string; value: number; snapIndex: number }> = [];

    sheet.subscribe((state) => {
      if (state.phase === 'release' && !nested) {
        nested = true;
        sheet.update([0, 100]);
      }
    });
    sheet.subscribe((state) => {
      late.push({ phase: state.phase, value: state.value, snapIndex: state.snapIndex });
    });

    sheet.snapTo(1);

    expect(nested).toBe(true);
    expect(sheet.state).toMatchObject({ value: 100, snapIndex: 1, phase: 'settle' });
    expect(late).toEqual([
      { phase: 'release', value: 0, snapIndex: 1 },
      { phase: 'release', value: 100, snapIndex: 1 },
      { phase: 'settle', value: 100, snapIndex: 1 },
    ]);
  });

  it('reentrant cancel at release publication does not start pull settle or refresh', () => {
    let frames = 0;
    let refreshes = 0;
    const pull = createPullToRefresh({
      threshold: 10,
      resistance: 1,
      requestFrame: () => {
        frames++;
        return 1;
      },
      onRefresh: () => {
        refreshes++;
      },
    });

    pull.subscribe((state) => {
      if (state.phase === 'release') pull.cancel();
    });

    pull.pointerDown({ x: 0, y: 0, t: 0 });
    pull.pointerMove({ x: 0, y: 20, t: 0.05 });
    pull.pointerUp({ x: 0, y: 20, t: 0.1 });

    expect(frames).toBe(0);
    expect(refreshes).toBe(0);
    expect(pull.state).toMatchObject({
      value: 0,
      velocity: 0,
      phase: 'idle',
      pulling: false,
      armed: false,
      pending: false,
    });
  });

  it('reentrant cancel while disarming an armed pull does not restart release or refresh', () => {
    let frames = 0;
    let refreshes = 0;
    const pull = createPullToRefresh({
      threshold: 10,
      resistance: 1,
      requestFrame: () => {
        frames++;
        return 1;
      },
      onRefresh: () => {
        refreshes++;
      },
    });

    pull.subscribe((state) => {
      if (state.phase === 'follow' && state.armed && !state.pulling) pull.cancel();
    });

    pull.pointerDown({ x: 0, y: 0, t: 0 });
    pull.pointerMove({ x: 0, y: 20, t: 0.05 });
    pull.pointerUp({ x: 0, y: 20, t: 0.1 });

    expect(frames).toBe(0);
    expect(refreshes).toBe(0);
    expect(pull.state).toMatchObject({
      value: 0,
      velocity: 0,
      phase: 'idle',
      pulling: false,
      armed: false,
      pending: false,
    });
  });

  it('reentrant destroy while disarming an armed pull leaves destroyed state immutable', () => {
    let afterDestroy: object | undefined;
    const pull = createPullToRefresh({ threshold: 10, resistance: 1 });

    pull.subscribe((state) => {
      if (state.phase === 'follow' && state.armed && !state.pulling) {
        pull.destroy();
        afterDestroy = pull.state;
      }
    });

    pull.pointerDown({ x: 0, y: 0, t: 0 });
    pull.pointerMove({ x: 0, y: 20, t: 0.05 });
    pull.pointerUp({ x: 0, y: 20, t: 0.1 });

    expect(afterDestroy).toBeDefined();
    expect(pull.state).toBe(afterDestroy);
  });

  it('reentrant destroy at release publication does not start a pull runner', () => {
    let frames = 0;
    const pull = createPullToRefresh({
      threshold: 10,
      resistance: 1,
      requestFrame: () => {
        frames++;
        return 1;
      },
    });

    pull.subscribe((state) => {
      if (state.phase === 'release') pull.destroy();
    });

    pull.pointerDown({ x: 0, y: 0, t: 0 });
    pull.pointerMove({ x: 0, y: 20, t: 0.05 });
    pull.pointerUp({ x: 0, y: 20, t: 0.1 });

    expect(frames).toBe(0);
  });

  it('reentrant cancel at pending publication does not start external refresh', () => {
    let refreshes = 0;
    const pull = createPullToRefresh({
      threshold: 10,
      resistance: 1,
      onRefresh: () => {
        refreshes++;
      },
    });

    pull.subscribe((state) => {
      if (state.pending) pull.cancel();
    });

    pull.pointerDown({ x: 0, y: 0, t: 0 });
    pull.pointerMove({ x: 0, y: 20, t: 0.05 });
    pull.pointerUp({ x: 0, y: 20, t: 0.1 });

    expect(refreshes).toBe(0);
    expect(pull.state).toMatchObject({
      value: 0,
      velocity: 0,
      phase: 'idle',
      pulling: false,
      armed: false,
      pending: false,
    });
  });
});
