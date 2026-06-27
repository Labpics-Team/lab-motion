import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test: blast-radius-sentinel — permanently-forbidden zone guard
 * Class: regression (governance)
 *
 * This test guards exactly ONE thing: certain paths (dist/, node_modules/,
 * pnpm-lock.yaml) MUST NEVER be committed. These are artifacts or managed files
 * that must not be edited by hand and must not appear in git diffs.
 *
 * What this test does NOT claim:
 *   - It does NOT claim that changes to src/, test/, .github/, docs/, epics/ are
 *     forbidden. Those zones have their own governance (EPIC blast-radius notes,
 *     PR review, CI gates).
 *   - It is NOT a "blast-radius-confined" test that proves only certain zones
 *     are touched — that claim belongs in the EPIC governance document and is
 *     enforced by human review + PR gate, not by a test that could be widened
 *     post-hoc to admit violations.
 *
 * Prior defect (resolved):
 *   A prior version of this test (named "blast-radius-confined") declared an
 *   ALLOWED_PATH_PREFIXES list including 'src/' and 'test/', while the N7 EPIC
 *   simultaneously declared src/ READ-ONLY. This created a governance contradiction:
 *   the test would PASS GREEN on a diff that violated the EPIC's blast-radius clause.
 *   The fix is to NOT make this test assert what the allowed zone is — only assert
 *   what is permanently forbidden. EPIC blast-radius compliance is a PR-review concern.
 *
 * BITE PROOF — mutation targets:
 *   1. `echo "" >> dist/index.js`   → [A]+[B]+[C] FAIL.
 *   2. `echo "" >> node_modules/x`  → [A]+[B] FAIL.
 *   3. `echo "" >> pnpm-lock.yaml`  → [D] FAIL.
 *   Restore after mutation to confirm GREEN.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** Paths that are FOREVER FORBIDDEN to appear in any git diff or untracked status. */
const FOREVER_FORBIDDEN_PATHS = [
  'dist/',
  'node_modules/',
  'pnpm-lock.yaml',
];

function isForbidden(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  return FOREVER_FORBIDDEN_PATHS.some(
    (forbidden) => norm === forbidden || norm.startsWith(forbidden),
  );
}

function git(args: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  } catch (err) {
    throw new Error(`git ${args} failed: ${String(err)}`);
  }
}

describe('blast-radius-sentinel (regression — permanently-forbidden zones)', () => {
  it('git is available in the repo root', () => {
    const status = git('status --short');
    expect(typeof status).toBe('string');
  });

  it('[A] no tracked file in a permanently-forbidden path is modified', () => {
    const diffOutput = git('diff HEAD --name-only');
    const modified = diffOutput.split('\n').filter(Boolean);
    const forbidden = modified.filter(isForbidden);
    expect(
      forbidden,
      `Modified tracked files in permanently-forbidden zone (dist/, node_modules/, pnpm-lock.yaml):\n` +
        forbidden.map((f) => `  ${f}`).join('\n'),
    ).toHaveLength(0);
  });

  it('[B] no untracked file in a permanently-forbidden zone was created', () => {
    const statusOutput = git('status --porcelain -u');
    const untracked = statusOutput
      .split('\n')
      .filter((l) => l.startsWith('??'))
      .map((l) => l.replace(/^\?\?\s+/, '').trim());
    const forbidden = untracked.filter(isForbidden);
    expect(
      forbidden,
      `Untracked files in permanently-forbidden zone (dist/, node_modules/, pnpm-lock.yaml):\n` +
        forbidden.map((f) => `  ${f}`).join('\n'),
    ).toHaveLength(0);
  });

  it('[C] dist/ is byte-identical to HEAD (build artifacts must not be modified)', () => {
    const diff = git('diff HEAD -- "dist/"');
    expect(
      diff,
      'dist/ has been modified — build artifacts must not be edited directly. Run `pnpm build` to regenerate.',
    ).toBe('');
  });

  it('[D] pnpm-lock.yaml is byte-identical to HEAD (lockfile changes must be intentional)', () => {
    const diff = git('diff HEAD -- "pnpm-lock.yaml"');
    expect(
      diff,
      'pnpm-lock.yaml has been modified — lockfile changes must be intentional and reviewed.',
    ).toBe('');
  });

  it('[E] package.json is byte-identical to HEAD (package changes must be intentional)', () => {
    const diff = git('diff HEAD -- "package.json"');
    expect(
      diff,
      'package.json has been modified — package changes must be intentional and reviewed.',
    ).toBe('');
  });

  it('[F] tsconfig.json and build configs are byte-identical to HEAD (build-config changes must be intentional)', () => {
    for (const file of ['tsconfig.json', 'vitest.config.ts', 'tsup.config.ts']) {
      const diff = git(`diff HEAD -- "${file}"`);
      expect(
        diff,
        `Build config "${file}" has been modified — must be intentional and reviewed.`,
      ).toBe('');
    }
  });
});
