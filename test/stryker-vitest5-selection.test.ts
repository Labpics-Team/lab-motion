import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, type RunnerTestCase } from 'vitest';

const runnerEntry = createRequire(import.meta.url).resolve('@stryker-mutator/vitest-runner');
const helper = await import(new URL('./test-helpers.js', pathToFileURL(runnerEntry)).href) as {
  collectTestName: (task: RunnerTestCase) => string;
  toRawTestId: (task: RunnerTestCase) => string;
};

function assertSelected(task: RunnerTestCase): void {
  // Vitest supplies fullTestName independently of Stryker's coverage ID writer.
  const name = helper.collectTestName(task);
  expect(name).toBe(task.fullTestName);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(task.fullTestName).toMatch(new RegExp(`^${escaped}$`));
  expect(helper.toRawTestId(task)).toBe(`${task.file.filepath}#${task.fullTestName}`);
}

describe('driver [coverage]', () => {
  describe('nested (suite) | ^ $', () => {
    it('selects the actual nested test', ({ task }) => assertSelected(task));
  });
});

it('  retains boundary whitespace  ', ({ task }) => assertSelected(task));

describe('', () => {
  it('retains the anonymous suite boundary', ({ task }) => assertSelected(task));
});
