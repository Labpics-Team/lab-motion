import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import { snapshot } from '../src/motion/model.js';

it('late native completion не меняет новый прогон или его finished', async () => {
  const h = harness(true);
  const first = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
  h.effects[0]!.currentTime = 400;
  const second = h.runtime.animate(h.element, { x: 200 }, { duration: 1000, ease: 'linear' });
  expect(await first.finished).toEqual({ status: 'stopped' });
  const writes = h.writes.length;
  h.effects[0]!.complete(); await Promise.resolve(); await Promise.resolve();
  expect(h.writes).toHaveLength(writes); expect(second.state).toBe('running'); expect(h.x()).toBe(40);
  second.finish(); expect(await second.finished).toEqual({ status: 'finished' });
});

it('полный оборот не теряется между завершёнными прогонами', () => {
  const h = harness(true);
  h.runtime.animate(h.element, { rotate: 720 }, { duration: 1 }).finish();
  const next = h.runtime.animate(h.element, { rotate: 1080 }, { duration: 1000, ease: 'linear' });
  expect(String(h.effects.at(-1)!.keys[0]!.transform)).toContain('rotate(720deg)');
  next.seek(500); expect(h.values.get('transform')).toContain('rotate(900deg)'); next.stop();
});

it('явные размеры работают поверх CSS auto; произвольная единица сохраняется', () => {
  const h = harness(true); h.values.set('width', 'auto');
  const size = h.runtime.animate(h.element, { width: [240, 360] }, { duration: 1000, ease: 'linear' });
  size.seek(500); expect(h.values.get('width')).toBe('300px'); expect(h.effects).toHaveLength(0);
  size.finish();
  const margin = h.runtime.animate(h.element, { 'margin-left': ['1rem', '3rem'] }, { duration: 1000, ease: 'linear' });
  margin.seek(500); expect(h.values.get('margin-left')).toBe('2rem'); margin.stop();
});

it('кламп opacity совпадает с живым путём для исходных значений вне CSS-диапазона', () => {
  const h = harness(true);
  const c = h.runtime.animate(h.element, { opacity: [-1, 2] }, { duration: 1000, ease: 'linear' });
  expect(h.effects).toHaveLength(0);
  c.seek(250); expect(h.values.get('opacity')).toBe('0');
  c.seek(750); expect(h.values.get('opacity')).toBe('1'); c.stop();
});

it('ошибка второй подписки удаляет первую и не оставляет принятых owners', () => {
  const h = harness(); const error = new Error('render registration');
  const render = h.host.frame.render; h.host.frame.render = () => { throw error; };
  expect(() => h.runtime.animate(h.element, { x: 100 }, { duration: 1000 })).toThrow(error);
  expect(h.updates.size).toBe(0); expect(h.renders.size).toBe(0);
  h.host.frame.render = render;
  const next = h.runtime.animate(h.element, { x: 200 }, { duration: 1000, ease: 'linear' });
  next.finish(); expect(h.x()).toBe(200);
});

it('undefined из callback сохраняется как ошибка и очищает все выходы прогона', async () => {
  const h = harness();
  const c = h.runtime.animate(h.element, { x: 100, opacity: 0 }, { duration: 1000, ease(t) { if (t) throw undefined; return t; } });
  h.step(100); await expect(c.finished).rejects.toBeUndefined();
  expect(c.state).toBe('failed'); expect(h.updates.size + h.renders.size).toBe(0);
});

