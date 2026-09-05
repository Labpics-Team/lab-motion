import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBenchmarkExportSurface,
  assertFileHashesUnchanged,
  assertCheckoutUnchanged,
  assertInstalledPackageTreesUnchanged,
  formatProvenanceMarkdown,
  hashFileTree,
  prepareBenchmarkCheckout,
  captureBenchmarkEnvironment,
  readCheckoutState,
  revisionFingerprint,
  sha256File,
} from '../bench/compare/provenance.mjs';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-motion-provenance-'));
  cleanup.push(root);
  const benchDirectory = path.join(root, 'bench', 'compare');
  const distDirectory = path.join(root, 'dist', 'animate');
  mkdirSync(benchDirectory, { recursive: true });
  mkdirSync(distDirectory, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'root',
    exports: {
      '.': './dist/index.js',
      './animate': './dist/animate/index.js',
      './nano': './dist/nano/index.js',
    },
  }));
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'root-lock');
  writeFileSync(path.join(benchDirectory, 'package.json'), '{"name":"bench"}');
  writeFileSync(path.join(benchDirectory, 'pnpm-lock.yaml'), 'bench-lock');
  writeFileSync(path.join(distDirectory, 'index.js'), 'stale');
  const state = {
    revision: 'a'.repeat(40),
    shortRevision: 'a'.repeat(12),
    revisionLabel: 'a'.repeat(12),
    dirty: false,
    worktreeSha256: 'b'.repeat(64),
  };
  return { root, benchDirectory, distDirectory, state };
}

