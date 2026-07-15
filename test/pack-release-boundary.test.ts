import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const smoke = readFileSync(new URL('../scripts/pack-smoke.mjs', import.meta.url), 'utf8');

describe('packed release boundary', () => {
  it('ships both referenced support documents', () => {
    expect(pkg.files).toContain('docs/errors.md');
    expect(pkg.files).toContain('docs/benchmark.md');
    expect(smoke).toContain("'docs/benchmark.md'");
    expect(smoke).toContain("readFileSync(installedBenchmark, 'utf8') !== readFileSync");
    expect(smoke).toContain('parseBenchmarkDocumentationState(benchmarkDocument, installedPackage)');
    expect(smoke).not.toContain('/bench/compare/results/`;');
  });

  it('derives the runnable Node floor and export surface from installed archive metadata', () => {
    expect(smoke).toContain("JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))");
    expect(smoke).toContain("/^>=(\\d+)$/.exec(installedPackage.engines?.node ?? '')");
    expect(smoke).toContain('Object.keys(installedPackage.exports)');
    expect(smoke).not.toContain("pkg.engines?.node !== '>=22'");
  });
});
