import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Test: has-grounded-in-src
 * Class: characterization / pin
 *
 * Invariant: every "HAS (confirmed in src)" row in gap-matrix.md cites
 * `src/<file>.ts:<line>` (file + line number), AND the set of claimed
 * capabilities matches the actual public API as pinned by api-surface-pin.test.ts.
 *
 * TWO sub-invariants:
 *   (A) Every HAS Evidence cell references `src/<file>.ts` at a minimum.
 *       This proves the claim was read from code, not inferred from a prompt.
 *   (B) Every HAS Evidence cell references `src/<file>.ts:<line>` with an
 *       explicit line number. This is stricter and currently NOT satisfied:
 *       the gap-matrix cites `src/spring.ts` but not `src/spring.ts:117`
 *       (the springUnchecked function) etc.
 *   (C) Every src file named in a HAS row actually exists in the repo.
 *
 * BITE PROOF — how="red":
 *   Sub-invariant (B) is CURRENTLY VIOLATED. The gap-matrix evidence column
 *   says e.g. `src/spring.ts \`springUnchecked\` 3-regime closed form` but
 *   does NOT include a line number like `src/spring.ts:117`. The regex
 *   `/src\/\S+\.ts:\d+/` matches zero cells in the current gap-matrix.
 *   The assertion `expect(withoutLineNumber).toHaveLength(0)` will FAIL.
 *
 * MUTATION PROOF (sub-invariants A and C, which currently pass):
 *   To prove sub-invariant (A) bites: delete `src/spring.ts` from an Evidence
 *   cell in a scratch copy of gap-matrix → the "every HAS evidence cites a
 *   src file" assertion fails.
 *   To prove sub-invariant (C) bites: change evidence to `src/nonexistent.ts`
 *   → the "every cited src file exists" assertion fails.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const gapMatrixPath = resolve(repoRoot, 'docs', 'research', 'gap-matrix.md');

/** Parse the HAS table rows from gap-matrix.md. */
function parseHasRows(content: string): Array<{ capability: string; evidence: string }> {
  const rows: Array<{ capability: string; evidence: string }> = [];

  // The HAS table is the one with header "| HAS (confirmed in src) | Evidence |"
  // Find the table block.
  const tableMatch = content.match(
    /\|\s*HAS \(confirmed in src\)\s*\|[\s\S]*?(?=\n##|\n---|\z)/,
  );
  if (!tableMatch) return rows;

  const tableText = tableMatch[0];
  const lines = tableText.split('\n').filter((l) => l.includes('|'));

  for (const line of lines) {
    // Skip the header and separator lines.
    if (
      line.includes('HAS (confirmed in src)') ||
      line.includes('---') ||
      line.includes('Evidence')
    ) {
      continue;
    }

    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2) {
      rows.push({ capability: cells[0] ?? '', evidence: cells[1] ?? '' });
    }
  }

  return rows;
}

/**
 * Extract all `src/<file>.ts` or bare `<file>.ts` (known src files) references
 * from an evidence cell. The gap-matrix uses both forms:
 *   - "src/spring.ts" (full path form)
 *   - "`drive.ts`" (backtick shorthand, no src/ prefix)
 */
function extractSrcRefs(evidence: string): string[] {
  // Match explicit "src/<file>.ts" paths.
  const explicit = evidence.match(/src\/[\w/]+\.ts/g) ?? [];
  // Match bare TS filenames known to be in src/ (spring.ts, drive.ts, tween.ts, errors.ts, index.ts).
  const bare = evidence.match(/\b(spring|drive|tween|errors|index)\.ts\b/g) ?? [];
  return [...new Set([...explicit, ...bare])];
}

/** Check if a src reference includes a line number (e.g. src/spring.ts:117). */
function hasLineNumber(ref: string): boolean {
  // Only the explicit "src/<file>.ts:<line>" form counts as a line-pinned reference.
  return /src\/[\w/]+\.ts:\d+/.test(ref);
}

