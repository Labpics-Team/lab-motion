import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * Test: zero-dep + bundle-size + full gate
 * Class: smoke
 * Invariant 1 — zero runtime dependencies; built dist imports nothing external.
 *
 * Assertions:
 *   1. package.json `dependencies` is absent or empty.
 *   2. The built dist/index.js contains no `import ... from` of any external module
 *      (only relative imports or no imports at all).
 *   3. The gzipped size of dist/index.js is measured and recorded; it must remain
 *      under a reasonable budget (10KB gzip for the entire motion engine).
 *
 * RED proof:
 *   The dist is the built placeholder and currently exports only `PACKAGE_NAME`.
 *   The zero-dep assertions PASS (placeholder has no deps), but the
 *   bundle-size test also passes for now (empty dist).
 *
 *   Wait — the test plan says RED for new behavior. For this smoke, the
 *   RED is on the full-gate assertions that REQUIRE the engine exports:
 *   the test below explicitly asserts that the dist exports the contracted
 *   names (spring/tween/drive/MotionParamError), which the placeholder does not.
 *   That assertion is the RED hook.
 *
 * Mutation proof (how="mutation"):
 *   Add a `dependencies: { "some-library": "*" }` to motion/package.json →
 *   the no-deps assertion fails immediately.
 *   Add `import { foo } from 'some-library'` to src/index.ts, rebuild →
 *   the external-import scan fails.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  name: string;
};
const distJs = readFileSync(resolve(pkgRoot, 'dist/index.js'), 'utf8');

/** Gzip a string and return the compressed byte count. */
async function gzipSize(content: string): Promise<number> {
  const gzip = promisify((input: Buffer, cb: (err: Error | null, out: Buffer) => void) => {
    const gz = createGzip();
    const chunks: Buffer[] = [];
    gz.on('data', (c: Buffer) => chunks.push(c));
    gz.on('end', () => cb(null, Buffer.concat(chunks)));
    gz.on('error', (e: Error) => cb(e, Buffer.alloc(0)));
    gz.write(input);
    gz.end();
  });
  const compressed = await gzip(Buffer.from(content, 'utf8'));
  return compressed.length;
}

describe('zero-dep + bundle-size smoke (invariant 1)', () => {
  it('package.json has no runtime dependencies', () => {
    const deps = pkg.dependencies ?? {};
    expect(
      Object.keys(deps),
      `@labpics/ui-motion must have zero runtime deps. Found: ${Object.keys(deps).join(', ')}`,
    ).toHaveLength(0);
  });

  it('built dist/index.js contains no external imports', () => {
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

  it('gzip size of dist/index.js is measured and under 10KB budget', async () => {
    const gz = await gzipSize(distJs);
    // Record the size for observability.
    console.info(`[@labpics/ui-motion] dist/index.js gzip size: ${gz} bytes`);
    // Budget: 10KB gzip for the full motion engine (spring solver + tween + driver).
    expect(gz).toBeLessThan(10_240);
  });

  it('dist/index.js exports the contracted engine names (gate: fails until engine ships)', () => {
    // Parse exported names from the ESM dist.
    // The placeholder exports only PACKAGE_NAME; the engine must export all four.
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
      `dist/index.js is missing engine exports: ${missing.join(', ')} — engine not yet shipped`,
    ).toHaveLength(0);
  });
});
