import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/check-release-artifact.mjs', import.meta.url));
const VERSION = '9.8.7';
const TAG = `v${VERSION}`;
const SHA = 'a'.repeat(40);
const workspaces: string[] = [];

function releaseMetadata() {
  return {
    name: '@labpics/motion',
    version: VERSION,
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
    },
    files: [
      'dist',
      'docs/errors.md',
      'docs/benchmark.md',
      'docs/recipes.md',
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

function archive(
  overrides: Record<string, unknown> = {},
  fileName = `labpics-motion-${VERSION}.tgz`,
) {
  const work = mkdtempSync(join(tmpdir(), 'labmotion-release-artifact-'));
  workspaces.push(work);
  const packageDirectory = join(work, 'package');
  mkdirSync(packageDirectory);
  writeFileSync(join(work, 'root-package.json'), JSON.stringify(releaseMetadata()));
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      ...releaseMetadata(),
      ...overrides,
    }),
  );
  const tarball = join(work, fileName);
  execFileSync('tar', ['-czf', tarball, '-C', work, 'package']);
  return { work, tarball, manifest: join(work, 'release-manifest.json') };
}

function check(
  tarball: string,
  manifest: string,
  tag = TAG,
  sha = SHA,
) {
  return spawnSync(process.execPath, [
    SCRIPT,
    tarball,
    tag,
    sha,
    manifest,
    join(dirname(tarball), 'root-package.json'),
  ], {
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const work of workspaces.splice(0)) rmSync(work, { recursive: true, force: true });
});

describe('release artifact: fail-closed манифест', () => {
  it('фиксирует идентичность и digest проверенного tgz', () => {
    const { tarball, manifest } = archive();
    const result = check(tarball, manifest);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`package_identity=@labpics/motion@${VERSION}`);
    const sealed = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(sealed).toMatchObject({
      schema: 1,
      package: { name: '@labpics/motion', version: VERSION },
      release: { tag: TAG, sourceSha: SHA },
      artifact: { file: `labpics-motion-${VERSION}.tgz` },
    });
    expect(sealed.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['чужое имя', { name: '@attacker/motion' }],
    ['private-пакет', { private: true }],
    ['непубличный access', { publishConfig: { access: 'restricted' } }],
    ['чужой репозиторий', { repository: { url: 'https://example.test/repo.git' } }],
    ['версия вне тега', { version: '9.8.6' }],
  ])('отвергает %s', (_label, overrides) => {
    const { tarball, manifest } = archive(overrides);
    const result = check(tarball, manifest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release-artifact-check:');
  });

  it('отвергает неверные tag, SHA и имя архива', () => {
    const invalidTag = archive();
    expect(check(invalidTag.tarball, invalidTag.manifest, 'release-9.8.7').status).not.toBe(0);

    const invalidSha = archive();
    expect(check(invalidSha.tarball, invalidSha.manifest, TAG, 'abc').status).not.toBe(0);

    const invalidName = archive({}, 'candidate.tgz');
    expect(check(invalidName.tarball, invalidName.manifest).status).not.toBe(0);
  });

  it('не перезаписывает уже созданный манифест', () => {
    const { tarball, manifest } = archive();
    writeFileSync(manifest, '{"trusted":false}\n');

    const result = check(tarball, manifest);
    expect(result.status).not.toBe(0);
    expect(readFileSync(manifest, 'utf8')).toBe('{"trusted":false}\n');
  });
});
