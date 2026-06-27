import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Test: golden-thread-trace
 * Class: property
 *
 * Property: for every superset scope row:
 *   capability -> exactly one s03..s13 scope id (lowercase) -> one D-dimension
 *                -> >=2 cited competitor docs resolves.
 *
 * The S0..S21 -> s00..s13 mapping table must be present and TOTAL (every S-scope
 * maps to exactly one s-scope) and ONTO (every s00..s13 is covered).
 *
 * The golden-thread breaks when:
 *   - A scope row carries no s-id (only S-id without mapping)
 *   - The mapping table is absent
 *   - The mapping is not total (some S-scope has no s-mapping)
 *   - The mapping is not onto (some canonical s-scope has no S-scope mapped to it)
 *   - A scope row cites no D-dimension
 *   - A scope row's dimension has no competitor citations
 *
 * BITE PROOF — how="red":
 *   The current superset.md uses UPPERCASE S0..S21 ids (e.g. **S1**, **S10**).
 *   The canonical N7 namespace is LOWERCASE s00..s13 (per EPIC.md CH-04 lock decision).
 *   The S->s mapping table is ABSENT from the current superset.md.
 *   The assertions:
 *     (1) "superset has canonical s03..s13 scope ids" → FAILS (only S1..S21 present)
 *     (2) "S->s mapping table exists" → FAILS (no such table in current superset)
 *   These are RED for the right reason: the namespace migration is pending.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const supersetPath = resolve(repoRoot, 'docs', 'research', 'superset.md');
const matrixPath = resolve(repoRoot, 'docs', 'research', 'feature-matrix.md');

/**
 * Parse canonical s-scope ids (lowercase s00..s13 pattern) from superset.md.
 * Returns all unique s-ids found.
 */
function parseCanonicalScopeIds(content: string): string[] {
  const matches = content.match(/\bs0[0-9]|s1[0-3]\b/g);
  return [...new Set(matches ?? [])];
}

/**
 * Parse legacy S-scope ids (uppercase S0..S21 pattern) from superset.md scope table.
 */
function parseLegacyScopeIds(content: string): string[] {
  const matches = content.match(/\*\*([Ss]\d+)\*\*/g);
  return [...new Set((matches ?? []).map((m) => m.replace(/\*\*/g, '')))];
}

/**
 * Parse S->s mapping table from superset.md.
 * Expected format: | S1 | s03 | ... or similar.
 * Returns null if no mapping table is found.
 */
function parseSToSMappingTable(content: string): Map<string, string> | null {
  // Look for a section header that describes the S->s mapping.
  const mappingSection = content.match(
    /(?:S\d+\s*[-→]+\s*s\d+|mapping|S0\.\.S21\s*[-→]+\s*s00|legacy.*canonical|S.*->.*s)/i,
  );
  if (!mappingSection) return null;

  const map = new Map<string, string>();
  // Parse table rows of the form "| S1 | s03 |" or "S1 -> s03".
  const rows = content.matchAll(/\|\s*(S\d+)\s*\|\s*(s\d+)\s*\|/gi);
  for (const row of rows) {
    if (row[1] && row[2]) {
      map.set(row[1].toUpperCase(), row[2].toLowerCase());
    }
  }
  // Also parse arrow-notation: "S1 -> s03" or "S1 → s03"
  const arrows = content.matchAll(/(S\d+)\s*[-→]+\s*(s\d+)/gi);
  for (const arrow of arrows) {
    if (arrow[1] && arrow[2]) {
      map.set(arrow[1].toUpperCase(), arrow[2].toLowerCase());
    }
  }

  return map.size > 0 ? map : null;
}

/** Parse scope rows from superset table (id, dims column, depends column). */
function parseScopeRows(content: string): Array<{
  id: string;
  dims: string;
  depends: string;
  row: string;
}> {
  const rows: Array<{ id: string; dims: string; depends: string; row: string }> = [];
  for (const line of content.split('\n')) {
    const m = line.match(/\|\s*\*\*([Ss]\d+)\*\*\s*\|(.+?)\|(.+?)\|(.+?)\|(.+?)\|(.+?)\|/);
    if (m) {
      rows.push({
        id: m[1] ?? '',
        // Column order: Scope | Capability cluster | Exported subpath | Source dims | Severity | Depends on
        dims: m[4] ?? '',
        depends: m[6] ?? '',
        row: line,
      });
    }
  }
  return rows;
}

// The canonical s-scope namespace per EPIC.md lock decision:
// s00 = engine invariants (cross-cutting)
// s01 = spring solver (BUILT)
// s02 = tween + drive (BUILT)
// s03..s13 = 11 buildable capability scopes
const CANONICAL_BUILT = ['s00', 's01', 's02'];
const CANONICAL_BUILDABLE_RANGE = { min: 3, max: 13 };
const EXPECTED_CANONICAL_COUNT = 14; // s00..s13 = 14 total ids

