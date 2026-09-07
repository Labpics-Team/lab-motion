import { describe, expect, it } from 'vitest';

import { springLinear } from '../src/nano/spring-linear.js';

/**
 * Эти witnesses выбраны так, что position уже внутри 1e-3, а velocity/30 ещё
 * снаружи. Поэтому удаление velocity-предиката преждевременно завершает settle.
 * Exact duration одновременно запечатывает binary64-порядок оптимизированного
 * shared-exp вычисления: сам CSS sampler после этого остаётся прежним.
 */
describe('nano: монотонный settle сохраняет скоростную границу', () => {
  it('critical high-frequency ждёт velocity, не только position', () => {
    const [duration] = springLinear({ mass: 1, stiffness: 10_000, damping: 200 });
    expect(Object.is(duration, 104.66666666666715)).toBe(true);
    // Position-only остановился бы на 92.66666666666698 ms.
    expect(duration).toBeGreaterThan(92.66666666666698);
  });

  it('overdamped high-frequency ждёт velocity, не только position', () => {
    const [duration] = springLinear({ mass: 1, stiffness: 90_000, damping: 1_200 });
    expect(Object.is(duration, 99.52135486850335)).toBe(true);
    // Position-only остановился бы на 87.08118550994052 ms.
    expect(duration).toBeGreaterThan(87.08118550994052);
  });
});
