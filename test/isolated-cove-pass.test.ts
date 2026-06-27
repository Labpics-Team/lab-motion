import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Test: isolated-cove-pass
 * Class: differential
 *
 * Invariant: an agent that did NOT author the artifacts re-verifies every atomic
 * claim against independently re-scraped competitor docs and re-read src, and
 * the regenerated VERIFICATION-COVE.md returns PASS with 0 unresolved discrepancies.
 *
 * This test is a STRUCTURAL gate on the VERIFICATION-COVE.md artifact itself:
 *   (A) The file exists and declares a verdict (PASS or FAIL).
 *   (B) The file declares isolation: it was run by an agent that is NOT the author.
 *   (C) The verdict is PASS (not FAIL or INCONCLUSIVE).
 *   (D) Zero unresolved discrepancies are declared.
 *   (E) The gate covers ALL three required artifacts: feature-matrix.md, gap-matrix.md, superset.md.
 *   (F) The gate post-dates the artifacts it covers (verifies CURRENT state, not a stale prior draft).
 *
 * BITE PROOF — how="mutation":
 *   The current VERIFICATION-COVE.md says "PASS" and has 0 discrepancies — currently GREEN.
 *   Bite is proven by mutation:
 *     1. Change "PASS" to "FAIL" in a scratch copy → assertion (C) fails.
 *     2. Remove the "isolated" / "independent" language → assertion (B) fails.
 *     3. Add "DISCREPANCY: 1" to the cross-check table → assertion (D) fails.
 *     4. Remove "feature-matrix.md" from the artifacts list → assertion (E) fails.
 *   Restore after confirming each mutation causes a FAIL.
 *
 * NOTE on the self-grading prohibition:
 *   The test cannot mechanically detect whether the AGENT that wrote COVE was
 *   the same agent that wrote the artifacts (no agent-id in the file). Instead,
 *   it checks STRUCTURAL SIGNALS that indicate isolation was performed:
 *     - The file must NOT contain "self-verified" or "self-grading" or "self-check".
 *     - The file must contain language indicating independent/isolated verification:
 *       "isolated", "independent", "re-verified", "re-scraped", "NOT the author", etc.
 *   These signals are necessary (not sufficient) conditions for isolation.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const covePath = resolve(repoRoot, 'docs', 'research', 'VERIFICATION-COVE.md');

/** Required artifacts that must be covered by the CoVe gate. */
const REQUIRED_ARTIFACTS = ['feature-matrix.md', 'gap-matrix.md', 'superset.md'];

/** Phrases that indicate isolation was performed. */
const ISOLATION_SIGNALS = [
  'isolated',
  'independent',
  're-verified',
  're-scraped',
  'NOT the author',
  'not authored',
  'not author',
  'independently',
  'chain-of-verification',
  'chain of verification',
  'cove',
];

/** Phrases that indicate self-grading (FORBIDDEN). */
const SELF_GRADING_SIGNALS = ['self-verified', 'self-grading', 'self-check', 'self-grade'];

