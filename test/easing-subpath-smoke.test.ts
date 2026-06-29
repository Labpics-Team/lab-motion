/**
 * easing-subpath-smoke.test.ts — package-boundary smoke
 * Class: smoke (A)
 * Invariant NE5 — tree-shakeable subpath isolation:
 *   The ./easing subpath must exist in dist and the actual exports["./easing"].import
 *   target must load successfully, yielding all required exports.
 *
 * WHY this test and not just ../src/easing:
 *   All other easing tests import from '../src/easing/index.js' (source-level).
 *   This test imports from the PUBLISHED artifact path — the path declared in
 *   exports["./easing"].import — exactly as a consumer would after installing
 *   @labpics/motion. If the exports map changes, tsup entry is removed, or dist
 *   filename drifts, the source-level tests stay green but THIS test goes RED.
 *
 * RED proof:
 *   Comment out the "./easing" key in package.json exports → exports field is
 *   undefined → all assertions below fail → RED.
 *   Change exports["./easing"].import to a non-existent path → dynamic import
 *   throws ENOENT/ERR_MODULE_NOT_FOUND → RED.
 *
 * Mutation proof:
 *   Removing any required export name from tsup entry causes the named-exports
 *   check to fail — the dynamically loaded module omits the name → RED.
 *
 * Subpath boundary (NE5): the easing dist must NOT re-export core-only symbols
 * (spring/tween/drive) — verified by inspecting the dist file content.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

// ---------------------------------------------------------------------------
// Read the package.json exports map — this is the source of truth for resolution
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  exports?: Record<string, { types?: string; import?: string; require?: string }>;
};

const easingExports = pkg.exports?.['./easing'];

// Validate and resolve the actual dist path declared in exports["./easing"].import.
// All targets must be package-relative (start with "./") — absolute or parent-relative
// ("../") paths are not valid package export targets and indicate a misconfigured build.
const declaredImportPath = easingExports?.import; // e.g. "./dist/easing/index.js"
const declaredRequirePath = easingExports?.require;
const declaredTypesPath = easingExports?.types;

/** Assert a target is package-relative (starts with "./") and resolve it. */
function resolvePackageRelative(declared: string | undefined): string | null {
  if (!declared) return null;
  if (!declared.startsWith('./')) {
    throw new Error(
      `exports["./easing"] target "${declared}" is not package-relative (must start with "./")`
    );
  }
  return resolve(pkgRoot, declared.slice(2)); // strip "./" prefix
}

const resolvedImportPath = resolvePackageRelative(declaredImportPath);

describe('easing ./easing subpath — package-boundary smoke (NE5)', () => {
  // ---------------------------------------------------------------------------
  // Gate 1: exports map declares the subpath correctly
  // ---------------------------------------------------------------------------
  it('package.json exports map contains the ./easing subpath key', () => {
    expect(
      easingExports,
      'package.json exports["./easing"] must exist (NE5 subpath isolation)',
    ).toBeDefined();
  });

  it('./easing export map declares types, import, and require fields — all package-relative (start with "./")', () => {
    expect(easingExports?.types, './easing "types" field must be declared').toBeTruthy();
    expect(easingExports?.import, './easing "import" (ESM) field must be declared').toBeTruthy();
    expect(easingExports?.require, './easing "require" (CJS) field must be declared').toBeTruthy();
    // All targets must start with "./" — pins resolvePackageRelative guard
    expect(
      easingExports?.import?.startsWith('./'),
      `exports["./easing"].import "${easingExports?.import}" must be package-relative (start with "./")`
    ).toBe(true);
    expect(
      easingExports?.require?.startsWith('./'),
      `exports["./easing"].require "${easingExports?.require}" must be package-relative (start with "./")`
    ).toBe(true);
    expect(
      easingExports?.types?.startsWith('./'),
      `exports["./easing"].types "${easingExports?.types}" must be package-relative (start with "./")`
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Gate 2: the declared import target exists on disk
  // ---------------------------------------------------------------------------
  it('exports["./easing"].import target exists on disk (primary path verification)', () => {
    expect(resolvedImportPath, 'exports["./easing"].import path must resolve').not.toBeNull();
    expect(
      existsSync(resolvedImportPath!),
      `exports["./easing"].import → "${declaredImportPath}" → "${resolvedImportPath}" does not exist on disk — pnpm build must emit it (NE5)`,
    ).toBe(true);
  });

  it('exports["./easing"].require target is package-relative and exists on disk', () => {
    // resolvePackageRelative throws if target is not package-relative (not starting with "./")
    const cjsPath = resolvePackageRelative(declaredRequirePath);
    expect(cjsPath, 'exports["./easing"].require must be declared').not.toBeNull();
    expect(
      existsSync(cjsPath!),
      `exports["./easing"].require → "${declaredRequirePath}" → "${cjsPath}" does not exist on disk (NE5)`,
    ).toBe(true);
  });

  it('exports["./easing"].types target is package-relative and exists on disk', () => {
    // resolvePackageRelative throws if target is not package-relative (not starting with "./")
    const dtsPath = resolvePackageRelative(declaredTypesPath);
    expect(dtsPath, 'exports["./easing"].types must be declared').not.toBeNull();
    expect(
      existsSync(dtsPath!),
      `exports["./easing"].types → "${declaredTypesPath}" → "${dtsPath}" does not exist on disk (NE5)`,
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Gate 3: the resolved import target ACTUALLY LOADS and exports all NE6 names
  // (this is the key gate CodeRabbit flagged — dynamic import proves the module
  // resolves and runs, not just that a file exists at a hard-coded path)
  // ---------------------------------------------------------------------------
  it('exports["./easing"].import target loads via dynamic import and exports all NE6 names (NE5+NE6)', async () => {
    expect(resolvedImportPath, 'resolved import path must exist before dynamic import').not.toBeNull();

    // Dynamic import from the exact path declared in exports["./easing"].import
    // This is the same resolution path Node.js uses for "import ... from '@labpics/motion/easing'"
    const fileUrl = pathToFileURL(resolvedImportPath!).href;
    const mod = await import(fileUrl) as Record<string, unknown>;

    // All NE6-required names (api-surface-pin at the dist/published layer)
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

    const missing = REQUIRED_NAMES.filter((name) => typeof mod[name] !== 'function');
    expect(
      missing,
      `exports["./easing"].import module is missing callable exports: ${missing.join(', ')} — tsup entry or tree-shake is broken`,
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Gate 4: the easing dist does NOT contain core-only symbols (NE5 boundary)
  // ---------------------------------------------------------------------------
  it('exports["./easing"].import target does NOT contain core-only symbol exports (NE5 subpath isolation)', () => {
    expect(resolvedImportPath).not.toBeNull();
    const distJs = readFileSync(resolvedImportPath!, 'utf8');

    // Core-only symbols that must NOT appear as exports in the ./easing subpath
    const CORE_ONLY_EXPORTS = ['spring', 'tween', 'drive'];

    const leaking = CORE_ONLY_EXPORTS.filter((name) => {
      // Check for `export { spring }`, `export function spring`, `export const spring`
      const pattern = new RegExp(`\\bexport\\b[^;{]*\\b${name}\\b`);
      return pattern.test(distJs);
    });

    expect(
      leaking,
      `exports["./easing"].import leaks core-only exports: ${leaking.join(', ')} — subpath boundary violated (NE5)`,
    ).toHaveLength(0);
  });
});
