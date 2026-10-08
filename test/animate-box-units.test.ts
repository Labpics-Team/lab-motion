import { expect, it } from 'vitest';
import { parseProps, type CssChannelSpec } from '../src/animate/channels.js';
import { animate } from '../src/animate/index.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const sizes = ['width', 'height'];
for (const property of sizes) it(`${property}: числовые размеры принадлежат пиксельной системе координат`, () => {
  const groups = parseProps({ [property]: [10, 20] });
  const ch = [...groups.values()][0]![0] as CssChannelSpec;
  expect(ch._explicitFrom).toEqual({ kind: 'unit', unit: 'px', value: 10 });
  expect(ch._to).toEqual({ kind: 'unit', unit: 'px', value: 20 });
  const explicit = [...parseProps({ [property]: ['1rem', '2rem'] }).values()][0]![0] as CssChannelSpec;
  expect(explicit._to).toEqual({ kind: 'unit', unit: 'rem', value: 2 });
});

for (const property of ['lineHeight', 'zIndex', 'flexGrow', '--width', '--inline-size', 'minWidth', 'inlineSize'])
  it(`${property}: сохраняет прежнюю единицу значения`, () => {
    const ch = [...parseProps({ [property]: [1, 2] }).values()][0]![0] as CssChannelSpec;
    expect(ch._to).toEqual({ kind: 'unit', unit: '', value: 2 });
  });

it('размеры читают каждый getter один раз и отвергают нефинитные значения до записи', () => {
  let reads = 0;
  parseProps({ get width() { reads++; return [0, 20]; } });
  expect(reads).toBe(1);
  for (const value of [NaN, Infinity, -Infinity]) {
    const host = fakeEl();
    expect(() => animate(host.el, { width: [0, value] })).toThrow();
    expect(host.writes).toEqual([]);
  }
});

it('перехват, snapshot и reduced motion используют те же CSS-единицы', () => {
  const host = fakeEl({ width: '20px', height: '10px' });
  const clock = makeClock();
  const a = animate(host.el, { width: [20, 40], height: [10, 30] }, { duration: 100, ease: t => t, requestFrame: clock.requestFrame });
  clock.step(0); clock.step(50);
  expect(host.el.style.getPropertyValue('width')).toBe('30px');
  expect(host.el.style.getPropertyValue('height')).toBe('20px');
  const b = animate(host.el, { width: 50 }, { duration: 100, ease: t => t, requestFrame: clock.requestFrame });
  clock.step(0); clock.step(50);
  expect(host.el.style.getPropertyValue('width')).toBe('40px');
  b.cancel(); a.cancel();
  animate(host.el, { width: 0 }, { matchMedia: () => ({ matches: true }) });
  expect(host.el.style.getPropertyValue('width')).toBe('0px');
});
