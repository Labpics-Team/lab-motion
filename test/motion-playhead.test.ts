import { playhead } from '../src/motion/playhead.js';
import { expect, it, vi } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback } from '../src/motion/types.js';

type TemporalPlayback = Playback & { readonly time: number | undefined; timeScale: number; reverse(): void };

it('изменяет скорость и направление одного исполняемого animate без скачка', async () => {
  const h = harness();
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 })) as TemporalPlayback;
  h.step(200); expect(run.time).toBe(200);
  run.timeScale = 2;
  expect(h.x()).toBe(20);
  h.step(300); expect(h.x()).toBe(40); expect(run.time).toBe(400);
  run.reverse(); expect(h.x()).toBe(40);
  h.step(500); expect(h.x()).toBe(0);
  expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('sequence обращает всю действующую шкалу, включая промежутки', async () => {
  const h = harness();
  const run = playhead(h.runtime.sequence([
    [h.element, { x: [0, 100] }, { duration: 100 }],
    [h.element, { x: [100, 200] }, { at: 200, duration: 100 }],
  ])) as TemporalPlayback;
  run.seek(250); run.pause(); run.timeScale = -.5;
  expect(run.state).toBe('paused'); expect(run.time).toBe(250);
  run.play(); h.step(400); expect(h.x()).toBe(50);
  h.step(500); expect(await run.finished).toEqual({ status: 'finished' });
  expect(h.x()).toBe(0);
});

it('пауза, нулевая скорость и terminal controls не создают скрытую работу', async () => {
  const h = harness();
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  h.step(200); run.timeScale = 0;
  expect(run.time).toBe(200); expect(h.updates.size + h.renders.size).toBe(0);
  h.step(800); run.reverse(); expect(h.x()).toBe(20);
  run.pause(); run.timeScale = -2; h.step(1000);
  expect(run.state).toBe('paused'); expect(run.time).toBe(200);
  run.play(); h.step(1100);
  expect(await run.finished).toEqual({ status: 'finished' }); expect(run.time).toBe(0);
  const writes = h.writes.length;
  run.timeScale = NaN; run.reverse(); run.seek(NaN); run.play();
  expect(h.writes).toHaveLength(writes); expect(h.updates.size + h.renders.size).toBe(0);
});

it('нативный прогон меняет скорость на том же effect, без JS-кадров', async () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  const effect = h.effects[0]!;
  effect.currentTime = 300;
  for (const scale of [2, .5, 1, 0, 4]) {
    run.timeScale = scale;
    expect(run.time).toBe(300); expect(effect.playbackRate).toBe(scale);
    expect(h.effects).toHaveLength(1); expect(effect.cancelled).toBe(false);
    expect(h.updates.size + h.renders.size).toBe(0);
  }
  run.reverse(); expect(run.timeScale).toBe(-4); expect(effect.cancelled).toBe(true);
  effect.complete(); h.step(75);
  expect(await run.finished).toEqual({ status: 'finished' }); expect(h.x()).toBe(0);
  expect(effect.cancelled).toBe(true);
});

it('скорость одной оси не меняет вторую ось общей native-поверхности', async () => {
  const h = harness(true);
  const old = playhead(h.runtime.animate(h.element, { x: 100, y: 200 }, { duration: 1000, ease: 'linear' }));
  const effect = h.effects[0]!; effect.currentTime = 200;
  const x = playhead(h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' }));
  x.timeScale = 2;
  expect(effect.cancelled).toBe(true); expect(h.effects).toHaveLength(1);
  h.step(100); expect(h.x()).toBe(40); expect(h.y()).toBe(60);
  old.reverse(); h.step(200); expect(h.x()).toBe(60); expect(h.y()).toBe(40);
  old.stop(); x.finish();
  expect(await old.finished).toEqual({ status: 'stopped' });
  expect(await x.finished).toEqual({ status: 'finished' });
});

it('при повторном использовании разных фаз общий time не выдумывается', () => {
  const h = harness();
  const x = playhead(h.runtime.animate(h.element, { x: 100 }, { duration: 1000, ease: 'linear' }));
  h.step(100);
  const y = playhead(h.runtime.animate(h.element, { y: 200 }, { duration: 1000, ease: 'linear' }));
  y.timeScale = 2;
  const both = playhead(h.runtime.animate(h.element, { x: 100, y: 200 }, { duration: 1000, ease: 'linear' }));
  expect(both.time).toBeUndefined(); expect(both.timeScale).toBeUndefined();
  both.timeScale = .5; expect(both.timeScale).toBe(.5);
  both.seek(250); expect(both.time).toBe(250);
  x.stop(); y.reverse(); both.finish(); expect(h.x()).toBe(100); expect(h.y()).toBe(200);
});

it('невалидная скорость отклоняется до изменения владельца, эффектов и позы', () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  const effect = h.effects[0]!, writes = h.writes.length;
  for (const invalid of [NaN, Infinity, -Infinity, '2', null]) {
    expect(() => { run.timeScale = invalid as number; }).toThrow(/timeScale/);
    expect(h.effects).toHaveLength(1); expect(effect.cancelled).toBe(false);
    expect(effect.playbackRate).toBe(1); expect(h.writes).toHaveLength(writes);
  }
  run.stop();
});

