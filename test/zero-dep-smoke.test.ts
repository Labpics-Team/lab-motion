import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORE_GATE_BYTES } from '../scripts/size-gate.mjs';
import { canonicalGzip } from '../scripts/compression-oracle.mjs';

/**
 * Дымовой контракт поставки: ноль runtime-зависимостей и внешних импортов,
 * размер корневого ESM не обходит общий размерный эталон, обязательные экспорты
 * присутствуют в собранном артефакте.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  name: string;
};

/** Lazily read dist/index.js inside each test body that needs it.
 *  Top-level readFileSync would throw ENOENT on a clean checkout before `pnpm build`. */
function readDist(): string {
  return readFileSync(resolve(pkgRoot, 'dist/index.js'), 'utf8');
}

describe('zero-dep + bundle-size smoke (invariant 1)', () => {
  it('package.json has no runtime dependencies', () => {
    const deps = pkg.dependencies ?? {};
    expect(
      Object.keys(deps),
      `@labpics/motion must have zero runtime deps. Found: ${Object.keys(deps).join(', ')}`,
    ).toHaveLength(0);
  });

  it('built dist/index.js contains no external imports', () => {
    const distJs = readDist();
    // Match any `import ... from "something"` where "something" is not a
    // relative path (starts with . or /) — i.e. an external package.
    const externalImports = [...distJs.matchAll(/from\s+["']([^./"'][^"']*)/g)].map(
      (m) => m[1] ?? '',
    );
    expect(
      externalImports,
      `External imports found in dist: ${externalImports.join(', ')}`,
    ).toHaveLength(0);
  });

  it('корневой ESM использует канонический gzip и единый CORE-порог', () => {
    const distJs = readDist();
    const gz = canonicalGzip(Buffer.from(distJs, 'utf8')).length;
    console.info(`[@labpics/motion] dist/index.js canonical gzip size: ${gz} bytes`);
    expect(gz).toBeLessThanOrEqual(CORE_GATE_BYTES);
  });

  it('dist/index.js exports the required engine names', () => {
    const distJs = readDist();
    // Разбираем обе формы именованных ESM-экспортов, чтобы не зависеть от выбора минификатора.
    const exportMatches = [...distJs.matchAll(/export\s*\{([^}]+)\}/g)];
    const exportedNames = exportMatches
      .flatMap((m) =>
        (m[1] ?? '').split(',').map(
          (s) =>
            s
              .trim()
              .split(/\s+as\s+/)
              .pop() ?? '',
        ),
      )
      .filter(Boolean);

    // Also catch `export function foo` and `export class Foo` and `export const foo`.
    const namedExports = [
      ...distJs.matchAll(/export\s+(?:function|class|const|let|var)\s+(\w+)/g),
    ].map((m) => m[1] ?? '');
    const allExported = new Set([...exportedNames, ...namedExports]);

    const REQUIRED = ['spring', 'tween', 'drive', 'MotionParamError'];
    const missing = REQUIRED.filter((name) => !allExported.has(name));
    expect(
      missing,
      `dist/index.js is missing required engine exports: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});