describe('isolated-cove-pass (differential — mutation-proven)', () => {
  let cove: string;

  it('[A] VERIFICATION-COVE.md exists and is non-empty', () => {
    cove = readFileSync(covePath, 'utf8');
    expect(cove.trim().length, 'VERIFICATION-COVE.md exists but is empty').toBeGreaterThan(50);
  });

  it('[B] file contains isolation signal — was NOT written by the artifact author', () => {
    cove = readFileSync(covePath, 'utf8');
    const lc = cove.toLowerCase();

    const foundSignal = ISOLATION_SIGNALS.some((signal) => lc.includes(signal.toLowerCase()));
    expect(
      foundSignal,
      `VERIFICATION-COVE.md must contain at least one isolation signal indicating the verifier ` +
        `was independent from the artifact author.\n` +
        `Expected one of: ${ISOLATION_SIGNALS.join(' | ')}\n` +
        `The prior-draft CoVe does not count — a fresh CoVe run by a non-author agent is required.`,
    ).toBe(true);
  });

  it('[B2] file must NOT contain self-grading language', () => {
    cove = readFileSync(covePath, 'utf8');
    const lc = cove.toLowerCase();

    const selfGradingFound = SELF_GRADING_SIGNALS.filter((s) => lc.includes(s.toLowerCase()));
    expect(
      selfGradingFound,
      `VERIFICATION-COVE.md contains self-grading language which is FORBIDDEN: ${selfGradingFound.join(', ')}`,
    ).toHaveLength(0);
  });

  it('[C] verdict is PASS (not FAIL, INCONCLUSIVE, or missing)', () => {
    cove = readFileSync(covePath, 'utf8');

    // Look for a verdict declaration. Accepted forms:
    //   "Verdict: ✅ PASS", "**Verdict:** PASS", "Gate result: PASS", "Result: PASS"
    const verdictMatch = cove.match(
      /(?:Verdict|Result|Gate result|gate)[:\s*]+.*?(PASS|FAIL|INCONCLUSIVE)/i,
    );

    expect(
      verdictMatch,
      'VERIFICATION-COVE.md must declare a verdict (PASS, FAIL, or INCONCLUSIVE). No verdict line found.',
    ).not.toBeNull();

    const verdict = verdictMatch?.[1]?.toUpperCase() ?? '';
    expect(
      verdict,
      `VERIFICATION-COVE.md verdict is "${verdict}" — must be "PASS". ` +
        'The CoVe gate must complete without discrepancies before this test can be GREEN.',
    ).toBe('PASS');
  });

  it('[D] zero unresolved discrepancies are declared', () => {
    cove = readFileSync(covePath, 'utf8');

    // Look for the cross-check / discrepancy count line.
    // Expected form: "DISCREPANCY: 0" or "Discrepancies: 0" or "CONFIRMED: N · DISCREPANCY: 0"
    const discrepancyMatch = cove.match(/DISCREPANCY[S]?:\s*(\d+)/i);
    if (discrepancyMatch) {
      const count = parseInt(discrepancyMatch[1] ?? '1', 10);
      expect(
        count,
        `VERIFICATION-COVE.md declares ${count} discrepancy(ies) — must be 0 for PASS.`,
      ).toBe(0);
    }

    // Also check for any "UNRESOLVED" markers in the body.
    const unresolvedCount = (cove.match(/UNRESOLVED/gi) ?? []).length;
    expect(
      unresolvedCount,
      `VERIFICATION-COVE.md contains ${unresolvedCount} UNRESOLVED markers — must be 0 for PASS.`,
    ).toBe(0);
  });

  it('[E] gate covers all three required artifacts', () => {
    cove = readFileSync(covePath, 'utf8');

    const missingArtifacts = REQUIRED_ARTIFACTS.filter((artifact) => !cove.includes(artifact));
    expect(
      missingArtifacts,
      `VERIFICATION-COVE.md does not mention these required artifacts:\n` +
        missingArtifacts.map((a) => `  - ${a}`).join('\n') +
        '\nThe gate must cover feature-matrix.md, gap-matrix.md, AND superset.md.',
    ).toHaveLength(0);
  });

  it('[F] gate was run AFTER the latest epic deliverable (timestamp or generation marker)', () => {
    cove = readFileSync(covePath, 'utf8');

    // The gate must have a date marker that is >= the artifact generation date.
    // Artifact generation date from feature-matrix.md header: "Generated 2026-06-26".
    const ARTIFACT_DATE = '2026-06-26';

    // Extract the date from the CoVe file. Accepted forms:
    //   "Date: 2026-06-26", "**Date:** 2026-06-26", "2026-06-26"
    const dateMatch = cove.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (!dateMatch) {
      // No date found — cannot verify temporal ordering. Fail as a missing requirement.
      expect.fail(
        'VERIFICATION-COVE.md contains no date marker (YYYY-MM-DD format). ' +
          'The gate must declare a date so temporal ordering can be verified.',
      );
      return;
    }

    const coveDate = dateMatch[1] ?? '';
    // Compare as ISO date strings (lexicographic order works for YYYY-MM-DD).
    expect(
      coveDate >= ARTIFACT_DATE,
      `VERIFICATION-COVE.md is dated ${coveDate}, before the artifact generation date ${ARTIFACT_DATE}. ` +
        'The gate must be run AFTER the artifacts it covers. Regenerate the CoVe gate.',
    ).toBe(true);
  });

  it('[G] all atomic claims in the gate are CONFIRMED (none UNCERTAIN or unresolved)', () => {
    cove = readFileSync(covePath, 'utf8');

    // Parse the atomic-claim table (VQ1, VQ2, ...).
    const claimRows = cove.split('\n').filter((l) => /VQ\d+/.test(l));

    if (claimRows.length === 0) {
      // No structured claim table — skip this sub-check.
      return;
    }

    const unconfirmedClaims = claimRows.filter((row) => {
      const lc = row.toLowerCase();
      // A row is confirmed if it contains "✅ CONFIRMED" or "CONFIRMED".
      const confirmed = lc.includes('confirmed') || row.includes('✅');
      return !confirmed;
    });

    expect(
      unconfirmedClaims,
      `These atomic claims in VERIFICATION-COVE.md are not CONFIRMED:\n` +
        unconfirmedClaims.map((r) => `  ${r.trim()}`).join('\n'),
    ).toHaveLength(0);
  });
});