it('ошибка native rate завершает sibling-каналы и не выдаёт успешный finished', async () => {
  const h = harness(true); const error = new Error('native rate failed');
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100], opacity: [0, 1] }, { duration: 1000 }));
  h.effects[0]!.updatePlaybackRate = () => { throw error; };
  expect(() => { run.timeScale = 2; }).toThrow(error);
  await expect(run.finished).rejects.toBe(error);
  expect(run.state).toBe('failed'); expect(h.effects.every(effect => effect.cancelled)).toBe(true);
  expect(h.updates.size + h.renders.size).toBe(0);
});

it('отсутствующий updatePlaybackRate пересоздаёт native effect с той же позой', () => {
  const h = harness(true);
  const animate = h.element.animate.bind(h.element);
  h.element.animate = ((...args: Parameters<HTMLElement['animate']>) => {
    const effect = animate(...args);
    Object.defineProperty(effect, 'updatePlaybackRate', { value: undefined });
    return effect;
  }) as HTMLElement['animate'];
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  h.effects[0]!.currentTime = 200;
  run.timeScale = 2;
  expect(h.effects).toHaveLength(2); expect(h.effects[0]!.cancelled).toBe(true);
  const current = h.effects[1]!;
  expect(current.playbackRate).toBe(2); expect(current.currentTime).toBe(200);
  current.currentTime = 400;
  run.pause(); expect(h.x()).toBe(40); expect(run.time).toBe(400);
  run.stop(); expect(h.updates.size + h.renders.size).toBe(0);
});

it('spring-handoff получает скорость движения после замедления и разворота', () => {
  for (const rate of [.5, -2]) {
    const h = harness();
    const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
    run.seek(400); run.timeScale = rate;
    const from = h.x();
    const successor = playhead(h.runtime.animate(h.element, { x: 200 }));
    h.step(.001);
    expect((h.x() - from) / .000001).toBeCloseTo(100 * rate, 0);
    successor.finish();
  }
});

it('чтение time не пишет CSS, а двойной reverse сохраняет фазу и возвращает native', () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  const effect = h.effects[0]!; effect.currentTime = 250;
  const writes = h.writes.length;
  for (let i = 0; i < 1000; i++) expect(run.time).toBe(250);
  expect(h.writes).toHaveLength(writes);
  run.reverse(); run.reverse();
  expect(run.timeScale).toBe(1); expect(run.time).toBe(250);
  expect(h.effects).toHaveLength(2); expect(effect.cancelled).toBe(true);
  expect(h.updates.size + h.renders.size).toBe(0);
  run.stop();
});

it('случайные временные команды совпадают с независимым линейным oracle', () => {
  let seed = 0x51ca1e;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let scenario = 0; scenario < 48; scenario++) {
    const h = harness();
    const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
    let time = 500, wall = 0, scale = 1, paused = false;
    run.seek(time);
    for (let step = 0; step < 64; step++) {
      const action = Math.floor(random() * 5);
      if (action === 0) { scale = [0, .5, 2, -1, -3][Math.floor(random() * 5)]!; run.timeScale = scale; }
      else if (action === 1) { scale = -scale; run.reverse(); }
      else if (action === 2) { paused = !paused; if (paused) run.pause(); else run.play(); }
      else if (action === 3) { time = 200 + Math.floor(random() * 600); run.seek(time); }
      else {
        const delta = 1 + Math.floor(random() * 9); wall += delta;
        if (!paused) time = Math.max(0, Math.min(1000, time + delta * scale));
        h.step(wall);
      }
      expect(run.time).toBeCloseTo(time, 8);
      expect(h.x()).toBeCloseTo(time / 10, 8);
      if (run.state === 'finished') break;
    }
    run.stop(); expect(h.updates.size + h.renders.size).toBe(0);
  }
});

