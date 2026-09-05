/** Ресурсоёмкие process-fixtures завершают suite отдельно, не сужая каталог. */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROCESS_FIXTURES = [
  'test/git-path-list.test.ts',
  'test/size-gate-autoderive.test.ts',
  'test/test-runner-policy.test.ts',
] as const;
const STRYKER_EXCLUDED = 'test/perf-hot-path.test.ts';

type InspectedConfig = {
  root: { maxWorkers: number | string | null };
  projects: Array<{
    name: string;
    maxWorkers: number | string | null;
    groupOrder: number;
    environment: string;
    exclude: string[];
  }>;
  files: Array<{ file: string; projectName: string }>;
};

function slash(path: string): string {
  return path.replaceAll('\\', '/');
}

function catalog(directory = resolve(ROOT, 'test')): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...catalog(path));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(slash(relative(ROOT, path)));
    }
  }
  return files.sort();
}

function inspectConfigs(): { normal: InspectedConfig; stryker: InspectedConfig } {
  const script = String.raw`
    import { Writable } from 'node:stream';
    import { createVitest } from 'vitest/node';
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    async function inspect(config) {
      const ctx = await createVitest(
        'test',
        { config, watch: false, run: true, color: false },
        {},
        { stdout: sink, stderr: sink },
      );
      try {
        const specifications = await ctx.globTestSpecifications();
        return {
          root: { maxWorkers: ctx.config.maxWorkers ?? null },
          projects: ctx.projects.map((project) => ({
            name: project.name,
            maxWorkers: project.config.maxWorkers ?? null,
            groupOrder: project.config.sequence.groupOrder,
            environment: project.config.environment,
            exclude: project.config.exclude,
          })),
          files: specifications.map((specification) => ({
            file: specification.moduleId,
            projectName: specification.project.name,
          })),
        };
      } finally {
        await ctx.close();
      }
    }
    process.stdout.write(JSON.stringify({
      normal: await inspect('vitest.config.ts'),
      stryker: await inspect('vitest.stryker.config.ts'),
    }));
  `;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST')) delete env[key];
  }
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 20_000,
    windowsHide: true,
  });
  return JSON.parse(output) as { normal: InspectedConfig; stryker: InspectedConfig };
}

function expectCatalog(
  inspected: InspectedConfig,
  expected: readonly string[],
): void {
  const files = inspected.files.map(({ file }) => slash(relative(ROOT, file)));
  expect(new Set(files).size, 'файл не должен исполняться в двух проектах').toBe(files.length);
  expect(files.toSorted()).toEqual([...expected].toSorted());
  expect(
    inspected.files
      .filter(({ projectName }) => projectName === 'process')
      .map(({ file }) => slash(relative(ROOT, file)))
      .toSorted(),
  ).toEqual([...PROCESS_FIXTURES]);
  expect(inspected.files.every(({ projectName }) =>
    projectName === 'parallel' || projectName === 'process')).toBe(true);
}

describe('Vitest resource scheduling policy', () => {
  it('разделяет измеренные process-fixtures без потери normal/Stryker каталога', () => {
    const allTests = catalog();
    const { normal, stryker } = inspectConfigs();

    expectCatalog(normal, allTests);
    expectCatalog(stryker, allTests.filter((file) => file !== STRYKER_EXCLUDED));
    const expectedProjects = [
      {
        name: 'parallel', maxWorkers: null, groupOrder: 0,
        environment: 'node',
      },
      {
        name: 'process', maxWorkers: 1, groupOrder: 1,
        environment: 'node',
      },
    ];
    for (const inspected of [normal, stryker]) {
      expect(inspected.root.maxWorkers, 'глобальный worker-cap запрещён').toBeNull();
      expect(inspected.projects.map(({ exclude: _exclude, ...project }) => project))
        .toEqual(expectedProjects);
    }
    expect(stryker.projects.every(({ exclude }) => exclude.includes(STRYKER_EXCLUDED)))
      .toBe(true);
  });
});
