import { describe, expect, it } from 'vitest';
import { compileSpringLinear } from '../src/compositor/index.js';

describe('compositor: канонические разделители linear()', () => {
  it('не эмитит необязательный пробел после запятых между стопами', () => {
    const easing = compileSpringLinear({ mass: 1, stiffness: 170, damping: 26 });
    expect(easing).toMatch(/^linear\([^)]+\)$/);
    expect(easing).not.toMatch(/,\s/);
    expect(easing.split(',').length).toBeGreaterThan(2);
  });
});
