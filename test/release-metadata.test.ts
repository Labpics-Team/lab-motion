import { describe, expect, it } from 'vitest';
import {
  readReleaseChangelogDate,
  validateArchiveMetadata,
  validateReleaseChangelog,
  validateReleaseMetadata,
} from '../scripts/release-metadata.mjs';

function metadata() {
  return {
    name: '@labpics/motion',
    version: '0.3.0',
    private: false,
    description: 'Headless zero-dependency motion engine: analytic spring solver, keyframes, timeline, FLIP, gestures, WAAPI compositor path, 9 framework bindings.',
    author: 'Labpics',
    keywords: ['animation', 'motion', 'spring', 'physics', 'keyframes', 'timeline', 'flip', 'waapi', 'headless', 'zero-dependency'],
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'git+https://github.com/Labpics-Team/lab-motion.git',
    },
    engines: { node: '>=22' },
    packageManager: 'pnpm@11.11.0',
    type: 'module',
    main: './dist/index.cjs',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    imports: {
      '#frame': { import: './dist/frame/index.js', require: './dist/frame/index.cjs' },
    },
    typesVersions: { '*': { '*': ['dist/*/index.d.ts'] } },
    exports: {
      '.': {
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
      },
      './compositor/stagger': {
        import: {
          types: './dist/compositor/stagger/index.d.ts',
          default: './dist/compositor/stagger/index.js',
        },
        require: {
          types: './dist/compositor/stagger/index.d.cts',
          default: './dist/compositor/stagger/index.cjs',
        },
      },
    },
    files: [
      'dist',
      'docs/errors.md',
      'docs/benchmark.md',
      'docs/recipes.md',
      // #91/#96 (2026-07-22): docs-суит и машиночитаемый API в артефакте.
      'docs/getting-started.md',
      'docs/reference',
      'docs/migration',
      'docs/explanations',
      'api-manifest.json',
      'llms.txt',
      '!dist/**/*.map',
    ],
    publishConfig: { access: 'public' },
    sideEffects: [
      './dist/lit/index.js',
      './dist/lit/index.cjs',
      './dist/wc/index.js',
      './dist/wc/index.cjs',
    ],
    scripts: { build: 'tsup' },
    peerDependencies: {
      '@angular/core': '>=16.0.0',
      '@builder.io/qwik': '>=1.4.0',
      lit: '>=3.0.0',
      preact: '>=10.3.1',
      react: '>=18.0.0',
      'solid-js': '>=1.8.0',
      svelte: '>=4.0.0',
      vue: '>=3.0.0',
    },
    peerDependenciesMeta: {
      lit: { optional: true },
      react: { optional: true },
      svelte: { optional: true },
      vue: { optional: true },
      'solid-js': { optional: true },
      preact: { optional: true },
      '@angular/core': { optional: true },
      '@builder.io/qwik': { optional: true },
    },
  };
}

