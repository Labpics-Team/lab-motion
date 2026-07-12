import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * Mutation-инструментация меняет физическую стоимость hot path, поэтому
 * wall-clock seal остаётся в обычном CI, а Stryker проверяет поведение ядра.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: ['test/perf-hot-path.test.ts'],
    },
  }),
);
