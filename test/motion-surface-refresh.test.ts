import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';
import type { Playback } from '../src/motion/types.js';

const options = { duration: 1000, ease: 'linear' } as const;

it('новая transform Surface не повторяет чтение конструктора и сохраняет результат', () => {
  const h = harness(); const styles = h.host.styles; let reads = 0;
  h.host.styles = element => { reads++; return styles(element); };
  const run = h.runtime.animate(h.element, { x: 100 }, options);
  try { run.seek(500); expect(h.x()).toBe(50); expect(reads).toBe(2); }
  finally { run.stop(); }
});

for (const native of [false, true]) it(`внешний transform обновляет пустую Surface, native=${native}`, () => {
  const h = harness(native); h.runtime.animate(h.element, { x: 100 }, options).finish();
  h.values.set('transform', 'translateX(20px)');
  const run = h.runtime.animate(h.element, { x: 100 }, options);
  try { run.seek(500); expect(h.x()).toBe(60); }
  finally { run.stop(); }
});

for (const native of [false, true]) it(`предварительное чтение не заменяет свежую составную позу, native=${native}`, () => {
  const h = harness(native);
  h.values.set('transform', 'translate(20px, 40px) rotate(45deg)');
  expect(h.host.styles(h.element).getPropertyValue('transform')).toBe('translate(20px, 40px) rotate(45deg)');
  const run = h.runtime.animate(h.element, { x: 100 }, options);
  try { run.seek(500); expect(h.x()).toBe(60); expect(h.y()).toBe(40); }
  finally { run.stop(); }
  expect(h.updates.size + h.renders.size).toBe(0);
});

for (const callback of ['styles', 'now'] as const) it(`повторный вход host.${callback} сохраняет выбранную группу и живой y`, () => {
  const h = harness(); const styles = h.host.styles; const now = h.host.now;
  let entered = false; let nested: Playback | undefined;
  const enter = () => {
    if (entered) return;
    entered = true;
    nested = h.runtime.animate(h.element, { y: 100 }, options); nested.seek(250);
  };
  h.host.styles = element => { if (callback === 'styles') enter(); return styles(element); };
  h.host.now = () => { if (callback === 'now') enter(); return now(); };
  const run = h.runtime.animate(h.element, { x: 100 }, options);
  try {
    run.seek(500); expect(h.x()).toBe(50); expect(h.y()).toBe(25); expect(nested?.state).toBe('running');
    nested?.seek(500); expect(h.y()).toBe(50);
  } finally { run.stop(); nested?.stop(); }
});

it('неподдержанный transform явно отказывает без подписок и разрешает восстановление', async () => {
  const h = harness(); h.values.set('transform', 'unsupported(1)');
  expect(() => h.runtime.animate(h.element, { x: 100 }, options)).toThrow('transform не поддержан');
  expect(h.updates.size + h.renders.size).toBe(0);
  h.values.set('transform', 'translateX(20px)');
  const run = h.runtime.animate(h.element, { x: 100 }, options);
  try { run.seek(500); expect(h.x()).toBe(60); run.finish(); expect(await run.finished).toEqual({ status: 'finished' }); }
  finally { run.stop(); }
  expect(h.updates.size + h.renders.size).toBe(0);
});