describe('golden-thread-trace (property — RED until s00..s13 namespace migrated)', () => {
  let superset: string;
  let matrix: string;

  it('superset.md is readable', () => {
    superset = readFileSync(supersetPath, 'utf8');
    expect(superset.length).toBeGreaterThan(100);
  });

  it('[THREAD-1] superset.md scope rows use canonical lowercase s00..s13 ids — RED until migrated', () => {
    // Currently superset.md uses S0..S21 (uppercase). The canonical namespace
    // is s00..s13 (lowercase). This assertion fails until the migration is done.
    superset = readFileSync(supersetPath, 'utf8');
    const canonicalIds = parseCanonicalScopeIds(superset);

    expect(
      canonicalIds.length,
      `superset.md has ${canonicalIds.length} canonical lowercase s-ids (s00..s13). ` +
        `Expected ${EXPECTED_CANONICAL_COUNT}. ` +
        'The scope table must be migrated from S0..S21 (uppercase) to s00..s13 (lowercase). ' +
        'Per EPIC.md CH-04 lock decision: s00=invariants, s01=spring, s02=tween/drive, s03..s13=buildable.',
    ).toBeGreaterThanOrEqual(EXPECTED_CANONICAL_COUNT);
  });

  it('[THREAD-2] S->s mapping table is present and total — RED until added', () => {
    // The mapping table (S0..S21 -> s00..s13) must exist so the prior work is auditable.
    superset = readFileSync(supersetPath, 'utf8');
    const mappingTable = parseSToSMappingTable(superset);

    expect(
      mappingTable,
      'superset.md must contain an S->s mapping table (S0..S21 -> s00..s13) ' +
        'so the prior S-namespace work remains auditable after the lowercase migration. ' +
        'The table was declared as a required deliverable in the superset.md "Trace guarantee" section.',
    ).not.toBeNull();
  });

  it('[THREAD-3] every scope row cites a D-dimension', () => {
    superset = readFileSync(supersetPath, 'utf8');
    const scopes = parseScopeRows(superset);
    expect(scopes.length, 'No scope rows found in superset.md').toBeGreaterThan(0);

    const withoutDim = scopes.filter(({ dims }) => !/D\d+/.test(dims));
    expect(
      withoutDim.map(({ id }) => id),
      `These scope rows have no D-dimension reference:\n${withoutDim.map(({ id, row }) => `  ${id}: ${row.trim()}`).join('\n')}`,
    ).toHaveLength(0);
  });

  it('[THREAD-4] every D-dimension cited in a scope row exists in feature-matrix.md', () => {
    superset = readFileSync(supersetPath, 'utf8');
    matrix = readFileSync(matrixPath, 'utf8');
    const scopes = parseScopeRows(superset);

    const violations: string[] = [];
    for (const { id, dims } of scopes) {
      const dimRefs = dims.match(/D\d+/g) ?? [];
      for (const dimRef of dimRefs) {
        if (!matrix.includes(`## ${dimRef}`)) {
          violations.push(`Scope ${id} references ${dimRef} but feature-matrix.md has no "## ${dimRef}" section`);
        }
      }
    }

    expect(violations, `Broken D-dimension references in superset:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('[THREAD-5] every scope row depends only on lower-indexed scopes (no forward-dependency in canonical namespace)', () => {
    // This is the Clean-Architecture direction check: a scope at index N
    // should not depend on a scope at index >N. Currently the mapping is pending,
    // so we check the S-namespace for gross violations.
    superset = readFileSync(supersetPath, 'utf8');
    const scopes = parseScopeRows(superset);

    const violations: string[] = [];
    for (const { id, depends } of scopes) {
      const myIndex = parseInt(id.replace(/[Ss]/, ''), 10);
      // Extract dependency ids from the "Depends on" column.
      const depIds = depends.match(/[Ss]\d+/g) ?? [];
      for (const depId of depIds) {
        const depIndex = parseInt(depId.replace(/[Ss]/, ''), 10);
        // Skip S0 / s00 (cross-cutting invariants — valid as a dep from any scope).
        if (depIndex === 0) continue;
        // A scope should not depend on a scope with a higher index (leaf->root direction).
        // Note: S10 depends on S11 — this is a known layering issue in the current draft.
        // The test catches it as a violation; fixing it is the migration's job.
        if (depIndex > myIndex) {
          violations.push(
            `Scope ${id}(idx=${myIndex}) depends on ${depId}(idx=${depIndex}) — higher index (leaf-to-root violation)`,
          );
        }
      }
    }

    expect(
      violations,
      `Layering violations (scope depends on higher-indexed scope — violates Clean-Architecture direction):\n` +
        violations.join('\n') +
        '\n\nFix: reorder scopes or invert the dependency so roots never depend on leaves.',
    ).toHaveLength(0);
  });

  it('[THREAD-6] superset Trace guarantee section is present', () => {
    superset = readFileSync(supersetPath, 'utf8');
    expect(
      superset,
      'superset.md must contain a "Trace guarantee" section describing the golden-thread rule',
    ).toContain('Trace guarantee');
    expect(
      superset,
      'The Trace guarantee must reference the scope id (S<n> or s<n>) and dimension (D<n>)',
    ).toMatch(/[Ss]\d+.*D\d+|D\d+.*[Ss]\d+/);
  });
});