function checkoutFixture(autocrlf = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab-motion-tracked-proof-'));
  cleanup.push(directory);
  const source = path.join(directory, 'source');
  const root = path.join(directory, 'checkout');
  mkdirSync(source);
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(source, ['init', '--quiet']);
  git(source, ['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(source, '.gitignore'), 'dist/\n');
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', exports: { './animate': './dist/animate/index.js' } }) + '\n');
  writeFileSync(path.join(source, 'pnpm-lock.yaml'), 'fixture-lock\n');
  writeFileSync(path.join(source, 'source.js'), 'export const value = 1;\n');
  writeFileSync(path.join(source, 'binary.bin'), Buffer.from([0, 10, 1]));
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Benchmark test', '-c', 'user.email=benchmark@example.invalid',
    '-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`, 'commit', '--quiet', '-m', 'fixture']);
  git(directory, ['clone', '--quiet', '--no-hardlinks', '--config', `core.autocrlf=${autocrlf}`, source, root]);
  mkdirSync(path.join(root, 'dist', 'animate'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'animate', 'index.js'), 'runtime');
  return { root, git: (args: string[]) => git(root, args), prepare: {
    root, benchDirectory: root, requiredDist: ['dist/animate/index.js'],
    captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
  } };
}

describe('benchmark provenance', () => {
  it.each(['--assume-unchanged', '--skip-worktree'])('rejects hidden source bytes before build: %s', (flag) => {
    const f = checkoutFixture();
    const revision = f.git(['rev-parse', 'HEAD']).trim();
    f.git(['update-index', flag, '--', 'source.js']);
    writeFileSync(path.join(f.root, 'source.js'), 'export const value = 2;\n');
    expect(f.git(['status', '--porcelain'])).toBe('');
    expect(f.git(['rev-parse', 'HEAD']).trim()).toBe(revision);
    let builds = 0;
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build: () => { builds++; } }))
      .toThrow(/tracked|revision|коммит/);
    expect(builds).toBe(0);
  });

  it('accepts actual CRLF checkouts while retaining the committed canonical fingerprint', () => {
    const f = checkoutFixture(true);
    expect(f.git(['ls-files', '--eol', '--', 'source.js'])).toContain('w/crlf');
    const state = readCheckoutState(f.root);
    expect(state.dirty).toBe(false);
    const canonical = revisionFingerprint(f.root, state.revision);
    // Отпечаток исходной LF-фикстуры закрепляет совместимость формата, не CRLF-байты clone.
    expect(canonical).toBe('6c85545764a91d47528b8eb7f790ee2525371bfb9341e8d8c8c42f31c8b39ae0');
    expect(state.trackedRevisionSha256).toBe(canonical);
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build() {} })).not.toThrow();
  });

  it.each(['build', 'run'])('rejects hidden source mutations after %s', (phase) => {
    const f = checkoutFixture(true);
    f.git(['update-index', '--skip-worktree', '--', 'source.js']);
    const mutate = () => writeFileSync(path.join(f.root, 'source.js'), 'export const value = 2;\r\n');
    if (phase === 'build') {
      expect(() => prepareBenchmarkCheckout({ ...f.prepare, build: mutate })).toThrow(/tracked|revision|коммит|checkout/);
    } else {
      const prepared = prepareBenchmarkCheckout({ ...f.prepare, build() {} });
      mutate();
      expect(() => assertCheckoutUnchanged(f.root, prepared)).toThrow(/tracked|revision|коммит|checkout/);
    }
    expect(f.git(['status', '--porcelain'])).toBe('');
  });

  it('does not normalize binary changes as legitimate CRLF conversion', () => {
    const f = checkoutFixture(true);
    f.git(['update-index', '--assume-unchanged', '--', 'binary.bin']);
    writeFileSync(path.join(f.root, 'binary.bin'), Buffer.from([0, 13, 10, 1]));
    expect(f.git(['status', '--porcelain'])).toBe('');
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build() {} })).toThrow(/tracked|revision|коммит/);
  });

  it('rejects a missing skip-worktree source instead of omitting it from the fingerprint', () => {
    const f = checkoutFixture();
    f.git(['update-index', '--skip-worktree', '--', 'source.js']);
    unlinkSync(path.join(f.root, 'source.js'));
    expect(f.git(['status', '--porcelain'])).toBe('');
    let builds = 0;
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build: () => { builds++; } })).toThrow(/tracked.*source.js/);
    expect(builds).toBe(0);
  });

  it('does not trust a lossy custom clean filter to prove the committed source', () => {
    const f = checkoutFixture();
    f.git(['config', 'filter.mask.clean', 'git show HEAD:source.js']);
    writeFileSync(path.join(f.root, '.git', 'info', 'attributes'), 'source.js filter=mask\n');
    f.git(['update-index', '--assume-unchanged', '--', 'source.js']);
    writeFileSync(path.join(f.root, 'source.js'), 'export const value = 999;\n');
    const altered = f.git(['hash-object', '-w', '--no-filters', '--', 'source.js']).trim();
    f.git(['config', 'filter.mask.smudge', `git cat-file blob ${altered}`]);
    expect(f.git(['cat-file', '--filters', 'HEAD:source.js'])).toBe('export const value = 999;\n');
    expect(f.git(['status', '--porcelain'])).toBe('');
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build() {} })).toThrow(/неподдерживаемое преобразование/);
  });

  it('preserves path identity for CRLF files with spaces in the object batch', () => {
    const f = checkoutFixture(true);
    const file = path.join(f.root, 'with space.js');
    writeFileSync(file, 'export const space = 1;\n');
    f.git(['add', '--', 'with space.js']);
    f.git(['-c', 'user.name=Benchmark test', '-c', 'user.email=benchmark@example.invalid',
      '-c', `core.hooksPath=${path.join(f.root, 'no-hooks')}`, 'commit', '--quiet', '-m', 'space fixture']);
    writeFileSync(file, 'export const space = 1;\r\n');
    f.git(['add', '--renormalize', '--', 'with space.js']);
    expect(f.git(['show', 'HEAD:with space.js'])).toBe('export const space = 1;\n');
    expect(f.git(['config', '--get', 'core.autocrlf']).trim()).toBe('true');
    expect(f.git(['status', '--porcelain'])).toBe('');
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build() {} })).not.toThrow();
    f.git(['update-index', '--assume-unchanged', '--', 'with space.js']);
    writeFileSync(file, 'export const space = 2;\r\n');
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build() {} })).toThrow(/tracked with space.js/);
  });

  it('ignores replacement refs when proving the declared commit bytes', () => {
    const f = checkoutFixture();
    const original = f.git(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(f.root, 'source.js'), 'export const value = 999;\n');
    f.git(['add', '--', 'source.js']);
    f.git(['-c', 'user.name=Benchmark test', '-c', 'user.email=benchmark@example.invalid',
      '-c', `core.hooksPath=${path.join(f.root, 'no-hooks')}`, 'commit', '--quiet', '-m', 'replacement fixture']);
    const replacement = f.git(['rev-parse', 'HEAD']).trim();
    f.git(['update-ref', 'HEAD', original]);
    f.git(['replace', original, replacement]);
    expect(f.git(['status', '--porcelain'])).toBe('');
    expect(revisionFingerprint(f.root, original)).toBe('6c85545764a91d47528b8eb7f790ee2525371bfb9341e8d8c8c42f31c8b39ae0');
    expect(() => prepareBenchmarkCheckout({ ...f.prepare, build() {} })).toThrow(/clean checkout|tracked|revision/);
  });

  it('rejects requiredDist and benchmark entries outside published exports', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({
      exports: {
        './animate': {
          import: { default: './dist/animate/index.js' },
          require: { default: './dist/animate/index.cjs' },
        },
      },
    }));
    const entry = path.join(f.benchDirectory, 'entry.mjs');
    writeFileSync(entry, "import { animate } from '../../dist/animate/index.js';\n");

    expect(() => assertBenchmarkExportSurface({
      root: f.root,
      requiredDist: ['dist/animate/index.js'],
      requiredEntries: [['bench/entry.mjs', entry]],
    })).not.toThrow();
    expect(() => assertBenchmarkExportSurface({
      root: f.root,
      requiredDist: [],
      requiredEntries: [['bench/entry.mjs', entry]],
    })).toThrow(/animate\/index.*requiredDist/i);
    expect(() => assertBenchmarkExportSurface({
      root: f.root,
      requiredDist: ['dist/animate/native/index.js'],
      requiredEntries: [],
    })).toThrow(/requiredDist.*animate\/native.*export/i);

    writeFileSync(entry, "import { springTo } from '../../dist/animate/native/index.js';\n");
    expect(() => assertBenchmarkExportSurface({
      root: f.root,
      requiredDist: ['dist/animate/index.js'],
      requiredEntries: [['bench/entry.mjs', entry]],
    })).toThrow(/bench\/entry\.mjs.*export.*animate\/native/i);
  });

  it('runs the export-surface guard before an expensive benchmark build', () => {
    const f = fixture();
    const entry = path.join(f.benchDirectory, 'entry.mjs');
    writeFileSync(entry, "import { springTo } from '../../dist/animate/native/index.js';\n");
    let builds = 0;

    expect(() => prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      requiredDist: ['dist/animate/index.js'],
      requiredEntries: [['bench/entry.mjs', entry]],
      build: () => { builds++; },
      readState: () => f.state,
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    })).toThrow(/bench\/entry\.mjs.*animate\/native/i);
    expect(builds).toBe(0);
  });

  it('включает symlink target в tree fingerprint, не следуя за ним наружу', () => {
    const f = fixture();
    const tree = path.join(f.root, 'browser-tree');
    mkdirSync(tree);
    writeFileSync(path.join(tree, 'v1'), 'same');
    writeFileSync(path.join(tree, 'v2'), 'same');
    const current = path.join(tree, 'Current');
    symlinkSync('v1', current);
    const before = hashFileTree(tree);
    unlinkSync(current);
    symlinkSync('v2', current);
    expect(hashFileTree(tree).sha256).not.toBe(before.sha256);
  });

  it('хеширует только пересобранный dist и фиксирует lock/package inputs', () => {
    const f = fixture();
    let builds = 0;
    const prepared = prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      requiredDist: ['dist/animate/index.js'],
      build() {
        builds++;
        writeFileSync(path.join(f.distDirectory, 'index.js'), 'fresh-runtime');
        writeFileSync(path.join(f.distDirectory, 'index.cjs'), 'fresh-cjs');
        // Декларации не являются исполняемыми байтами и в runtime-tree не входят.
        writeFileSync(path.join(f.distDirectory, 'index.d.ts'), 'declare const x: 1');
      },
      readState: () => f.state,
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    });

    expect(builds).toBe(1);
    expect(prepared.distRuntime).toEqual(
      hashFileTree(path.join(f.root, 'dist'), (file: string) => /\.(?:c?js|mjs)$/.test(file)),
    );
    expect(prepared.distRuntime.files).toBe(2);
    expect(prepared.inputs['root/package.json']).toBe(sha256File(path.join(f.root, 'package.json')));
    expect(prepared.inputs['bench/pnpm-lock.yaml']).toBe(
      sha256File(path.join(f.benchDirectory, 'pnpm-lock.yaml')),
    );
  });

  it('не принимает сборку без обязательного runtime-файла', () => {
    const f = fixture();
    expect(() => prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      requiredDist: ['dist/nano/index.js'],
      build() {},
      readState: () => f.state,
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    })).toThrow(/сборка не создала обязательный файл/);
  });

  it('pins caller-owned benchmark inputs without imposing comparative layout on other benches', () => {
    const f = fixture();
    expect(() => prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      build() {},
      readState: () => f.state,
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    })).not.toThrow();
    expect(() => prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      requiredInputs: [['bench/methodology.mjs', path.join(f.benchDirectory, 'missing.mjs')]],
      build() {},
      readState: () => f.state,
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    })).toThrow(/missing\.mjs/);
  });

  it('refuses a dirty checkout before build and a build that dirties tracked inputs', () => {
    const f = fixture();
    let builds = 0;
    expect(() => prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      build: () => { builds++; },
      readState: () => ({ ...f.state, dirty: true, revisionLabel: `${f.state.shortRevision}-dirty` }),
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    })).toThrow(/clean checkout/);
    expect(builds).toBe(0);

    let reads = 0;
    expect(() => prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      build: () => { builds++; },
      readState: () => reads++ === 0 ? f.state : {
        ...f.state,
        dirty: true,
        revisionLabel: `${f.state.shortRevision}-dirty`,
        worktreeSha256: 'c'.repeat(64),
      },
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    })).toThrow(/изменила checkout/);
  });

  it('allows an explicitly diagnostic dirty run but still rejects mid-run mutation', () => {
    const f = fixture();
    const dirty = { ...f.state, dirty: true, revisionLabel: `${f.state.shortRevision}-dirty` };
    expect(() => prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      requireClean: false,
      build() {},
      readState: () => dirty,
      captureEnvironment: () => ({ node: 'v24.0.0', pnpm: '11.11.0', packages: {} }),
    })).not.toThrow();
  });

  it('pins Node/pnpm and hashes the actual installed benchmark packages', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.11.0' }));
    writeFileSync(path.join(f.benchDirectory, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.11.0',
      devDependencies: { vendor: '1.2.3' },
    }));
    const vendor = path.join(f.benchDirectory, 'node_modules', 'vendor');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ name: 'vendor', version: '1.2.3' }));
    writeFileSync(path.join(vendor, 'index.js'), 'export const x = 1;');

    const env = captureBenchmarkEnvironment(f.root, f.benchDirectory, ['vendor'], {
      nodeVersion: 'v24.9.0',
      pnpmVersion: '11.11.0',
    });
    expect(env.node).toBe('v24.9.0');
    expect(env.pnpm).toBe('11.11.0');
    expect(env.packages.vendor.version).toBe('1.2.3');
    expect(env.packages.vendor.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => captureBenchmarkEnvironment(f.root, f.benchDirectory, ['vendor'], {
      nodeVersion: 'v26.0.0', pnpmVersion: '11.11.0',
    })).toThrow(/Node 24/);
    expect(() => captureBenchmarkEnvironment(f.root, f.benchDirectory, ['vendor'], {
      nodeVersion: 'v24.9.0', pnpmVersion: '11.7.0',
    })).toThrow(/pnpm 11\.11\.0/);

    writeFileSync(path.join(f.benchDirectory, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.10.0',
      devDependencies: { vendor: '1.2.3' },
    }));
    expect(() => captureBenchmarkEnvironment(f.root, f.benchDirectory, ['vendor'], {
      nodeVersion: 'v24.9.0', pnpmVersion: '11.11.0',
    })).toThrow(/packageManager.*bench/i);
  });

  it('фиксирует exact root-кодек и отвергает подмену его версии или дерева', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.11.0',
      devDependencies: { pako: '3.0.1' },
    }));
    writeFileSync(path.join(f.benchDirectory, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@11.11.0',
    }));
    const codec = path.join(f.root, 'node_modules', 'pako');
    mkdirSync(codec, { recursive: true });
    writeFileSync(path.join(codec, 'package.json'), JSON.stringify({ name: 'pako', version: '3.0.0' }));
    writeFileSync(path.join(codec, 'index.js'), 'export const gzip = 1;');

    const options = {
      nodeVersion: 'v24.9.0',
      pnpmVersion: '11.11.0',
      requiredRootPackages: ['pako'],
    };
    expect(() => captureBenchmarkEnvironment(f.root, f.benchDirectory, [], options))
      .toThrow(/pako.*3\.0\.1.*3\.0\.0/);

    writeFileSync(path.join(codec, 'package.json'), JSON.stringify({ name: 'pako', version: '3.0.1' }));
    const prepared = prepareBenchmarkCheckout({
      root: f.root,
      benchDirectory: f.benchDirectory,
      build() {},
      readState: () => f.state,
      requiredRootPackages: ['pako'],
      captureEnvironment: (root, benchDirectory) => (
        captureBenchmarkEnvironment(root, benchDirectory, [], options)
      ),
    });
    expect(prepared.environment.rootPackages.pako).toMatchObject({
      version: '3.0.1',
      files: 2,
    });
    expect(prepared.environment.rootPackages.pako.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertInstalledPackageTreesUnchanged(f.root, prepared.environment.rootPackages))
      .not.toThrow();

    writeFileSync(path.join(codec, 'index.js'), 'export const gzip = 2;');
    expect(() => assertInstalledPackageTreesUnchanged(f.root, prepared.environment.rootPackages))
      .toThrow(/pako.*измен/i);
  });

  it('re-hashes generated runtime adapters after the benchmark', () => {
    const f = fixture();
    const adapter = path.join(f.root, 'adapter.iife.js');
    writeFileSync(adapter, 'runtime-v1');
    const artifacts = { lab: { path: adapter, sha256: sha256File(adapter) } };
    expect(() => assertFileHashesUnchanged(artifacts)).not.toThrow();
    writeFileSync(adapter, 'runtime-v2');
    expect(() => assertFileHashesUnchanged(artifacts)).toThrow(/lab.*измен/i);
  });

  it('отбрасывает результат, если checkout или dist изменились во время замера', () => {
    const f = fixture();
    const prepared = {
      ...f.state,
      distRuntime: hashFileTree(path.join(f.root, 'dist'), (file: string) => /\.(?:c?js|mjs)$/.test(file)),
    };
    expect(() => assertCheckoutUnchanged(f.root, prepared, () => f.state)).not.toThrow();
    expect(() => assertCheckoutUnchanged(f.root, prepared, () => ({
      ...f.state,
      worktreeSha256: 'c'.repeat(64),
    }))).toThrow(/checkout или dist изменился/);

    writeFileSync(path.join(f.distDirectory, 'index.js'), 'changed-during-benchmark');
    expect(() => assertCheckoutUnchanged(f.root, prepared, () => f.state))
      .toThrow(/checkout или dist изменился/);
  });

  it('пишет dirty-маркер и хеши dist/адаптеров в отчёт', () => {
    const f = fixture();
    const prepared = {
      ...f.state,
      dirty: true,
      revisionLabel: `${f.state.shortRevision}-dirty`,
      builtAt: '2026-07-12T00:00:00.000Z',
      inputs: { 'root/package.json': '1'.repeat(64) },
      distRuntime: { files: 2, sha256: '2'.repeat(64) },
    };
    const markdown = formatProvenanceMarkdown(prepared, {
      lab: { runtimeSha256: '3'.repeat(64), sizeBundleSha256: '4'.repeat(64) },
    });

    expect(markdown).toContain('**dirty**');
    expect(markdown).toContain(prepared.revisionLabel);
    expect(markdown).toContain(prepared.distRuntime.sha256);
    expect(markdown).toContain('3'.repeat(64));
    expect(markdown).toContain('4'.repeat(64));
  });
});
