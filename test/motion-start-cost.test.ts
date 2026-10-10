import { describe, expect, it, vi } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

describe('подготовка движения', () => {
  it('читает исходный transform один раз на элемент и вызов', () => {
    const h = harness(true);
    const read = vi.spyOn(h.host, 'styles');
    const run = h.runtime.animate(h.element, { x: 100, y: 50 }, { duration: 200, ease: 'linear' });
    expect(read).toHaveBeenCalledTimes(1);
    run.finish();
    expect(h.updates.size + h.renders.size).toBe(0);
  });

  it('не смешивает начальные записи с созданием native effects', () => {
    const h = harness(true);
    const events: string[] = [];
    const elements = Array.from({ length: 12 }, () => {
      const item = harness(true).element;
      const write = item.style.setProperty.bind(item.style);
      const start = item.animate.bind(item);
      item.style.setProperty = (...args) => { events.push('write'); write(...args); };
      item.animate = (...args) => { events.push('native'); return start(...args); };
      return item;
    });
    const run = h.runtime.animate(elements, { x: [10, 100] }, { duration: 200, ease: 'linear' });
    expect(events).toEqual([...elements.map(() => 'write'), ...elements.map(() => 'native')]);
    run.stop();
  });

  it('не записывает неизменное начальное состояние неавторского перехода', () => {
    const h = harness(true);
    const run = h.runtime.animate(h.element, { x: 100 }, { duration: 200, ease: 'linear' });
    expect(h.writes).toEqual([]);
    expect(h.effects).toHaveLength(1);
    run.finish();
    expect(h.x()).toBe(100);
  });

  it('фиксирует native финал одной записью до разрешения finished', async () => {
    const h = harness(true);
    const run = h.runtime.animate(h.element, { x: 100 }, { duration: 200, ease: 'linear' });
    h.writes.length = 0;
    h.effects[0]!.complete();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(h.x()).toBe(100);
    expect(h.writes).toHaveLength(1);
    expect(h.effects[0]!.cancelled).toBe(true);
  });

  it('учитывает внешнюю запись после завершения прежнего движения', async () => {
    const h = harness();
    h.runtime.animate(h.element, { x: 100 }, { duration: 200 }).finish();
    h.element.style.setProperty('transform', 'translate(40px,0px)');
    const run = h.runtime.animate(h.element, { x: 200 }, { duration: 200, ease: 'linear' });
    run.seek(100);
    expect(h.x()).toBe(120);
    run.finish();
    expect(await run.finished).toEqual({ status: 'finished' });
  });
});
