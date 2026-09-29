import { defineConfig } from 'vitest/config';

/**
 * Focused semantic suite for src/driver.ts mutation analysis.
 *
 * Keep this list capability-shaped rather than line-shaped: playback/lifecycle,
 * reduced motion, virtual time, velocity/continuity and unclamped physics. The
 * normal Vitest run remains authoritative for the complete repository.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/driver-*.test.ts',
      'test/fixed-dt-fallback-pin.test.ts',
      'test/invalid-param-error.test.ts',
      'test/unclamped-overshoot-surfaces.test.ts',
      'test/continuity-differential-matrix.test.ts',
    ],
    exclude: ['test/perf-hot-path.test.ts'],
  },
});
