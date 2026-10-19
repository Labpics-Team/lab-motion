import { expect, it } from 'vitest';
import { harness } from './fixtures/motion-runtime.js';

for (const authored of ['var(--goal)', 'var( --goal )', 'VAR(--goal, 30px)', 'var(--missing, var(--goal))']) {
  it('root использует грамматику authored CSS codec: ' + authored, () => {
    const h = harness(); h.values.set('--goal', '100px');
    const run = h.runtime.animate(h.element, { width: [0, authored] }, { duration: 100 });
    run.seek(50); expect(h.values.get('width')).toBe('50px');
    run.finish(); expect(h.values.get('width')).toBe('100px');
  });
}

it('цикл и слишком длинная CSS-переменная отклоняются до записи', () => {
  const h = harness();
  h.values.set('--a', 'var(--b)'); h.values.set('--b', 'var(--a)');
  for (const value of ['var(--a)', 'var(--' + 'a'.repeat(4096) + ')']) {
    expect(() => h.runtime.animate(h.element, { width: value })).toThrow(/width: CSS/);
    expect(h.writes).toHaveLength(0);
    expect(h.updates.size + h.renders.size).toBe(0);
  }
});
