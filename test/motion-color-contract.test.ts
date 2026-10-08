import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

const read = (text: string): number[] => text.slice(text.indexOf('(') + 1, -1).split(',').map(Number);

it('root цвета нормализуются в RGB с отдельной alpha независимо от входного синтаксиса', async () => {
  for (const colors of [
    ['#ff0000', '#0000ff'],
    ['rgb(255,0,0)', 'rgb(0,0,255)'],
    ['hsl(0,100%,50%)', 'hsl(240,100%,50%)'],
  ]) {
    const h = harness(true);
    const run = h.runtime.animate(h.element, { color: colors }, { duration: 1000, ease: 'linear' });
    try {
      run.seek(500);
      const rgba = read(h.values.get('color')!);
      expect(rgba[0]).toBeCloseTo(255 / Math.sqrt(2), 10);
      expect(rgba[1]).toBe(0); expect(rgba[2]).toBeCloseTo(rgba[0]!, 10); expect(rgba[3]).toBe(1);
      expect(h.effects).toHaveLength(0);
      run.finish(); expect(await run.finished).toEqual({ status: 'finished' });
      expect(read(h.values.get('color')!)).toEqual([0, 0, 255, 1]);
    } finally { run.stop(); }
  }
});
it('color retarget сохраняет промежуточную позу и отдельную непрозрачность', async () => {
  const h = harness();
  const first = h.runtime.animate(h.element, { color: ['rgba(255,0,0,0.2)', 'rgba(0,0,255,0.8)'] }, { duration: 1000, ease: 'linear' });
  let second: ReturnType<typeof h.runtime.animate> | undefined;
  try {
    h.step(500); const before = read(h.values.get('color')!);
    second = h.runtime.animate(h.element, { color: '#00ff00' }, { duration: 1000, ease: 'linear' });
    const after = read(h.values.get('color')!);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 10)); expect(before[3]).toBeCloseTo(.5, 12);
    expect(await first.finished).toEqual({ status: 'stopped' });
    second.finish(); expect(await second.finished).toEqual({ status: 'finished' });
  } finally { first.stop(); second?.stop(); }
});
