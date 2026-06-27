import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Test: subpath-graph-acyclic
 * Class: property
 *
 * Property: the exported-subpath dependency graph in superset.md is a DAG in
 * Clean-Architecture direction. Roots have no inbound dependencies from leaves.
 * Closes the cyclic-dependency CLASS, not one edge.
 *
 * Algorithm: parse the "Depends on" column for every scope row.
 * Build a directed adjacency list (scope -> deps). Run DFS cycle detection.
 * If any strongly-connected component has size > 1, the graph is cyclic.
 *
 * BITE PROOF — how="mutation":
 *   The current superset.md graph is a DAG (no cycles confirmed by manual trace).
 *   Bite is proven by mutation: in a scratch copy, change S5's "Depends on"
 *   column to include "S6" (S5 depends on S6 AND S6 depends on S5 → cycle).
 *   The DFS cycle detection immediately reports the cycle.
 *   Restore the original content after confirming the test fails.
 *
 *   Additionally, S10 depends on S11 (S10=scroll → S11=WAAPI) but S11 does NOT
 *   depend on S10 — so that specific edge is NOT a cycle. The test confirms this.
 *
 * Clean-Architecture direction rule:
 *   Higher-level scopes (more specific features) may depend on lower-level scopes
 *   (more foundational). The direction is: leaf → root (leaf is the dependent,
 *   root is the dependency). A cycle means two scopes are mutually dependent,
 *   which violates the Clean-Architecture layering.
 */

const here = dirname(fileURLToPath(import.meta.url));
const supersetPath = resolve(here, '..', 'docs', 'research', 'superset.md');

/** Parse the scope dependency graph from superset.md.
 *  Returns a Map from scope-id (string) to array of dependency scope-ids.
 */
function parseDependencyGraph(content: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const line of content.split('\n')) {
    // Match scope table rows: | **S1** | ... | ... | ... | ... | deps |
    // Column order: Scope | Capability | Subpath | Dims | Severity | Depends on
    const m = line.match(/^\|\s*\*\*([Ss]\d+)\*\*\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|/);
    if (!m) continue;

    const scopeId = m[1] ?? '';
    const depsCell = m[6] ?? ''; // Last column: "Depends on"

    // Extract all scope references from the deps cell.
    const depIds = depsCell.match(/[Ss]\d+/g) ?? [];

    graph.set(scopeId.toUpperCase(), depIds.map((d) => d.toUpperCase()));
  }

  return graph;
}

/**
 * Detect cycles in a directed graph using iterative DFS with 3-color marking.
 * Returns an array of cycle descriptions (empty = DAG).
 */
