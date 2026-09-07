import { describe, expect, it } from 'vitest';
import { parseAstAsync } from 'vite';

import {
  nanoArtifactLiteral,
  planNanoOpacityLowering,
  type AstNode,
} from '../src/compiler/core.js';
import { nanoDefaultArtifactLiteral } from '../src/compiler/nano-default-artifact.js';

/**
 * Package-boundary attestation for the release-frozen default Nano artifact.
 * `nanoArtifactLiteral` is intentionally the expensive independent oracle: it
 * rebuilds `springLinear()`, constructs MotionProgram V1, parses it through the
 * canonical parser and projects it back before returning a literal.
 */
describe('release-frozen compiler Nano artifact', () => {
  it('is bit-identical to the current Nano SSOT + MotionProgram proof', () => {
    for (const opacity of [-0, 0, Number.MIN_VALUE, 0.125, 0.5, 1, 123.456, 1e300]) {
      expect(nanoDefaultArtifactLiteral(opacity)).toBe(nanoArtifactLiteral(opacity));
    }
  });

  it('positive control detects execution-literal drift', () => {
    const oracle = nanoArtifactLiteral(0.5);
    const sabotaged = nanoDefaultArtifactLiteral(0.5).replace('linear(', 'linear(9,');
    expect(sabotaged).not.toBe(oracle);
  });

  it('paired lowering proof detects the eliminated per-call build work', async () => {
    const code = `import { animate } from '@labpics/motion/nano';
export function run(a,b,c,d,e,f,g,h) {
  animate(a,{opacity:0.125}); animate(b,{opacity:0.25});
  animate(c,{opacity:0.375}); animate(d,{opacity:0.5});
  animate(e,{opacity:0.625}); animate(f,{opacity:0.75});
  animate(g,{opacity:0.875}); return animate(h,{opacity:1});
}`;
    const ast = await parseAstAsync(code) as unknown as AstNode;

    const baseline = planNanoOpacityLowering(ast, code, nanoArtifactLiteral);
    const candidate = planNanoOpacityLowering(ast, code, nanoDefaultArtifactLiteral);
    expect(candidate).toEqual(baseline);
    expect(candidate?.edits).toHaveLength(8);

    // Deliberate positive performance control: same lowering, but each artifact
    // performs one additional canonical package-build proof. If this cannot be
    // distinguished from baseline, this runner is too noisy for the candidate.
    const slowed = (opacity: number): string => {
      nanoArtifactLiteral(opacity);
      return nanoArtifactLiteral(opacity);
    };

    const iterations = 12;
    const blocks = 8;
    let sink = 0;
    const measure = (literal: (opacity: number) => string): number => {
      const start = process.hrtime.bigint();
      for (let index = 0; index < iterations; index++) {
        sink ^= planNanoOpacityLowering(ast, code, literal)?.edits.length ?? 0;
      }
      return Number(process.hrtime.bigint() - start) / iterations;
    };
    const median = (values: readonly number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length & 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };

    // Warm both implementations before the paired ABBA/BAAB blocks.
    measure(nanoArtifactLiteral);
    measure(nanoDefaultArtifactLiteral);
    measure(slowed);

    const candidateRatios: number[] = [];
    const positiveRatios: number[] = [];
    for (let block = 0; block < blocks; block++) {
      const baseSamples: number[] = [];
      const candidateSamples: number[] = [];
      const positiveSamples: number[] = [];
      const order = block % 2 === 0
        ? [nanoArtifactLiteral, nanoDefaultArtifactLiteral, slowed, slowed, nanoDefaultArtifactLiteral, nanoArtifactLiteral]
        : [slowed, nanoDefaultArtifactLiteral, nanoArtifactLiteral, nanoArtifactLiteral, nanoDefaultArtifactLiteral, slowed];
      for (const literal of order) {
        const elapsed = measure(literal);
        if (literal === nanoArtifactLiteral) baseSamples.push(elapsed);
        else if (literal === nanoDefaultArtifactLiteral) candidateSamples.push(elapsed);
        else positiveSamples.push(elapsed);
      }
      const baseNs = (baseSamples[0]! + baseSamples[1]!) / 2;
      candidateRatios.push(((candidateSamples[0]! + candidateSamples[1]!) / 2) / baseNs);
      positiveRatios.push(((positiveSamples[0]! + positiveSamples[1]!) / 2) / baseNs);
    }

    const candidateMedian = median(candidateRatios);
    const positiveMedian = median(positiveRatios);
    console.log('compiler-release-partial-eval paired proof', JSON.stringify({
      blocks,
      iterations,
      candidate_over_baseline_median: candidateMedian,
      candidate_over_baseline_min: Math.min(...candidateRatios),
      candidate_over_baseline_max: Math.max(...candidateRatios),
      positive_over_baseline_median: positiveMedian,
      positive_over_baseline_min: Math.min(...positiveRatios),
      positive_over_baseline_max: Math.max(...positiveRatios),
      sink,
    }));

    // The admission threshold is intentionally far looser than the expected
    // effect. It proves a product-relevant transform-stage win rather than a
    // timer-scale fluctuation, while the positive control proves sensitivity.
    expect(candidateMedian).toBeLessThan(0.8);
    expect(positiveMedian).toBeGreaterThan(1.2);
  });
});
