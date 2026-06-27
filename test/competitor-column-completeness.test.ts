import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Test: competitor-column-completeness
 * Class: contract
 *
 * Invariant: the feature-matrix.md competitor roster is a SUPERSET of the
 * required roster. Every required competitor must appear as a named column
 * (or named mention in the header/legend) of the matrix.
 *
 * Required roster per EPIC exit-criteria (docs/research/EPIC.md, success_criteria[0]):
 *   GSAP, Framer Motion (= "Motion"), Motion One, Anime.js v4, React Spring,
 *   Theatre.js, Rive, Lottie, native WAAPI, native View-Transitions,
 *   native scroll-driven CSS (distinct from WAAPI/ScrollTimeline).
 *
 * BITE PROOF — how="red":
 *   Theatre.js, Rive, Lottie, and "native scroll-driven CSS" are ABSENT from
 *   the current feature-matrix.md (grep confirms zero hits for these strings).
 *   The four `expect(missing).toHaveLength(0)` assertions FAIL NOW for the
 *   right reason: the competitor columns are missing, not a compile error.
 *
 *   Confirmed via grep before writing:
 *     grep "Theatre" docs/research/feature-matrix.md  → 0 matches
 *     grep "Rive"    docs/research/feature-matrix.md  → 0 matches
 *     grep "Lottie"  docs/research/feature-matrix.md  → 0 matches
 *     grep "scroll-driven CSS" docs/research/feature-matrix.md → 0 matches
 */

const here = dirname(fileURLToPath(import.meta.url));
const matrixPath = resolve(here, '..', 'docs', 'research', 'feature-matrix.md');

// ---------------------------------------------------------------------------
// Required competitor roster (lower-cased for case-insensitive matching).
// Each entry is the canonical name AND a set of acceptable aliases.
// The matrix may use abbreviations or shorthand; we match ANY alias.
// ---------------------------------------------------------------------------
const REQUIRED_COMPETITORS: Array<{ name: string; aliases: string[] }> = [
  { name: 'GSAP', aliases: ['gsap'] },
  { name: 'Framer Motion / Motion', aliases: ['framer motion', 'motion (', 'c1 motion', '"motion"'] },
  { name: 'Motion One', aliases: ['motion one', 'c5 motion one', 'motion mini', 'motion one /'] },
  { name: 'Anime.js v4', aliases: ['anime.js v4', 'anime.js', 'animejs', 'c3 anime'] },
  { name: 'React Spring', aliases: ['react-spring', 'react spring', 'c4 react-spring'] },
  { name: 'Theatre.js', aliases: ['theatre.js', 'theatre js', 'theatrejs'] },
  { name: 'Rive', aliases: ['rive'] },
  { name: 'Lottie', aliases: ['lottie'] },
  { name: 'native WAAPI', aliases: ['waapi', 'web animation'] },
  { name: 'native View-Transitions', aliases: ['view transition', 'view-transition'] },
  {
    name: 'native scroll-driven CSS',
    // Must be present as its own named competitor or capability column.
    // "ScrollTimeline" alone is a WAAPI sub-feature, not the same as
    // the full scroll-driven CSS animations spec (@keyframes + animation-timeline).
    aliases: ['scroll-driven css', 'scroll-driven animation', 'animation-timeline'],
  },
];

describe('competitor-column-completeness (contract — RED until matrix is complete)', () => {
  let matrix: string;

  it('feature-matrix.md is readable', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    expect(matrix.length).toBeGreaterThan(100);
  });

  it('required competitor roster is fully covered — no column missing', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    const lc = matrix.toLowerCase();

    const missing = REQUIRED_COMPETITORS.filter(({ aliases }) =>
      aliases.every((alias) => !lc.includes(alias.toLowerCase())),
    ).map(({ name }) => name);

    expect(
      missing,
      `feature-matrix.md is missing required competitor column(s): ${missing.join(', ')}.\n` +
        'The invariant requires Theatre.js, Rive, Lottie, and native scroll-driven CSS ' +
        '(as a named competitor/column, distinct from WAAPI). ' +
        'Add the missing competitor columns across all 14 dimensions.',
    ).toHaveLength(0);
  });

  // Per-competitor fine-grained assertions so CI pinpoints WHICH column is missing.
  for (const { name, aliases } of REQUIRED_COMPETITORS) {
    it(`feature-matrix.md includes competitor: ${name}`, () => {
      matrix = readFileSync(matrixPath, 'utf8');
      const lc = matrix.toLowerCase();
      const found = aliases.some((alias) => lc.includes(alias.toLowerCase()));
      expect(
        found,
        `Missing competitor in feature-matrix.md: "${name}". ` +
          `Expected one of the aliases to appear: ${aliases.join(' | ')}`,
      ).toBe(true);
    });
  }

  it('every required competitor appears in the header/legend section', () => {
    matrix = readFileSync(matrixPath, 'utf8');
    // The header section is defined as the first 20 lines (title + legend block).
    const header = matrix.split('\n').slice(0, 20).join('\n').toLowerCase();

    // High-frequency competitors already in header — just sanity-check one.
    expect(header).toContain('gsap');

    // Spot-check: the header should also declare the new required competitors
    // once they are added. This assertion documents the expected state.
    // Currently FAILS for Theatre.js/Rive/Lottie/scroll-driven CSS (RED).
    const newRequired = ['theatre', 'rive', 'lottie', 'scroll-driven'];
    const missingFromHeader = newRequired.filter((t) => !header.includes(t));
    expect(
      missingFromHeader,
      `Legend/header in feature-matrix.md is missing new competitors: ${missingFromHeader.join(', ')}`,
    ).toHaveLength(0);
  });
});
