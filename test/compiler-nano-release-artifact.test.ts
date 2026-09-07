import { describe, expect, it } from 'vitest';

import { nanoArtifactLiteral } from '../src/compiler/core.js';
import { nanoDefaultArtifactLiteral } from '../src/compiler/nano-default-artifact.js';

/** Канонический путь остаётся независимым оракулом для производного артефакта. */
describe('зафиксированный Nano-артефакт compiler', () => {
  it('бит-в-бит совпадает с текущим Nano SSOT и MotionProgram-доказательством', () => {
    for (const opacity of [-0, 0, Number.MIN_VALUE, 0.125, 0.5, 1, 123.456, 1e300]) {
      expect(nanoDefaultArtifactLiteral(opacity)).toBe(nanoArtifactLiteral(opacity));
    }
  });

  it('положительный контроль обнаруживает дрейф execution-литерала', () => {
    const oracle = nanoArtifactLiteral(0.5);
    const sabotaged = nanoDefaultArtifactLiteral(0.5).replace('linear(', 'linear(9,');
    expect(sabotaged).not.toBe(oracle);
  });
});
