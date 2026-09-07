import { describe, expect, it } from 'vitest';

import { nanoArtifactLiteral } from '../src/compiler/core.js';
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
});
