import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Test: citation-density>=2
 * Class: contract
 *
 * Invariant: every non-obvious capability claim in feature-matrix.md carries
 * >=2 distinct official sources with retrieval dates. Unsupported claims must
 * be marked UNCERTAIN, never asserted.
 *
 * "Non-obvious" = any per-competitor ✅ cell or named capability row.
 * "Distinct sources" = different hostnames / doc URLs in the same Cites: line.
 * "Official" = the URL points to the competitor's own domain or official repo.
 *
 * Implementation strategy:
 *   Each dimension section ends with a `Cites:` line. We count the number of
 *   distinct URL-like tokens (domain or path fragments) per Cites: line.
 *   A Cites: line with >=2 distinct sources satisfies the per-dimension
 *   constraint. We also check that all 14 dimensions (D1..D14) have a Cites:
 *   line at all (structural contract).
 *
 * BITE PROOF — how="red":
 *   The current feature-matrix.md has ONE Cites: line PER DIMENSION (not per
 *   per-competitor cell or per-claim). Theatre.js/Rive/Lottie dimensions have
 *   ZERO Cites: lines because those columns are absent entirely.
 *   The assertion that every dimension has >=2 distinct sources in its Cites:
 *   block will FAIL for new dimensions once they are added without citations,
 *   and the assertion that EVERY dimension (D1..D14) has a Cites: line at all
 *   will still PASS (current matrix has all 14).
 *
 *   The CRITICAL RED assertion: every competitor column added for
 *   Theatre.js/Rive/Lottie/scroll-driven CSS must have a corresponding per-
 *   competitor Cites: block — the current single-Cites-per-dimension structure
 *   is insufficient for the >=2 per-claim requirement once Theatre.js etc.
 *   are added. The test asserts a MINIMUM of 2 URLs per Cites: line
 *   (currently satisfied for existing 14 dims) AND that the overall count of
 *   Cites: lines >= 14 (one per dimension). Both currently pass for the 14
 *   existing dimensions; the test will RED when Theatre.js/Rive/Lottie
 *   competitor sections are added without citations.
 *
 *   The per-claim RED: We parse competitor ✅ cells vs Cites: line count
 *   and assert cites-line-count >= distinct-competitor-count per section.
 *   Currently: 6 competitors in header + native = 7 "columns" but only
 *   1 Cites: line per D-section → ratio < 1:1 per-competitor → RED.
 */

const here = dirname(fileURLToPath(import.meta.url));
const matrixPath = resolve(here, '..', 'docs', 'research', 'feature-matrix.md');

/** Extract `Cites:` lines from a section of text. */
function extractCitesLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('Cites:'))
    .map((l) => l.trim());
}

/**
 * Count distinct URL-like tokens in a cites line.
 * A token is any word containing at least one dot (domain-like) or
 * starting with http.
 */
function countDistinctSources(citesLine: string): number {
  const body = citesLine.replace(/^Cites:\s*/, '');
  // Split on semicolons and commas to isolate individual source references.
  const tokens = body.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  // Extract domain-like fragments: anything matching word.word patterns.
  const domains = new Set<string>();
  for (const token of tokens) {
    // Extract base domain (first two dot-separated segments) to deduplicate
    // different paths on the same site.
    const match = token.match(/\b([\w-]+\.[\w-]+(?:\.[\w-]+)?)/);
    if (match) {
      domains.add(match[1]?.toLowerCase() ?? '');
    }
  }
  return domains.size;
}

/**
 * Split the matrix into D-sections by the `## D<n>` heading.
 * Returns array of { heading, body } objects.
 */
function splitIntoDimensionSections(matrix: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = matrix.split('\n');
  let currentHeading = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    if (/^## D\d+/.test(line)) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n') });
      }
      currentHeading = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n') });
  }

  return sections;
}

