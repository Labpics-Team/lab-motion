/** Реентрантное lifecycle-действие владеет позицией, старый кадр — нет. */

import { expect, test } from './fixtures/harness';

type Scenario =
  | { kind: 'terminal-pause' }
  | { kind: 'terminal-seek'; seekMs: number }
  | { kind: 'ease-cancel' | 'ease-nested' | 'ease-retarget' };

async function exercise(scenario: Scenario) {
  const { animate } = await import('/dist/animate/index.js');
  type Controls = ReturnType<typeof animate>;
  const nativeRaf = window.requestAnimationFrame;
  const queue: FrameRequestCallback[] = [];
  const owned: Controls[] = [];
  const elements: HTMLElement[] = [];
  const completions = [0, 0];
  const positions: number[] = [];
  let errorName: string | null = null;
  let effects = -1;
  let pending = -1;
  let restored = false;
  let stableBefore: number[] = [];
  let stableAfter: number[] = [];
  let completionsBefore: number[] = [];
  let completionsAfter: number[] = [];

  const element = (): HTMLElement => {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;width:10px;height:10px';
    document.body.appendChild(el);
    elements.push(el);
    return el;
  };
  const x = (el: HTMLElement): number => {
    const transform = getComputedStyle(el).transform;
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
  };
  const step = (time: number): void => {
    for (const callback of queue.splice(0)) callback(time);
  };

  window.requestAnimationFrame = (callback) => {
    queue.push(callback);
    return queue.length;
  };
  try {
    if (scenario.kind === 'terminal-pause' || scenario.kind === 'terminal-seek') {
      const firstEl = element();
      const secondEl = element();
      let second!: Controls;
      const first = animate(firstEl, { x: [0, 100] }, {
        duration: 1000,
        ease: (t) => t,
        onComplete: () => {
          completions[0]++;
          if (scenario.kind === 'terminal-pause') second.pause();
          second.seek(scenario.kind === 'terminal-pause' ? 200 : scenario.seekMs);
        },
      });
      second = animate(secondEl, { x: [0, 100] }, {
        duration: 1000,
        ease: (t) => t,
        onComplete: () => { completions[1]++; },
      });
      owned.push(first, second);
      step(0);
      step(1000);
      positions.push(x(secondEl));
      if (scenario.kind === 'terminal-pause') second.play();
      step(1016);
      positions.push(x(secondEl));
      if (scenario.kind === 'terminal-pause') {
        step(1116);
        positions.push(x(secondEl));
      }
    } else {
      const el = element();
      let source!: Controls;
      let successor: Controls | undefined;
      let armed = false;
      source = animate(el, { x: [0, 100] }, {
        duration: 1000,
        ease: (t) => {
          if (armed) {
            armed = false;
            if (scenario.kind === 'ease-cancel') source.cancel();
            else if (scenario.kind === 'ease-nested') source.seek(700);
            else {
              successor = animate(el, { x: 200 }, {
                duration: 1000,
                ease: (value) => value,
                onComplete: () => { completions[1]++; },
              });
              owned.push(successor);
            }
          }
          return t;
        },
        onComplete: () => { completions[0]++; },
      });
      owned.push(source);
      source.pause();
      source.seek(100);
      positions.push(x(el));
      armed = true;
      try { source.seek(200); } catch (error) {
        errorName = error instanceof Error ? error.name : typeof error;
      }
      positions.push(x(el));
      if (scenario.kind === 'ease-retarget' && successor !== undefined) {
        successor.pause();
        successor.seek(500);
        positions.push(x(el));
      }
    }

    effects = elements.reduce((sum, el) => sum + el.getAnimations().length, 0);
    stableBefore = elements.map(x);
    completionsBefore = [...completions];
    for (let i = owned.length - 1; i >= 0; i--) owned[i]!.cancel();
    await Promise.all(owned.map((controls) => controls.finished));
    for (let i = 0; i < 4 && queue.length > 0; i++) step(2000 + i * 16);
    stableAfter = elements.map(x);
    completionsAfter = [...completions];
    pending = queue.length;
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) {
      try { owned[i]!.cancel(); } catch { /* страница всё равно очищается */ }
    }
    window.requestAnimationFrame = nativeRaf;
    restored = window.requestAnimationFrame === nativeRaf;
    for (const el of elements) el.remove();
  }
  return {
    positions, completions, errorName, effects, pending, restored,
    stableBefore, stableAfter, completionsBefore, completionsAfter,
  };
}

function expectClean(result: Awaited<ReturnType<typeof exercise>>): void {
  expect(result.errorName).toBeNull();
  expect(result.effects).toBe(0);
  expect(result.pending).toBe(0);
  expect(result.restored).toBe(true);
  expect(result.stableAfter).toEqual(result.stableBefore);
  expect(result.completionsAfter).toEqual(result.completionsBefore);
}

test('pause → seek из соседнего completion продолжает с последней позиции', async ({ page }) => {
  const result = await page.evaluate(exercise, { kind: 'terminal-pause' } satisfies Scenario);
  expect(result.positions).toEqual([20, 20, 30]);
  expect(result.completions).toEqual([1, 0]);
  expectClean(result);
});

for (const [seekMs, expected] of [[0, 0], [200, 20], [700, 70]] as const) {
  test(`seek(${seekMs}) между compute/render отменяет старый terminal`, async ({ page }) => {
    const result = await page.evaluate(
      exercise,
      { kind: 'terminal-seek', seekMs } satisfies Scenario,
    );
    expect(result.positions).toEqual([expected, expected]);
    expect(result.completions).toEqual([1, 0]);
    expectClean(result);
  });
}

for (const [kind, expected] of [['ease-cancel', 10], ['ease-nested', 70]] as const) {
  test(`${kind}: внешний seek не пишет после реентрантного действия`, async ({ page }) => {
    const result = await page.evaluate(exercise, { kind } satisfies Scenario);
    expect(result.positions).toEqual([10, expected]);
    expect(result.completions).toEqual([0, 0]);
    expectClean(result);
  });
}

test('replacement из ease получает lease и не затирается внешним seek', async ({ page }) => {
  const result = await page.evaluate(exercise, { kind: 'ease-retarget' } satisfies Scenario);
  expect(result.positions).toEqual([10, 10, 105]);
  expect(result.completions).toEqual([0, 0]);
  expectClean(result);
});
