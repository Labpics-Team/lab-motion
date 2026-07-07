/**
 * utils-subpath-smoke.test.ts — package-boundary smoke
 * Class: smoke — tree-shakeable subpath isolation (U5).
 *
 * The ONLY utils test that imports from the PUBLISHED artifact path (the
 * exports["./utils"].import target) instead of ../src. If the exports map
 * changes, the tsup entry is removed, or the dist filename drifts, the
 * source-level utils tests stay green but THIS test goes RED.
 *
 * RED proof:
 *   Remove the "./utils" key in package.json exports → exportsMap undefined → RED.
 *   Point exports["./utils"].import at a non-existent path → dynamic import throws → RED.
 *
 * Boundary (U5): the utils dist must NOT re-export core-only symbols
 * (spring/tween/drive) — verified by inspecting the dist file content.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  exports?: Record<string, { types?: string; import?: string; require?: string }>;
};

const utilsExports = pkg.exports?.['./utils'];

function resolvePackageRelative(declared: string | undefined): string | null {
  if (!declared) return null;
  if (!declared.startsWith('./')) {
    throw new Error(`exports["./utils"] target "${declared}" is not package-relative (must start with "./")`);
  }
  return resolve(pkgRoot, declared.slice(2));
}

const resolvedImportPath = resolvePackageRelative(utilsExports?.import);

const REQUIRED_NAMES = ['clamp', 'mix', 'wrap', 'snap', 'mapRange', 'interpolate', 'pipe'];

describe('utils ./utils subpath — package-boundary smoke (U5)', () => {
  it('package.json exports map contains the ./utils subpath key', () => {
    expect(utilsExports, 'package.json exports["./utils"] must exist').toBeDefined();
  });

  it('./utils export map declares types, import, require — all package-relative', () => {
    expect(utilsExports?.types, './utils "types" must be declared').toBeTruthy();
    expect(utilsExports?.import, './utils "import" (ESM) must be declared').toBeTruthy();
    expect(utilsExports?.require, './utils "require" (CJS) must be declared').toBeTruthy();
    expect(utilsExports?.import?.startsWith('./')).toBe(true);
    expect(utilsExports?.require?.startsWith('./')).toBe(true);
    expect(utilsExports?.types?.startsWith('./')).toBe(true);
  });

  it('exports["./utils"].import/require/types targets exist on disk', () => {
    expect(resolvedImportPath).not.toBeNull();
    expect(existsSync(resolvedImportPath!), `import target "${utilsExports?.import}" must exist`).toBe(true);
    const cjs = resolvePackageRelative(utilsExports?.require);
    expect(existsSync(cjs!), `require target "${utilsExports?.require}" must exist`).toBe(true);
    const dts = resolvePackageRelative(utilsExports?.types);
    expect(existsSync(dts!), `types target "${utilsExports?.types}" must exist`).toBe(true);
  });

  it('exports["./utils"].import loads via dynamic import and exposes all 7 exports', async () => {
    expect(resolvedImportPath).not.toBeNull();
    const mod = (await import(pathToFileURL(resolvedImportPath!).href)) as Record<string, unknown>;
    const missing = REQUIRED_NAMES.filter((n) => typeof mod[n] !== 'function');
    expect(missing, `published ./utils is missing callable exports: ${missing.join(', ')}`).toHaveLength(0);
    // exact-surface at the dist layer: no extra runtime exports leaked
    const extra = Object.keys(mod).filter((n) => !REQUIRED_NAMES.includes(n));
    expect(extra, `published ./utils leaks uncontracted exports: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('published ./utils behaves (smoke a couple of ops end-to-end)', async () => {
    const mod = (await import(pathToFileURL(resolvedImportPath!).href)) as {
      clamp: (a: number, b: number, v: number) => number;
      interpolate: (i: number[], o: number[]) => (v: number) => number;
    };
    expect(mod.clamp(0, 1, 5)).toBe(1);
    expect(mod.interpolate([0, 1], [0, 100])(0.5)).toBe(50);
  });

  // NB: the exact-surface `extra`-check in the dynamic-import test above already
  // catches any leaked core symbol (spring/tween/drive) as an uncontracted
  // export — format-independently. A raw-source regex scan would be redundant
  // and sensitive to the bundler's `export { ... }` shape, so it is omitted.
});