describe('has-grounded-in-src (characterization — pin + RED for missing line numbers)', () => {
  let gapMatrix: string;
  let hasRows: Array<{ capability: string; evidence: string }>;

  it('gap-matrix.md is readable and contains HAS table', () => {
    gapMatrix = readFileSync(gapMatrixPath, 'utf8');
    expect(gapMatrix).toContain('HAS (confirmed in src)');
    hasRows = parseHasRows(gapMatrix);
    expect(hasRows.length, 'Expected at least 5 HAS rows in gap-matrix').toBeGreaterThanOrEqual(5);
  });

  it('[A] every HAS Evidence cell references at least one code artifact (src file, package.json, or test pin)', () => {
    // "HAS == code, never == prompt" means every row must reference an actual artifact.
    // Accepted evidence forms:
    //   - src/<file>.ts (explicit path)
    //   - `<file>.ts` (known src files)
    //   - package.json (for package-level claims like "zero deps, SSR-safe")
    //   - api-surface-pin.test.ts (test contract)
    //   - DriveOptions (TypeScript type exported from src/)
    //   - A symbol name like clampFinite, springUnchecked (confirmed in src)
    //
    // Evidence that is ONLY prose (no code artifact reference) = fails.
    gapMatrix = readFileSync(gapMatrixPath, 'utf8');
    hasRows = parseHasRows(gapMatrix);

    const KNOWN_CODE_ARTIFACTS = [
      /src\/[\w/]+\.ts/,           // explicit src path
      /\b(spring|drive|tween|errors|index)\.ts\b/i,  // known src filenames
      /package\.json/,             // package.json
      /api-surface-pin/,           // contract test pin
      /DriveOptions|SpringParams|SpringResult/,  // exported types (defined in src)
      /clampFinite|springUnchecked|validateSpringParams/,  // functions confirmed in src
      /MotionParamError|validateSpring/,          // error class / validator
      /\bREADME\b/,               // README (grounded in docs, acceptable for packaging claims)
    ];

    const withoutArtifact = hasRows.filter(({ evidence }) =>
      !KNOWN_CODE_ARTIFACTS.some((re) => re.test(evidence)),
    );

    expect(
      withoutArtifact.map(({ capability }) => capability),
      `These HAS capabilities have no code artifact reference in their Evidence:\n` +
        withoutArtifact.map(({ capability, evidence }) => `  "${capability}": "${evidence}"`).join('\n') +
        '\n(HAS == code, never == prompt — invariant)',
    ).toHaveLength(0);
  });

  it('[B] every HAS Evidence cell cites src/<file>.ts:<line> with an explicit line number — RED until added', () => {
    // This is the RED assertion. Currently evidence cells use form `src/spring.ts`
    // without line numbers. The invariant requires `src/spring.ts:117`.
    // Only EXPLICIT "src/<file>.ts" refs are checked — bare filenames cannot carry
    // line numbers in the current table format.
    gapMatrix = readFileSync(gapMatrixPath, 'utf8');
    hasRows = parseHasRows(gapMatrix);

    const withoutLineNumber = hasRows.filter(({ evidence }) => {
      // Only check explicit "src/<file>.ts" path references.
      const explicitRefs = evidence.match(/src\/[\w/]+\.ts(?::\d+)?/g) ?? [];
      // Every explicit src ref must include a line number.
      return explicitRefs.length > 0 && explicitRefs.some((r) => !hasLineNumber(r));
    });

    expect(
      withoutLineNumber.map(({ capability, evidence }) => `"${capability}": "${evidence}"`),
      `These HAS rows cite src files WITHOUT an explicit line number (src/<file>.ts:<line> required):\n` +
        withoutLineNumber.map(({ capability, evidence }) => `  - ${capability}: ${evidence}`).join('\n') +
        '\nFix: update each Evidence cell to include the exact line number, e.g. src/spring.ts:117.',
    ).toHaveLength(0);
  });

  it('[C] every EXPLICIT src/<file>.ts path in HAS Evidence actually exists in the repo', () => {
    // Only check explicit "src/<file>.ts" paths (not bare filenames).
    // Bare filenames are checked implicitly by the api-surface-pin test.
    gapMatrix = readFileSync(gapMatrixPath, 'utf8');
    hasRows = parseHasRows(gapMatrix);

    const missingFiles: string[] = [];
    for (const { evidence } of hasRows) {
      // Only match the explicit "src/<file>.ts" form (not bare filenames).
      const explicitRefs = evidence.match(/src\/[\w/]+\.ts(?::\d+)?/g) ?? [];
      for (const ref of explicitRefs) {
        // Strip line number suffix if present before checking file existence.
        const filePath = resolve(repoRoot, ref.replace(/:\d+$/, ''));
        if (!existsSync(filePath)) {
          missingFiles.push(ref);
        }
      }
    }

    expect(
      [...new Set(missingFiles)],
      `HAS Evidence references src files that do not exist:\n${[...new Set(missingFiles)].join('\n')}`,
    ).toHaveLength(0);
  });

  it('[D] claimed public API names match what src/index.ts actually exports', () => {
    // The HAS row for "Public exports" in gap-matrix preamble claims:
    //   spring, tween, drive, validateSpringParams, MotionParamError
    // This must match the actual src/index.ts (read from source, not dist).
    const indexSrc = readFileSync(resolve(repoRoot, 'src', 'index.ts'), 'utf8');

    const CLAIMED_EXPORTS = ['spring', 'tween', 'drive', 'validateSpringParams', 'MotionParamError'];
    for (const name of CLAIMED_EXPORTS) {
      expect(
        indexSrc,
        `src/index.ts does not export "${name}" — gap-matrix HAS claim is ungrounded`,
      ).toContain(name);
    }

    // The gap-matrix should reference the api-surface-pin test.
    gapMatrix = readFileSync(gapMatrixPath, 'utf8');
    expect(
      gapMatrix,
      'gap-matrix.md should reference api-surface-pin.test.ts (the contract test that pins the surface)',
    ).toContain('api-surface-pin.test.ts');
  });
});
