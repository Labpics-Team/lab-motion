/**
 * Свежесть dist — контракт пакета, а не ESM-эвристика: каждый отправляемый
 * файл dist должен быть не старше любого входа сборки, а каждая публичная
 * export-цель обязана существовать.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_INPUTS = ['tsup.config.ts', 'tsconfig.json', 'package.json', 'pnpm-lock.yaml'];

interface Stamp {
  at: number;
  file: string;
}

function includeMtime(path: string, into: Stamp): void {
  const at = statSync(path).mtimeMs;
  if (at > into.at) {
    into.at = at;
    into.file = path;
  }
}

function newestMtime(dir: string, into: Stamp): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newestMtime(path, into);
    else if (entry.isFile()) includeMtime(path, into);
  }
}

function oldestMtime(dir: string, into: Stamp): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) oldestMtime(path, into);
    else if (entry.isFile()) {
      const at = statSync(path).mtimeMs;
      if (at < into.at) {
        into.at = at;
        into.file = path;
      }
    }
  }
}

function exportedBuildTargets(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports?: unknown;
  };
  const targets = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('./dist/')) targets.add(join(root, value));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(pkg.exports);
  if (targets.size === 0) throw new Error('package.json не содержит dist-целей exports');
  return [...targets];
}

function freshness(root: string): { source: Stamp; output: Stamp } {
  const source: Stamp = { at: 0, file: '' };
  newestMtime(join(root, 'src'), source);
  for (const file of BUILD_INPUTS) includeMtime(join(root, file), source);

  // Export-цели доказывают полноту публичного графа; рекурсивный минимум
  // ловит stale hashed-чанки деклараций и остальные отправляемые dist-файлы.
  for (const file of exportedBuildTargets(root)) {
    if (!existsSync(file)) throw new Error(`dist-цель exports отсутствует: ${file}`);
  }
  const output: Stamp = { at: Number.POSITIVE_INFINITY, file: '' };
  oldestMtime(join(root, 'dist'), output);
  if (output.file === '') throw new Error('dist не содержит собранных файлов');
  return { source, output };
}

describe('dist: свежесть собранных артефактов', () => {
  it('каждая runtime-ветка и декларация exports не старше входов сборки', () => {
    const { source, output } = freshness(ROOT);
    expect(
      output.at >= source.at,
      `dist старше входов сборки: ${source.file} новее ${output.file} — выполните pnpm build`,
    ).toBe(true);
  });
});

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function fixture(): {
  root: string;
  input: (name: string) => string;
  output: (name: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), 'labmotion-dist-freshness-'));
  workspaces.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'dist'));
  const files = {
    'src/index.ts': 'export const value = 1;\n',
    'tsup.config.ts': 'export default {};\n',
    'tsconfig.json': '{}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'package.json': JSON.stringify({
      exports: {
        '.': {
          import: { types: './dist/index.d.ts', default: './dist/index.js' },
          require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
        },
      },
    }),
    'dist/index.js': '',
    'dist/index.cjs': '',
    'dist/index.d.ts': '',
    'dist/index.d.cts': '',
    'dist/shared-types.d.ts': '',
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  const sourceTime = new Date(1_000_000);
  const outputTime = new Date(2_000_000);
  for (const name of Object.keys(files)) {
    const time = name.startsWith('dist/') ? outputTime : sourceTime;
    utimesSync(join(root, name), time, time);
  }
  return {
    root,
    input: (name) => join(root, name),
    output: (name) => join(root, 'dist', name),
  };
}

describe('dist freshness: false-green regression matrix', () => {
  it.each(['index.cjs', 'index.d.ts', 'index.d.cts', 'shared-types.d.ts'])(
    'видит stale %s при свежем ESM',
    (name) => {
      const f = fixture();
      const stale = new Date(500_000);
      utimesSync(f.output(name), stale, stale);

      expect(freshness(f.root).output.file).toBe(f.output(name));
      expect(freshness(f.root).output.at).toBeLessThan(freshness(f.root).source.at);
    },
  );

  it.each(['tsconfig.json', 'pnpm-lock.yaml'])('видит изменение build input %s', (name) => {
    const f = fixture();
    const changed = new Date(3_000_000);
    utimesSync(f.input(name), changed, changed);

    const state = freshness(f.root);
    expect(state.source.file).toBe(f.input(name));
    expect(state.output.at).toBeLessThan(state.source.at);
  });
});
