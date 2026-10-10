import { expect, it } from 'vitest';
import { animate as legacy } from '../src/animate/index.js';
import { harness } from './fixtures/motion-runtime.js';

function matrix(text: string): number[] {
  let result = [1, 0, 0, 1, 0, 0];
  for (const match of text.matchAll(/([A-Za-z]+)\(([^)]+)\)/g)) {
    const values = match[2]!.split(',').map(value => parseFloat(value));
    const [x = 0, y = 0] = values;
    const angle = x * Math.PI / 180;
    let right: number[];
    switch (match[1]) {
      case 'translate': right = [1, 0, 0, 1, x, y]; break;
      case 'translateX': right = [1, 0, 0, 1, x, 0]; break;
      case 'translateY': right = [1, 0, 0, 1, 0, x]; break;
      case 'scale': right = [x, 0, 0, values[1] ?? x, 0, 0]; break;
      case 'scaleX': right = [x, 0, 0, 1, 0, 0]; break;
      case 'scaleY': right = [1, 0, 0, x, 0, 0]; break;
      case 'rotate': right = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]; break;
      case 'skew': right = [1, Math.tan(y * Math.PI / 180), Math.tan(angle), 1, 0, 0]; break;
      case 'skewX': right = [1, 0, Math.tan(angle), 1, 0, 0]; break;
      case 'skewY': right = [1, Math.tan(angle), 0, 1, 0, 0]; break;
      default: throw new Error('Неизвестная transform-функция ' + match[1]);
    }
    const [a, b, c, d, e, f] = result as [number, number, number, number, number, number];
    const [g, h, i, j, k, l] = right as [number, number, number, number, number, number];
    result = [a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f];
  }
  return result;
}

for (const from of ['root', 'legacy'] as const) for (const settled of [false, true]) {
  it(`сохраняет геометрию при передаче повёрнутой и неравномерно масштабированной поверхности: ${from}, settled=${settled}`, () => {
    const h = harness();
    const options = { duration: 1000, ease: (t: number) => t };
    const properties = { x: 80, y: 20, scaleX: 2, scaleY: 3, rotate: 40, skewX: 10 };
    const old = from === 'root' ? h.runtime.animate(h.element, properties, options)
      : legacy(h.element, properties, { ...options, requestFrame: () => () => {} });
    old.seek(settled ? 1000 : 500);
    const before = matrix(h.element.style.getPropertyValue('transform'));
    const next = from === 'root'
      ? legacy(h.element, { x: 200 }, { ...options, requestFrame: () => () => {} })
      : h.runtime.animate(h.element, { x: 200 }, options);
    next.seek(0);
    const after = matrix(h.element.style.getPropertyValue('transform'));
    for (let i = 0; i < 6; i++) expect(after[i]).toBeCloseTo(before[i]!, 10);
    old.stop(); next.stop();
    expect(h.updates.size + h.renders.size).toBe(0);
  });
}