for (const native of [false, true]) it('seek к концу обратного прогона не завершает его, native=' + native, async () => {
  const h = harness(native);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  run.pause(); run.reverse(); run.seek(5000);
  expect(run.time).toBe(1000); expect(run.state).toBe('paused'); expect(h.x()).toBe(100);
  run.play();
  h.step(250);
  run.pause(); expect(h.x()).toBe(75); expect(run.time).toBe(750);
  run.seek(0); expect(await run.finished).toEqual({ status: 'finished' }); expect(h.x()).toBe(0);
});

it('передача прежней пружины сохраняет длительность исполняемого артефакта', () => {
  for (const fraction of [.1, .25, .6]) {
    const h = harness();
    const first = h.runtime.animate(h.element, { x: 100 });
    const duration = first.duration;
    first.seek(duration * fraction);
    const next = playhead(h.runtime.animate(h.element, { x: 100 }));
    expect(next.duration).toBe(duration); expect(next.time).toBeCloseTo(duration * fraction, 8);
    next.finish(); expect(next.time).toBe(duration);
  }
});

it('pending native rate сохраняет авторитет currentTime, а late finished не забирает JS reverse', async () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  const effect = h.effects[0]!;
  effect.currentTime = 200;
  effect.updatePlaybackRate = () => {};
  run.timeScale = 0;
  effect.currentTime = 250; expect(run.time).toBe(250);
  run.timeScale = -1; effect.complete(); await Promise.resolve();
  expect(run.state).toBe('running'); expect(effect.cancelled).toBe(true);
  h.step(250);
  expect(await run.finished).toEqual({ status: 'finished' }); expect(h.x()).toBe(0);
});

it('10000 смен скорости не накапливают слушателей одного native finished', () => {
  const h = harness(true);
  const run = playhead(h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 }));
  const effect = h.effects[0]!; effect.currentTime = 500;
  const observed = vi.spyOn(effect.finished, 'then');
  for (let i = 0; i < 10000; i++) run.timeScale = i % 2 ? 2 : .5;
  expect(observed).not.toHaveBeenCalled();
  expect(h.effects).toHaveLength(1); expect(h.updates.size + h.renders.size).toBe(0);
  run.stop(); expect(effect.cancelled).toBe(true);
});

for (const nested of [false, true]) it('последняя reentrant-команда применяется ко всем поверхностям, nested=' + nested, () => {
  const h = harness();
  const run = playhead(h.runtime.animate(h.element, { width: [0, 100], height: [0, 100] }, { duration: 1000 }));
  const setProperty = h.element.style.setProperty.bind(h.element.style);
  let armed = nested;
  h.element.style.setProperty = (key, value) => {
    setProperty(key, value);
    if (armed && key === 'width') { armed = false; run.timeScale = 3; }
  };
  run.timeScale = 2;
  expect(run.timeScale).toBe(nested ? 3 : 2);
  h.step(100);
  expect(Number.parseFloat(h.values.get('width')!)).toBe(nested ? 30 : 20);
  expect(Number.parseFloat(h.values.get('height')!)).toBe(nested ? 30 : 20);
  run.stop(); expect(h.updates.size + h.renders.size).toBe(0);
});

it('повторный playhead возвращает те же контролы и не создаёт второго наблюдателя', () => {
  const h = harness();
  const source = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 });
  const first = playhead(source);
  expect(playhead(source)).toBe(first); expect(playhead(first)).toBe(first);
  expect(first.finished).toBe(source.finished);
  first.seek(300); first.reverse(); first.stop();
  expect(first.time).toBe(300); expect(first.timeScale).toBe(-1);
});

it('позднее наблюдение завершённого движения не выдумывает его конечную фазу', () => {
  const h = harness();
  const run = h.runtime.animate(h.element, { x: [0, 100] }, { duration: 1000 });
  run.seek(300); run.stop();
  const view = playhead(run);
  expect(view.time).toBeUndefined(); expect(view.timeScale).toBeUndefined();
  view.reverse(); view.timeScale = 2; expect(view.state).toBe('stopped');
});

it('освобождённая scope сохраняет motion-контролы, но не превращает layout в обратимое движение', async () => {
  const { scope } = await import('../src/motion/scope.js');
  const area = scope({ querySelectorAll: () => [] } as unknown as HTMLElement);
  area.dispose();
  const motion = area.animate([] as Element[], {});
  const sequence = area.sequence([]);
  for (const result of [motion, sequence]) {
    const view = playhead(result);
    expect(view.state).toBe('stopped'); expect(view.time).toBe(0);
    expect(await view.finished).toEqual({ status: 'stopped' });
    view.timeScale = -2; view.reverse(); view.play();
    expect(view.state).toBe('stopped');
  }
  const transition = area.layout(() => { throw Error('Не должно исполняться после dispose'); });
  expect(() => playhead(transition)).toThrow(/playhead/);
});