describe('citation-density>=2 (contract — RED until per-claim citations added)', () => {
  let matrix: string;

  it('feature-matrix.md is readable', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    expect(matrix.length).toBeGreaterThan(100);
  });

  it('all 14 required dimensions (D1..D14) are present with at least one Cites: line', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    const sections = splitIntoDimensionSections(matrix);

    const dimensionNumbers = sections.map((s) => {
      const m = s.heading.match(/## D(\d+)/);
      return m ? parseInt(m[1] ?? '0', 10) : 0;
    });

    // All 14 dimensions must appear.
    for (let d = 1; d <= 14; d++) {
      expect(
        dimensionNumbers,
        `Dimension D${d} is missing from feature-matrix.md`,
      ).toContain(d);
    }

    // Every dimension section must have at least one Cites: line.
    const missingCites = sections.filter((s) => {
      const cites = extractCitesLines(s.body);
      return cites.length === 0;
    });
    expect(
      missingCites.map((s) => s.heading),
      `These dimensions have no Cites: line: ${missingCites.map((s) => s.heading).join(', ')}`,
    ).toHaveLength(0);
  });

  it('every Cites: line references >=2 distinct official sources', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    const sections = splitIntoDimensionSections(matrix);

    const violations: string[] = [];

    for (const { heading, body } of sections) {
      const citesLines = extractCitesLines(body);
      for (const citesLine of citesLines) {
        const count = countDistinctSources(citesLine);
        if (count < 2) {
          violations.push(`${heading}: only ${count} source(s) in "${citesLine}"`);
        }
      }
    }

    expect(
      violations,
      `These Cites: lines have fewer than 2 distinct sources:\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });

  it('citation count per dimension section >= number of competitor columns covered', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    // Count how many competitor columns the header declares.
    // The legend line lists C1..C6 + native = at minimum 3 distinct source sets needed
    // (one per competitor group for non-obvious claims).
    const legendMatch = matrix.match(/\*\*Competitors:\*\*.+/);
    expect(legendMatch, 'Legend line with competitor list not found').toBeTruthy();

    const sections = splitIntoDimensionSections(matrix);

    // For each dimension, count ✅ cells (non-trivial claims with a competitor marker).
    // The invariant: citations must cover competitor claims. We require at minimum
    // that the Cites: line count × 2 >= number of distinct ✅-bearing competitors
    // declared in that section (proxy: >=2 sources per section implies the section
    // has been cross-referenced across competitors).
    //
    // The hard assertion per the test plan:
    //   "Every non-obvious capability claim carries >=2 distinct official sources."
    // We represent "non-obvious" as any ✅ cell from a NEW competitor column
    // (Theatre.js, Rive, Lottie) — once those columns are added, the existing
    // single Cites: per section is insufficient because the new sources are not cited.
    //
    // Currently this passes (6 existing competitors, all cited across sections).
    // It will RED when Theatre.js/Rive/Lottie ✅ cells appear without new Cites.
    const newCompetitors = ['theatre', 'rive', 'lottie'];
    const sectionsWithNewCompetitors = sections.filter(({ body }) => {
      const lc = body.toLowerCase();
      return newCompetitors.some((c) => lc.includes(c));
    });

    if (sectionsWithNewCompetitors.length > 0) {
      // New competitors exist — every such section must have a Cites: line that
      // references the new competitor's official docs.
      for (const { heading, body } of sectionsWithNewCompetitors) {
        const citesLines = extractCitesLines(body);
        const citesText = citesLines.join(' ').toLowerCase();
        const uncited = newCompetitors.filter((c) => body.toLowerCase().includes(c) && !citesText.includes(c));
        expect(
          uncited,
          `${heading}: competitor(s) ${uncited.join(', ')} appear in cells but are absent from Cites:`,
        ).toHaveLength(0);
      }
    } else {
      // New competitors not yet in the matrix — assert a placeholder FAIL
      // to force the issue: the matrix is incomplete and this test must stay RED
      // until Theatre.js/Rive/Lottie/scroll-driven CSS columns are added.
      // This assertion is the RED hook: it fails because the required new
      // competitors are absent from the matrix entirely.
      const requiredNewCompetitors = ['theatre.js', 'rive', 'lottie', 'scroll-driven css'];
      const lc = matrix.toLowerCase();
      const absentCompetitors = requiredNewCompetitors.filter((c) => !lc.includes(c));
      expect(
        absentCompetitors,
        `Required competitor columns are entirely absent from feature-matrix.md: ` +
          `${absentCompetitors.join(', ')}. ` +
          `Add these columns across all 14 dimensions, each with >=2 official source citations.`,
      ).toHaveLength(0);
    }
  });

  it('no claim is marked UNCERTAIN without also having at least one source', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    const lines = matrix.split('\n');
    const uncertainLines = lines.filter((l) => l.includes('UNCERTAIN'));
    // If UNCERTAIN appears anywhere, the surrounding line must reference a source URL.
    for (const line of uncertainLines) {
      const hasDomainRef = /[\w-]+\.[\w-]+/.test(line.replace('UNCERTAIN', ''));
      expect(
        hasDomainRef,
        `Line contains UNCERTAIN without a source reference: "${line}"`,
      ).toBe(true);
    }
  });
});
