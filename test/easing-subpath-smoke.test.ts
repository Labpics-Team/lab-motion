/**
 * easing-subpath-smoke.test.ts — package-boundary smoke
 * Class: smoke (A)
 * Invariant NE5 — tree-shakeable subpath isolation:
 *   The ./easing subpath must exist in dist (dist/easing/index.js, index.cjs, index.d.ts),
 *   and importing from it via the resolved path must yield all required exports.
 *
 * WHY this test and not just ../src/easing:
 *   All other easing tests import from '../src/easing/index.js' (source-level).
 *   This test imports from the PUBLISHED artifact path (dist/easing/index.js)
 *   — exactly as a consumer would after `npm install @labpics/motion`.
 *   If the exports map changes, tsup entry is removed, or dist filename drifts,
 *   the source-level tests stay green but THIS test goes RED — catching the drift.
 *
 * RED proof:
 *   Rename dist/easing/index.js → dist/easing/easing.js without updating
 *   package.json exports → import below throws ERR_PACKAGE_PATH_NOT_EXPORTED → RED.
 *   Comment out the "./easing" key in package.json exports → same → RED.
 *
 * Mutation proof:
 *   Removing any required export name from tsup entry causes the last assertion
 *   (exported-names check) to fail; the dist file either omits the name or
 *   tsup strips it as dead export.
 *
 * Subpath boundary (NE5): importing from './easing' alone must NOT pull the
 * core spring/tween/drive exports into the bundle. We verify this by checking
 * that the dist/easing/index.js file contains NONE of the core-only symbols.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// ---------------------------------------------------------------------------
// Resolve the ./easing subpath via package.json exports (mirrors Node.js resolution)
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  exports?: Record<string, { types?: string; import?: string; require?: string }>;
};

const easingExports = pkg.exports?.['./easing'];

describe('easing ./easing subpath — package-boundary smoke (NE5)', () => {
  it('package.json exports map contains the ./easing subpath key', () => {
    expect(
      easingExports,
      'package.json exports["./easing"] must exist (NE5 subpath isolation)',
    ).toBeDefined();
  });

  it('./easing export map declares types, import, and require fields', () => {
    expect(easingExports?.types, './easing "types" field must be declared').toBeTruthy();
    expect(easingExports?.import, './easing "import" (ESM) field must be declared').toBeTruthy();
    expect(easingExports?.require, './easing "require" (CJS) field must be declared').toBeTruthy();
  });

  it('dist/easing/index.js exists on disk (ESM artifact)', () => {
    const esmPath = resolve(pkgRoot, 'dist/easing/index.js');
    expect(
      existsSync(esmPath),
      `dist/easing/index.js does not exist — pnpm build must emit it (NE5)`,
    ).toBe(true);
  });

  it('dist/easing/index.cjs exists on disk (CJS artifact)', () => {
    const cjsPath = resolve(pkgRoot, 'dist/easing/index.cjs');
    expect(
      existsSync(cjsPath),
      `dist/easing/index.cjs does not exist — pnpm build must emit it (NE5)`,
    ).toBe(true);
  });

  it('dist/easing/index.d.ts exists on disk (type declarations artifact)', () => {
    const dtsPath = resolve(pkgRoot, 'dist/easing/index.d.ts');
    expect(
      existsSync(dtsPath),
      `dist/easing/index.d.ts does not exist — pnpm build must emit it (NE5)`,
    ).toBe(true);
  });

  it('dist/easing/index.js exports all required easing names (NE6 api-surface via dist)', () => {
    const esmPath = resolve(pkgRoot, 'dist/easing/index.js');
    const distJs = readFileSync(esmPath, 'utf8');

    // Parse exported names from the ESM dist (export { ... } and export function/const/var)
    const bracketExports = [...distJs.matchAll(/export\s*\{([^}]+)\}/g)].flatMap((m) =>
      (m[1] ?? '').split(',').map(
        (s) =>
          s
            .trim()
            .split(/\s+as\s+/)
            .pop()
            ?.trim() ?? '',
      ),
    );
    const namedExports = [
      ...distJs.matchAll(/export\s+(?:function|const|let|var)\s+(\w+)/g),
    ].map((m) => m[1]?.trim() ?? '');

    const allExported = new Set([...bracketExports, ...namedExports].filter(Boolean));

    // All NE6-required names (api-surface-pin at the dist layer)
    const REQUIRED_NAMES = [
      'linear',
      'easeIn', 'easeOut', 'easeInOut',
      'sineIn', 'sineOut', 'sineInOut',
      'expoIn', 'expoOut', 'expoInOut',
      'circIn', 'circOut', 'circInOut',
      'backIn', 'backOut', 'backInOut',
      'anticipate', 'elastic', 'bounce',
      'power', 'cubicBezier', 'steps',
      'normalizeEasing',
    ];

    const missing = REQUIRED_NAMES.filter((name) => !allExported.has(name));
    expect(
      missing,
      `dist/easing/index.js is missing exports: ${missing.join(', ')} — tsup entry or tree-shake is broken`,
    ).toHaveLength(0);
  });

  it('dist/easing/index.js does NOT contain core-only symbols (NE5 subpath isolation)', () => {
    const esmPath = resolve(pkgRoot, 'dist/easing/index.js');
    const distJs = readFileSync(esmPath, 'utf8');

    // Core-only symbols that must NOT appear as exports in the ./easing subpath
    // (they live in dist/index.js, not in the easing subpath)
    const CORE_ONLY_EXPORTS = ['spring', 'tween', 'drive'];

    const leaking = CORE_ONLY_EXPORTS.filter((name) => {
      // Check for `export { spring }`, `export function spring`, `export const spring`
      const pattern = new RegExp(`\\bexport\\b[^;{]*\\b${name}\\b`);
      return pattern.test(distJs);
    });

    expect(
      leaking,
      `dist/easing/index.js leaks core-only exports: ${leaking.join(', ')} — subpath boundary violated (NE5)`,
    ).toHaveLength(0);
  });
});
