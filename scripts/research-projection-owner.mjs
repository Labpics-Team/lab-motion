import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { canonicalGzip, observationalBrotli } from './compression-oracle.mjs';

const BASE = 'fe11daa407de396fad952be7679650f63dabd4dd';
const run = (command, args = []) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const show = (title, text) => console.log(`\n===== ${title} =====\n${text}`);

console.log(`BASE=${BASE}`);
show('baseline build', run('pnpm', ['build']));
cpSync('dist', '/tmp/lm-projection-owner-base-dist', { recursive: true });
const baseSize = run('pnpm', ['size']);
show('BASE SIZE', baseSize);

const path = 'src/projection/dom.ts';
let source = readFileSync(path, 'utf8');
const replace = (before, after) => {
  if (!source.includes(before)) throw new Error(`source precondition missing:\n${before}`);
  source = source.replace(before, after);
};
replace(
  `      const measured: Measured[] = [];\n      const measuredIds = new Set<string>();\n      for (const cap of captured.values()) {\n`,
  `      const measured: Measured[] = [];\n      for (const cap of captured.values()) {\n`,
);
replace(
  `        } catch {\n          continue; // узел исчез между capture и play — тихая деградация\n        }\n`,
  `        } catch {\n          captured.delete(cap.el);\n          continue; // узел исчез между capture и play — тихая деградация\n        }\n`,
);
replace(
  `        measured.push({ cap, last, radiiLast });\n        measuredIds.add(cap.id);\n`,
  `        measured.push({ cap, last, radiiLast });\n`,
);
replace(
  `            const entry = byEl.get(cursor);\n            terminal = entry !== undefined && measuredIds.has(entry.id) ? entry.id : memo;\n`,
  `            const entry = byEl.get(cursor);\n            terminal = entry !== undefined ? entry.id : memo;\n`,
);
replace(
  `          const entry = byEl.get(node);\n          if (entry !== undefined && measuredIds.has(entry.id)) answer = entry.id;\n`,
  `          const entry = byEl.get(node);\n          if (entry !== undefined) answer = entry.id;\n`,
);
writeFileSync(path, source);

if (source.includes('measuredIds')) throw new Error('measurement membership Set still exists');
const cycleSetCount = (source.match(/new Set<DomProjectionElement>/g) ?? []).length;
if (cycleSetCount !== 1) throw new Error(`expected only ancestor-cycle Set, got ${cycleSetCount}`);
if (!source.includes('captured.delete(cap.el)')) throw new Error('failed LAST measurement does not leave single owner');
let positive = source.replace(
  `      const measured: Measured[] = [];\n`,
  `      const measured: Measured[] = [];\n      const measuredIds = new Set<string>();\n`,
);
if (!positive.includes('measuredIds')) throw new Error('positive control did not mutate');
const oracle = (s) => !s.includes('measuredIds');
if (!oracle(source) || oracle(positive)) throw new Error('structural oracle positive control failed');
console.log('STRUCTURAL_ORACLE=' + JSON.stringify({ measurementMembershipSet: 0, ancestorCycleSet: cycleSetCount, failureDelete: true, positiveControl: 'RED' }));

const testPath = 'test/projection-dom.test.ts';
const semanticTest = `\n\ndescribe('projection/dom: failed LAST measurement ownership', () => {\n  it('drops a failed captured ancestor while a measured descendant keeps projecting as a root', () => {\n    const world = makeWorld();\n    const clock = makeClock();\n    const P = world.el('P-failed', P_FIRST);\n    const C = world.el('C-survives', C_FIRST, { parent: P });\n    const dom = createDomProjection(domOptions(world, clock));\n\n    dom.capture([P, C]);\n    P.getBoundingClientRect = () => {\n      throw new Error('detached before LAST measurement');\n    };\n    C.rect = { x: 30, y: 10, width: 20, height: 20 };\n\n    expect(() => dom.play()).not.toThrow();\n    expect(flightTransformWrites(world.writes(P))).toHaveLength(0);\n    const childWrites = flightTransformWrites(world.writes(C));\n    expect(childWrites.length).toBeGreaterThan(0);\n    const first = parseTranslateScale(childWrites[0].value!)!;\n    expect(first.tx).toBeCloseTo(-20, 9);\n    expect(first.ty).toBeCloseTo(0, 9);\n  });\n});\n`;
const originalTest = readFileSync(testPath, 'utf8');
if (originalTest.includes('failed LAST measurement ownership')) throw new Error('semantic test already exists');
writeFileSync(testPath, originalTest + semanticTest);

show('candidate typecheck', run('pnpm', ['typecheck']));
show('candidate targeted tests', run('pnpm', ['exec', 'vitest', 'run', 'test/projection-dom.test.ts', 'test/projection-geometry.test.ts', 'test/projection-driver.test.ts']));

// Positive control for the new semantic characterization: keep failed parent in the
// single owner. That must turn the focused test RED, otherwise the test cannot
// protect the ownership invariant this candidate relies on.
writeFileSync(path, source.replace('          captured.delete(cap.el);\n', ''));
let semanticMutationRed = false;
try {
  run('pnpm', ['exec', 'vitest', 'run', 'test/projection-dom.test.ts', '-t', 'drops a failed captured ancestor']);
} catch {
  semanticMutationRed = true;
}
if (!semanticMutationRed) throw new Error('semantic mutation positive control stayed green');
writeFileSync(path, source);
console.log('SEMANTIC_MUTATION=RED');

show('candidate build', run('pnpm', ['build']));
const candidateSize = run('pnpm', ['size']);
show('CANDIDATE SIZE', candidateSize);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:js|cjs)$/.test(name)) out.push(p);
  }
  return out;
};
const rows = [];
for (const basePath of walk('/tmp/lm-projection-owner-base-dist')) {
  const rel = relative('/tmp/lm-projection-owner-base-dist', basePath);
  const candidatePath = join('dist', rel);
  let baseBytes;
  let candidateBytes;
  try {
    baseBytes = readFileSync(basePath);
    candidateBytes = readFileSync(candidatePath);
  } catch {
    continue;
  }
  if (Buffer.compare(baseBytes, candidateBytes) === 0) continue;
  const base = { raw: baseBytes.length, gzip: canonicalGzip(baseBytes).length, brotli: observationalBrotli(baseBytes).length };
  const candidate = { raw: candidateBytes.length, gzip: canonicalGzip(candidateBytes).length, brotli: observationalBrotli(candidateBytes).length };
  rows.push({ file: rel, base, candidate, delta: { raw: candidate.raw - base.raw, gzip: candidate.gzip - base.gzip, brotli: candidate.brotli - base.brotli } });
}
console.log('DIST_PARETO=' + JSON.stringify(rows));
const badDist = rows.filter(({ delta }) => delta.raw > 0 || delta.gzip > 0 || delta.brotli > 0);
if (badDist.length) throw new Error('protected dist regression: ' + JSON.stringify(badDist));

writeFileSync('/tmp/base-size.txt', baseSize);
writeFileSync('/tmp/candidate-size.txt', candidateSize);
show('candidate source diff', run('git', ['diff', '--', path]));
show('candidate test diff', run('git', ['diff', '--', testPath]));
console.log('EVIDENCE_RESULT=PASS');