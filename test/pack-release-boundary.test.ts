import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const smoke = readFileSync(new URL('../scripts/pack-smoke.mjs', import.meta.url), 'utf8');

describe('packed release boundary', () => {
  it('ships every referenced support document', () => {
    expect(pkg.files).toContain('docs/errors.md');
    expect(pkg.files).toContain('docs/benchmark.md');
    expect(pkg.files).toContain('docs/motion-conformance.md');
    expect(pkg.files).toContain('docs/recipes.md');
    expect(smoke).toContain("'docs/benchmark.md'");
    expect(smoke).toContain("'docs/motion-conformance.md'");
    expect(smoke).toContain("readFileSync(installedMotionContract, 'utf8') !== readFileSync");
    expect(smoke).toContain("'docs/recipes.md'");
    expect(smoke).toContain("readFileSync(installedRecipes, 'utf8') !== readFileSync");
    expect(smoke).toContain("readFileSync(installedBenchmark, 'utf8') !== readFileSync");
    expect(smoke).toContain('parseBenchmarkDocumentationState(benchmarkDocument, installedPackage)');
    expect(smoke).not.toContain('/bench/compare/results/`;');
  });

  it('ссылка на контракт движения разрешается в реально поставляемый документ', () => {
    const document = readFileSync(new URL('../docs/benchmark.md', import.meta.url), 'utf8');
    const links = [...document.matchAll(/\[контракт движения\]\(([^)]+)\)/g)];
    expect(links).toHaveLength(1);
    const target = posix.normalize(posix.join('docs', links[0]![1]!));
    expect(pkg.files).toContain(target);
    expect(readFileSync(new URL(`../${target}`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
  });

  it.each([['контракт-v1', false], ['повреждённый контракт', true]])(
    'исполняемый readback отклоняет повреждённый документ: %s', (packed, expectedFailure) => {
      const start = smoke.indexOf('  const installedMotionContract =');
      const end = smoke.indexOf('  if (existsSync(installedBenchmark)', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      // Исполняется реальный readback-блок; ожидание задано независимо от его условия.
      const files = new Map([
        [join('/source', 'docs', 'motion-conformance.md'), 'контракт-v1'],
        [join('/archive', 'docs', 'motion-conformance.md'), packed],
      ]);
      const context = {
        ROOT: '/source', installedRoot: '/archive', failed: false, join,
        existsSync: (path: string) => files.has(path),
        readFileSync: (path: string) => files.get(path),
        log: () => {},
      };
      runInNewContext(smoke.slice(start, end), context);
      expect(context.failed).toBe(expectedFailure);
    },
  );

  it('derives the runnable Node floor and export surface from installed archive metadata', () => {
    expect(smoke).toContain("JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))");
    expect(smoke).toContain("/^>=(\\d+)$/.exec(installedPackage.engines?.node ?? '')");
    expect(smoke).toContain('Object.keys(installedPackage.exports)');
    expect(smoke).not.toContain("pkg.engines?.node !== '>=22'");
  });
});
