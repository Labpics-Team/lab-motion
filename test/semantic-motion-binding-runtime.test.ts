import { describe, expect, it } from 'vitest';
import { animate, type AnimateControls } from '../src/animate/index.js';
import { createMotionBinding } from '../src/bindings/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

// Социабельная проверка настоящего исполнителя: тот же solver, registry и clocks,
// но записывающий порт вместо браузера. Browser conformance проверяется отдельно.
function point(target: ReturnType<typeof fakeEl>): number[] {
  const transform = target.el.style.getPropertyValue('transform');
  const match = transform.match(/^translate\(([^,]+)px, ([^)]+)px\)$/);
  expect(match, transform).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

describe('семантические роли и настоящий animate', () => {
  it('изменённая роль передаётся целиком: незавершённая соседняя ось не теряет цель', async () => {
    const managed = fakeEl(), direct = fakeEl(), partial = fakeEl();
    const clock = makeClock();
    const options = { duration: 100, ease: (t: number) => t, requestFrame: clock.requestFrame };
    let controls!: AnimateControls;
    const view = createMotionBinding((goal: { x: number; y: number }) => ({ panel: goal }), {
      panel: goal => (controls = animate(managed.el, goal, options)),
    });
    view.update({ x: 100, y: 200 });
    const first = controls;
    const directFirst = animate(direct.el, { x: 100, y: 200 }, options);
    const partialFirst = animate(partial.el, { x: 100, y: 200 }, options);
    for (const c of [first, directFirst, partialFirst]) { c.pause(); c.seek(50); }
    expect([point(managed), point(direct), point(partial)]).toEqual([[50, 100], [50, 100], [50, 100]]);

    view.update({ x: 300, y: 200 });
    const directNext = animate(direct.el, { x: 300, y: 200 }, options);
    // Правдоподобная неверная оптимизация: передать только изменившийся x.
    const partialNext = animate(partial.el, { x: 300 }, options);
    for (const c of [controls, directNext, partialNext]) { c.pause(); c.seek(100); }
    expect(point(managed)).toEqual([300, 200]);
    expect(point(managed)).toEqual(point(direct));
    expect(point(partial)).toEqual([300, 100]);
    await Promise.all([first.finished, directFirst.finished, partialFirst.finished]);
    view.destroy(); directNext.cancel(); partialNext.cancel();
    const writes = managed.writes.length;
    clock.drain();
    expect(managed.writes).toHaveLength(writes);
  });

  it('тысяча неизменных целей не создаёт новый исполнитель, кадр или отмену', () => {
    const target = fakeEl();
    const clock = makeClock();
    let starts = 0, requests = 0;
    let controls!: AnimateControls;
    const view = createMotionBinding((n: number) => ({ panel: { opacity: Math.min(1, n) } }), {
      panel: goal => {
        starts++;
        return controls = animate(target.el, goal, {
          duration: 100, ease: t => t,
          requestFrame: cb => { requests++; return clock.requestFrame(cb); },
        });
      },
    });
    view.update(1); const first = controls;
    const initialRequests = requests;
    expect(initialRequests).toBeGreaterThan(0);
    for (let n = 2; n <= 1001; n++) view.update(n);
    expect(starts).toBe(1); expect(controls).toBe(first); expect(requests).toBe(initialRequests);
    view.update(0.5); // Положительный контроль: другая визуальная цель достигает animator.
    expect(starts).toBe(2); expect(controls).not.toBe(first);
    controls.pause(); controls.seek(100);
    expect(target.el.style.getPropertyValue('opacity')).toBe('0.5');
    view.destroy(); const writes = target.writes.length;
    clock.drain(); expect(target.writes).toHaveLength(writes);
  });
});
