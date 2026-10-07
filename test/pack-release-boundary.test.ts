import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../scripts/pack-smoke.mjs', import.meta.url), 'utf8');
const publishedDocs = pkg.files.filter((file: string) => /^docs\/[^*]+\.md$/.test(file));

describe('packed release boundary', () => {
  it('публикует все документы, на которые ведёт публичная документация', () => {
    const readmeDocs = [...new Set(
      [...readme.matchAll(/\]\((docs\/[^)#]+\.md)(?:#[^)]+)?\)/g)].map((match) => match[1]),
    )];
    expect(readmeDocs.length).toBeGreaterThan(0);
    for (const file of readmeDocs) expect(publishedDocs).toContain(file);

    for (const file of publishedDocs) {
      const document = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const match of document.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
        const href = match[1]!;
        if (/^[a-z]+:/i.test(href)) continue;
        const target = posix.normalize(posix.join(posix.dirname(file), href));
        if (target.startsWith('docs/')) expect(publishedDocs).toContain(target);
      }
    }

    expect(smoke).toContain('const readmeDocs =');
    expect(smoke).toContain('const declaredDocs =');
    expect(smoke).toContain('README ссылается на');
  });

  it('ссылка на контракт движения разрешается в реально поставляемый документ', () => {
    const document = readFileSync(new URL('../docs/benchmark.md', import.meta.url), 'utf8');
    const links = [...document.matchAll(/\[контракт движения\]\(([^)]+)\)/g)];
    expect(links).toHaveLength(1);
    const target = posix.normalize(posix.join('docs', links[0]![1]!));
    expect(target).toBe('docs/motion-conformance.md');
    expect(publishedDocs).toContain(target);
    expect(readFileSync(new URL(`../${target}`, import.meta.url), 'utf8').length).toBeGreaterThan(0);
  });

  it.each([['контракт-v1', false], ['повреждённый контракт', true]])(
    'исполняемый readback отклоняет повреждённый документ: %s', (packed, expectedFailure) => {
      const start = smoke.indexOf('  const installedMotionContract =');
      const end = smoke.indexOf('  if (existsSync(installedBenchmark)', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
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
