import { defineConfig } from 'vitest/config';

/** Эти fixtures порождают Git/esbuild-процессы и измеренно конфликтуют под высокой конкуренцией. */
const processFixtures = [
  'test/git-path-list.test.ts',
  'test/size-gate-autoderive.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        // Наследует config-specific политику корня, включая Stryker exclude.
        extends: true,
        test: {
          name: 'parallel',
          include: ['test/**/*.test.ts'],
          exclude: processFixtures,
        },
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: processFixtures,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