it('host setter может остановить движение без повторного writer после принятой остановки', async () => {
  const h = harness();
  const c = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
  const write = h.element.style.setProperty.bind(h.element.style); let called = false;
  h.element.style.setProperty = (key, value) => { write(key, value); if (!called) { called = true; c.stop(); } };
  h.step(500); expect(await c.finished).toEqual({ status: 'stopped' });
  const count = h.writes.length;
  h.step(2000); expect(h.writes).toHaveLength(count); expect(h.x()).toBe(50);
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('массив снимается по первоначальной длине и не принимает inherited slots', () => {
  let reads = 0;
  const source = [0, 1];
  Object.defineProperty(source, 0, { get() { source.push(7); reads++; return 0; } });
  expect(snapshot(source, 'values', 2)).toEqual([0, 1]); expect(reads).toBe(1);
  const hole = [0, , 1];
  expect(() => snapshot(hole, 'values')).toThrow('пропущено');
});

it('поздние невалидные опции не прерывают активные соседние свойства', () => {
  const h = harness(true);
  const c = h.runtime.animate(h.element, { x: 100, opacity: 0 }, { duration: 1000 });
  for (const bad of [{ spring: { bounce: 1 } }, { duration: NaN }, { spring: {}, duration: 20 }, { ease: 'undefined' }, { frame: 1 }]) {
    expect(() => h.runtime.animate(h.element, { x: 200 }, bad as never)).toThrow();
    expect(h.effects.every(effect => !effect.cancelled)).toBe(true);
  }
  c.stop();
});

it('цветовые значения, custom properties и несколлапсированная задержка используют тот же lifecycle', () => {
  const h = harness(true);
  const c = h.runtime.animate(h.element, { color: ['#000', '#fff'], '--offset': [0, 20] }, { duration: 1000, delay: 200, ease: 'linear' });
  expect(h.effects).toHaveLength(0);
  c.seek(100); expect(h.values.get('--offset')).toBe('0');
  c.seek(700); expect(h.values.get('--offset')).toBe('10');
  expect(h.values.get('color')).toContain('180.312');
  c.finish(); expect(h.values.get('color')).toBe('rgba(255,255,255,1)');
});

it('повторная sequence сохраняет общий конец для раннего канала при обратной перемотке', () => {
  const h = harness();
  const c = h.runtime.sequence([
    [h.element, { x: 100 }, { at: 0, duration: 100, ease: 'linear' }],
    [h.element, { y: 100 }, { at: 200, duration: 100, ease: 'linear' }],
  ]);
  c.seek(150); expect(h.x()).toBe(100);
  c.seek(50); expect(h.x()).toBe(50); expect(h.y()).toBe(0);
  c.finish(); expect(h.y()).toBe(100);
});

it('откат host clock не замедляет последующее продвижение двойным учётом времени', () => {
  const h = harness();
  const c = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
  h.step(400); h.step(200); expect(h.x()).toBe(40);
  h.step(600); expect(h.x()).toBe(60); c.stop();
});


it('10 000 повторных целей держат один эффект и отзывают управление старых компонентов', async () => {
  const h = harness(true);
  const first = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
  let current = first;
  for (let i = 0; i < 10_000; i++) {
    const previous = current;
    current = h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' });
    expect(previous.state).toBe('stopped');
    previous.stop(); previous.finish();
  }
  expect(h.effects).toHaveLength(1); expect(h.effects[0]!.cancelled).toBe(false);
  const registry = (h.runtime as unknown as { _surfaces: WeakMap<Element, Map<string, { tracks: Map<string, { _owner: unknown }> }>> })._surfaces;
  expect(registry.get(h.element)!.get('transform')!.tracks.get('x')!._owner).toBe(current);
  current.finish(); expect(await current.finished).toEqual({ status: 'finished' });
  expect(await first.finished).toEqual({ status: 'stopped' });
});

it('постоянный элемент не накапливает завершённые custom properties в реестре', () => {
  const h = harness();
  for (let i = 0; i < 10_000; i++) h.runtime.animate(h.element, { ['--test' + i]: [0, 1] }, { duration: 0 });
  const registry = (h.runtime as unknown as { _surfaces: WeakMap<Element, Map<string, unknown>> })._surfaces;
  expect(registry.get(h.element)?.size ?? 0).toBe(0);
  expect(h.updates.size + h.renders.size).toBe(0);
});


it('нулевая длительность уважает задержку и не применяет финал раньше времени', () => {
  const h = harness();
  const c = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 0, delay: 100 });
  expect(h.x()).toBe(0); c.seek(50); expect(h.x()).toBe(0);
  c.seek(100); expect(h.x()).toBe(100); expect(c.state).toBe('finished');
});

it('общая задержка sequence применяется единожды, а reduced завершает без временной шкалы', () => {
  const h = harness();
  const steps = [[h.element, { x: 100 }, { duration: 100 }], [h.element, { x: 200 }, { duration: 100 }]] as const;
  const c = h.runtime.sequence(steps, { delay: 100 });
  expect(c.duration).toBe(300); c.finish();
  const reduced = h.runtime.sequence(steps, { reducedMotion: 'always' });
  expect(reduced.duration).toBe(0); expect(reduced.state).toBe('finished'); expect(h.x()).toBe(200);
});


it('ошибка отписки не блокирует следующий цикл и доходит до finished', async () => {
  const h = harness(), failure = new Error('unsubscribe');
  const subscribe = h.host.frame.render.bind(h.host.frame);
  h.host.frame.render = (cb, options) => {
    const off = subscribe(cb, options);
    return () => { off(); throw failure; };
  };
  const first = h.runtime.animate(h.element, { x: 100 }, { duration: 1000 });
  first.finish(); await expect(first.finished).rejects.toBe(failure);
  expect(h.updates.size + h.renders.size).toBe(0);
  h.host.frame.render = subscribe;
  const next = h.runtime.animate(h.element, { x: 200 }, { duration: 100, ease: 'linear' });
  h.step(100); expect(await next.finished).toEqual({ status: 'finished' }); expect(h.x()).toBe(200);
});