function detectCycles(graph: Map<string, string[]>): string[] {
  // Colors: 0=WHITE(unvisited), 1=GRAY(in-progress), 2=BLACK(done)
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const cycles: string[] = [];

  for (const node of graph.keys()) {
    color.set(node, 0);
    parent.set(node, null);
  }

  function dfs(start: string): void {
    const stack: Array<{ node: string; state: 'enter' | 'exit' }> = [{ node: start, state: 'enter' }];

    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const { node, state } = frame;

      if (state === 'exit') {
        color.set(node, 2); // BLACK
        continue;
      }

      if ((color.get(node) ?? 0) === 2) continue; // Already fully processed.
      if ((color.get(node) ?? 0) === 1) continue; // Already in stack (cycle was reported).

      color.set(node, 1); // GRAY — in DFS stack
      stack.push({ node, state: 'exit' }); // Schedule exit processing.

      for (const dep of (graph.get(node) ?? [])) {
        if ((color.get(dep) ?? 0) === 1) {
          // Back edge → cycle found.
          cycles.push(`Cycle detected: ${node} -> ${dep} (${dep} is already on the DFS stack)`);
        } else if ((color.get(dep) ?? 0) === 0) {
          parent.set(dep, node);
          stack.push({ node: dep, state: 'enter' });
        }
      }
    }
  }

  for (const node of graph.keys()) {
    if ((color.get(node) ?? 0) === 0) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Find Clean-Architecture direction violations:
 * A scope at a higher build-order level should not depend on a later-level scope.
 * We approximate build-order by the scope numeric index.
 */
function findDirectionViolations(graph: Map<string, string[]>): string[] {
  const violations: string[] = [];

  for (const [node, deps] of graph) {
    const nodeIdx = parseInt(node.replace(/[Ss]/, ''), 10);
    for (const dep of deps) {
      const depIdx = parseInt(dep.replace(/[Ss]/, ''), 10);
      // Skip S0/s0 — cross-cutting invariants, valid dep from any scope.
      if (depIdx === 0) continue;
      if (depIdx > nodeIdx) {
        violations.push(
          `${node}(idx=${nodeIdx}) depends on ${dep}(idx=${depIdx}) — higher-index dep (potential layering issue)`,
        );
      }
    }
  }

  return violations;
}

describe('subpath-graph-acyclic (property — mutation-proven DAG check)', () => {
  let superset: string;

  it('superset.md is readable and contains scope rows', () => {
    superset = readFileSync(supersetPath, 'utf8');
    const graph = parseDependencyGraph(superset);
    expect(
      graph.size,
      'No scope rows parsed from superset.md — cannot check dependency graph',
    ).toBeGreaterThan(0);
  });

  it('the exported-subpath dependency graph has no cycles (DAG invariant)', () => {
    superset = readFileSync(supersetPath, 'utf8');
    const graph = parseDependencyGraph(superset);

    // Ensure all dependency targets exist as nodes (dangling references would
    // indicate a missing scope, not just a cycle).
    const danglingRefs: string[] = [];
    for (const [node, deps] of graph) {
      for (const dep of deps) {
        // S0 / cross-cutting is always valid even if not in the scope table.
        if (dep === 'S0' || dep === 's0') continue;
        if (!graph.has(dep)) {
          danglingRefs.push(`${node} depends on ${dep} which is not in the scope map`);
        }
      }
    }
    expect(
      danglingRefs,
      `Dangling dependency references in superset scope map:\n${danglingRefs.join('\n')}`,
    ).toHaveLength(0);

    const cycles = detectCycles(graph);
    expect(
      cycles,
      `Dependency CYCLE(s) detected in superset.md subpath graph — graph is NOT a DAG:\n` +
        cycles.join('\n') +
        '\nA cycle means two scopes are mutually dependent, violating Clean-Architecture layering.',
    ).toHaveLength(0);
  });

  it('S10 (Scroll) -> S11 (WAAPI) does not create a cycle', () => {
    // Specific regression: S10 lists S11 as a dependency. Verify S11 does NOT
    // list S10 as a dependency (which would be a cycle).
    superset = readFileSync(supersetPath, 'utf8');
    const graph = parseDependencyGraph(superset);

    const s11Deps = graph.get('S11') ?? graph.get('s11') ?? [];
    const s11DepsNormalized = s11Deps.map((d) => d.toUpperCase());

    expect(
      s11DepsNormalized,
      'S11 (WAAPI) must NOT depend on S10 (Scroll) — that would create a cycle with S10->S11',
    ).not.toContain('S10');
  });

  it('root scopes (S0..S2 or s0..s2) have no dependencies outside themselves', () => {
    // The root scopes (engine invariants, spring solver, tween/drive) must not
    // depend on any non-root scope. They ARE the foundation.
    superset = readFileSync(supersetPath, 'utf8');
    const graph = parseDependencyGraph(superset);

    const ROOT_SCOPES = ['S0', 'S1', 'S2', 's0', 's1', 's2', 'S00', 'S01', 'S02'];
    const violations: string[] = [];

    for (const rootId of ROOT_SCOPES) {
      const deps = graph.get(rootId) ?? graph.get(rootId.toUpperCase()) ?? [];
      const nonRootDeps = deps.filter((d) => {
        const idx = parseInt(d.replace(/[Ss]/, ''), 10);
        return idx > 2;
      });
      if (nonRootDeps.length > 0) {
        violations.push(`Root scope ${rootId} depends on non-root scopes: ${nonRootDeps.join(', ')}`);
      }
    }

    expect(
      violations,
      `Root scopes must not depend on non-root scopes (they are the foundation):\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });

  it('Clean-Architecture direction: no forward-dependency violations that would create cycles', () => {
    // Not all forward deps are bugs (S10->S11 is a known layering choice, not a cycle).
    // But we enumerate them so they are visible and auditable.
    superset = readFileSync(supersetPath, 'utf8');
    const graph = parseDependencyGraph(superset);
    const violations = findDirectionViolations(graph);

    // We log violations but only FAIL if they would introduce a cycle.
    // The actual cycle check is the hard gate.
    if (violations.length > 0) {
      console.warn(
        '[subpath-graph-acyclic] Forward-dep notices (non-fatal unless they create cycles):\n' +
          violations.join('\n'),
      );
    }

    // Re-run cycle check — forward deps are only failures if they create cycles.
    const cycles = detectCycles(graph);
    expect(
      cycles,
      `Forward deps introduced a cycle in the dependency graph:\n${cycles.join('\n')}`,
    ).toHaveLength(0);
  });

  it('the graph has a topological ordering (valid for any DAG)', () => {
    // Kahn's algorithm: if BFS completes with all nodes visited, it is a DAG.
    superset = readFileSync(supersetPath, 'utf8');
    const graph = parseDependencyGraph(superset);

    if (graph.size === 0) {
      // No scope rows = skip (caught by earlier test).
      return;
    }

    // Build reverse graph (dependency -> dependents) for in-degree computation.
    const inDegree = new Map<string, number>();
    const reverseGraph = new Map<string, string[]>();

    for (const [node, deps] of graph) {
      if (!inDegree.has(node)) inDegree.set(node, 0);
      for (const dep of deps) {
        // Ignore S0 which may not be in the table.
        if (!graph.has(dep)) continue;
        inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
        if (!reverseGraph.has(dep)) reverseGraph.set(dep, []);
        reverseGraph.get(dep)!.push(node);
      }
    }

    // BFS from nodes with in-degree 0.
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
    let visited = 0;

    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      for (const dependent of (reverseGraph.get(node) ?? [])) {
        const newDeg = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) queue.push(dependent);
      }
    }

    expect(
      visited,
      `Kahn's algorithm visited ${visited}/${graph.size} nodes — ` +
        `${graph.size - visited} nodes remain unvisited, indicating a cycle exists. ` +
        'The dependency graph is NOT a DAG.',
    ).toBe(graph.size);
  });
});