describe('release metadata SSOT', () => {
  it('accepts the exact public package contract', () => {
    expect(() => validateReleaseMetadata(metadata())).not.toThrow();
    expect(() => validateArchiveMetadata(metadata(), structuredClone(metadata()))).not.toThrow();
  });

  it('принимает единственную документированную нормализацию pnpm pack', () => {
    const root = metadata() as any;
    const archive = structuredClone(root);
    delete archive.packageManager;
    expect(() => validateArchiveMetadata(root, archive)).not.toThrow();
  });

  it('не маскирует неверный packageManager под нормализацию pnpm pack', () => {
    const root = metadata() as any;
    const archive = structuredClone(root);
    archive.packageManager = 'pnpm@0.0.0';
    expect(() => validateArchiveMetadata(root, archive)).toThrow(/packageManager/);
  });

  it.each([
    ['publish registry', (pkg: any) => { pkg.publishConfig.registry = 'https://evil.test'; }],
    ['publish tag', (pkg: any) => { pkg.publishConfig.tag = 'next'; }],
    ['runtime dependency', (pkg: any) => { pkg.dependencies = {}; }],
    ['optional dependency', (pkg: any) => { pkg.optionalDependencies = {}; }],
    ['bundled dependency', (pkg: any) => { pkg.bundleDependencies = []; }],
    ['binary entry', (pkg: any) => { pkg.bin = { motion: './steal.js' }; }],
    ['platform filter', (pkg: any) => { pkg.os = ['linux']; }],
    ['cpu filter', (pkg: any) => { pkg.cpu = ['x64']; }],
    ['libc filter', (pkg: any) => { pkg.libc = ['glibc']; }],
    ['bundler override', (pkg: any) => { pkg.browser = './steal.js'; }],
    ['react native override', (pkg: any) => { pkg['react-native'] = './steal.js'; }],
    ['CDN override', (pkg: any) => { pkg.unpkg = './steal.js'; }],
    ['unknown resolver override', (pkg: any) => { pkg.source = './steal.js'; }],
    ['consumer install hook', (pkg: any) => { pkg.scripts.install = 'node steal.mjs'; }],
    ['pack hook', (pkg: any) => { pkg.scripts.prepare = 'pnpm build'; }],
    ['parallel publish path', (pkg: any) => { pkg.scripts.prepublishOnly = 'pnpm build'; }],
    ['missing benchmark methodology', (pkg: any) => {
      pkg.files = pkg.files.filter((file: string) => file !== 'docs/benchmark.md');
    }],
    ['missing referenced recipes', (pkg: any) => {
      pkg.files = pkg.files.filter((file: string) => file !== 'docs/recipes.md');
    }],
    ['wrong Node floor', (pkg: any) => { pkg.engines.node = '>=24'; }],
    ['missing peer', (pkg: any) => { delete pkg.peerDependencies.react; }],
    ['description drift', (pkg: any) => { pkg.description = 'faster'; }],
    ['keyword drift', (pkg: any) => { pkg.keywords.pop(); }],
    ['non-optional peer', (pkg: any) => { pkg.peerDependenciesMeta.react.optional = false; }],
    ['wildcard export', (pkg: any) => { pkg.exports['./*'] = './dist/*'; }],
  ])('rejects %s', (_label, mutate) => {
    const pkg = metadata();
    mutate(pkg);
    expect(() => validateReleaseMetadata(pkg)).toThrow();
  });

  it.each(['version', 'exports', 'typesVersions', 'sideEffects', 'files', 'peerDependencies'])
  ('rejects archive drift in %s', (field) => {
    const root = metadata() as any;
    const archive = structuredClone(root);
    if (field === 'version') archive.version = '0.3.1';
    else if (field === 'exports') archive.exports['./compositor/stagger'].import.default = './dist/other.js';
    else if (field === 'typesVersions') archive.typesVersions = { '*': { '*': ['wrong'] } };
    else if (field === 'sideEffects') archive.sideEffects = [];
    else if (field === 'files') archive.files = [...archive.files].reverse();
    else archive.peerDependencies.react = '>=19.0.0';
    expect(() => validateArchiveMetadata(root, archive)).toThrow();
  });
});

describe('release changelog truth', () => {
  const current = (date = '2026-07-13') =>
    `# Журнал изменений\n\n## [0.3.0] — ${date}\n\n- Готово.\n`;

  it('принимает ровно одну секцию версии с датой release intent', () => {
    expect(readReleaseChangelogDate(current(), '0.3.0')).toBe('2026-07-13');
    expect(() => validateReleaseChangelog(current(), '0.3.0', '2026-07-13')).not.toThrow();
  });

  it.each(['2000-02-29', '2024-02-29'])('принимает календарную дату %s', (date) => {
    expect(() => validateReleaseChangelog(current(date), '0.3.0', date)).not.toThrow();
  });

  it.each([
    ['устаревшую дату', current(), '0.3.0', '2026-07-14'],
    ['отсутствующую версию', current(), '0.3.1', '2026-07-13'],
    ['нулевой день', current('2026-02-00'), '0.3.0', '2026-02-00'],
    ['29 февраля невисокосного года', current('2026-02-29'), '0.3.0', '2026-02-29'],
    ['29 февраля невисокосного века', current('1900-02-29'), '0.3.0', '1900-02-29'],
    ['30 февраля', current('2026-02-30'), '0.3.0', '2026-02-30'],
    [
      'дубликат секции версии',
      `${current()}\n## [0.3.0] — 2026-07-13\n`,
      '0.3.0',
      '2026-07-13',
    ],
  ])('отклоняет %s', (_label, changelog, version, releaseDate) => {
    expect(() => validateReleaseChangelog(changelog, version, releaseDate)).toThrow();
  });
});
