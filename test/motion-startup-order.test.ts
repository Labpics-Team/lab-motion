import { expect, it, vi } from 'vitest';
import { Run } from '../src/motion/runtime.js';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback } from '../src/motion/types.js';

const options = { duration: 1000, ease: 'linear' } as const;

it('группа естественно завершает native эффекты и освобождает исполнителей', async () => {
  // Given: каждый native host наблюдает только собственную начальную позу.
  const a = harness(true), b = harness(true);
  for (const target of [a, b]) {
    const animate = target.element.animate.bind(target.element);
    target.element.animate = (keys, timing) => {
      expect(target.x()).toBe(20);
      return animate(keys, timing);
    };
  }
  // When: группа запускается через настоящий Runtime.
  const run = a.runtime.animate([a.element, b.element], { x: [20, 100] }, options);
  try {
    // Then: обе траектории доступны до return и завершаются с очисткой.
    expect(a.x()).toBe(20); expect(b.x()).toBe(20);
    expect(a.effects).toHaveLength(1); expect(b.effects).toHaveLength(1);
    a.effects[0]?.complete(); b.effects[0]?.complete();
    expect(await run.finished).toEqual({ status: 'finished' });
    expect(a.x()).toBe(100); expect(b.x()).toBe(100);
    expect([...a.effects, ...b.effects].every(effect => effect.cancelled)).toBe(true);
    expect(a.updates.size + a.renders.size).toBe(0);
  } finally { run.stop(); }
});

for (const failureAt of ['write', 'animate'] as const) {
  it(`поздняя ошибка ${failureAt} очищает всю принятую группу`, async () => {
    // Given: вторая поверхность однократно отказывает на границе host.
    const a = harness(true), b = harness(true);
    const failure = new Error('Ошибка второй поверхности');
    const write = b.element.style.setProperty.bind(b.element.style);
    const animate = b.element.animate.bind(b.element);
    let armed = true;
    b.element.style.setProperty = (key, text, priority) => {
      if (failureAt === 'write' && armed) { armed = false; throw failure; }
      write(key, text, priority);
    };
    b.element.animate = (keys, timing) => {
      if (failureAt === 'animate' && armed) { armed = false; throw failure; }
      return animate(keys, timing);
    };
    // Наблюдатель вызывает настоящий _own и не подменяет принятие полномочий.
    const ownership = vi.spyOn(Run.prototype, '_own');
    try {
      // When: ошибка возникает после принятия tracks обеих поверхностей.
      expect(() => a.runtime.animate([a.element, b.element], { x: [20, 100] }, options)).toThrow(failure);
      // Then: реальные принятые tracks освобождены, original finished отклонён.
      expect(ownership.mock.calls).toHaveLength(2);
      for (const [track] of ownership.mock.calls) {
        expect(track._owner).toBeUndefined(); expect(track._group._tracks.size).toBe(0);
      }
      const owners = new Set(ownership.mock.contexts);
      expect(owners.size).toBe(1);
      for (const owner of owners) {
        expect(owner._tracks.size).toBe(0); expect(owner.state).toBe('failed');
        await expect(owner.finished).rejects.toBe(failure);
      }
      expect(a.x()).toBe(20); expect(b.x()).toBe(20);
      expect([...a.effects, ...b.effects].every(effect => effect.cancelled)).toBe(true);
      expect(a.updates.size + a.renders.size).toBe(0);
    } finally { ownership.mockRestore(); }
  });
}

it('вложенный native запуск сохраняет преемника другой поверхности', async () => {
  // Given: native host первой поверхности передаёт вторую новому владельцу.
  const a = harness(true), b = harness(true);
  const animate = a.element.animate.bind(a.element);
  let successor: Playback | undefined, armed = true;
  a.element.animate = (keys, timing) => {
    if (armed) {
      armed = false;
      successor = a.runtime.animate(b.element, { x: [20, 200] }, options);
    }
    return animate(keys, timing);
  };
  // When: исходная группа доходит до native-start первой поверхности.
  const previous = a.runtime.animate([a.element, b.element], { x: [0, 100] }, options);
  try {
    // Then: старый controller не отзывает полномочия преемника.
    expect(successor?.state).toBe('running'); expect(b.effects).toHaveLength(1);
    previous.stop();
    expect(await previous.finished).toEqual({ status: 'stopped' });
    expect(successor?.state).toBe('running'); expect(b.effects[0]?.cancelled).toBe(false);
    successor?.seek(500); expect(b.x()).toBe(110);
    successor?.finish();
    expect(await successor?.finished).toEqual({ status: 'finished' });
    expect([...a.effects, ...b.effects].every(effect => effect.cancelled)).toBe(true);
    expect(a.updates.size + a.renders.size).toBe(0);
  } finally { previous.stop(); successor?.stop(); }
});

it('writer второй поверхности не продвигает опубликованный native x при reentry', async () => {
  // Given: host clock меняется внутри второй записи, native currentTime остаётся нулём.
  const a = harness(true), b = harness(true);
  const write = b.element.style.setProperty.bind(b.element.style);
  let successor: Playback | undefined, armed = true;
  b.element.style.setProperty = (key, text, priority) => {
    write(key, text, priority);
    if (armed) {
      armed = false;
      a.step(500);
      successor = a.runtime.animate(a.element, { y: [0, 100] }, options);
    }
  };
  // When: вторая initial запись повторно входит в первую поверхность.
  const previous = a.runtime.animate([a.element, b.element], { x: [20, 100] }, options);
  try {
    // Then: baseline native pose и независимый owner y сохранены.
    expect(a.x()).toBe(20); expect(successor?.state).toBe('running');
    previous.stop();
    expect(await previous.finished).toEqual({ status: 'stopped' });
    expect(successor?.state).toBe('running');
    successor?.seek(500); expect(a.x()).toBe(20); expect(a.y()).toBe(50);
    successor?.finish();
    expect(await successor?.finished).toEqual({ status: 'finished' });
    expect([...a.effects, ...b.effects].every(effect => effect.cancelled)).toBe(true);
    expect(a.updates.size + a.renders.size).toBe(0);
  } finally { previous.stop(); successor?.stop(); }
});

for (const reduced of [false, true]) {
  it(`мгновенная группа публикует финал без native effect, reduced=${reduced}`, async () => {
    // Given: две поверхности и мгновенный либо reduced режим.
    const a = harness(true), b = harness(true);
    a.host.reduced = () => reduced;
    // When: запускается группа с ненулевой начальной позой.
    const run = a.runtime.animate([a.element, b.element], { x: [20, 100] }, {
      ...options, duration: reduced ? options.duration : 0,
    });
    try {
      // Then: финал синхронен, завершение естественное, ресурсов нет.
      expect(a.x()).toBe(100); expect(b.x()).toBe(100);
      expect(await run.finished).toEqual({ status: 'finished' });
      expect(a.effects.length + b.effects.length).toBe(0);
      expect(a.updates.size + a.renders.size).toBe(0);
    } finally { run.stop(); }
  });
}
