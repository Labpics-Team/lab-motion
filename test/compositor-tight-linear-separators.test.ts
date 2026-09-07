import { describe, expect, it } from 'vitest';
import { compileSpringLinear } from '../src/compositor/index.js';

describe('compositor: canonical linear() separators', () => {
  it('emits no optional whitespace between stops', () => {
    const easing = compileSpringLinear({ mass: 1, stiffness: 170, damping: 26 });
    expect(easing).toMatch(/^linear\([^)]+\)$/);
    expect(easing).not.toContain(', ');
    expect(easing.split(',').length).toBeGreaterThan(2);
  });
});
