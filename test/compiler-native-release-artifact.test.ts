import { describe, expect, it } from 'vitest';

import { nativeArtifactLiteral } from '../src/compiler/core.js';
import { nativeDefaultArtifactLiteral } from '../src/compiler/native-default-artifact.js';

/** Канонический путь остаётся независимым оракулом для производного артефакта. */
describe('зафиксированный Native-артефакт compiler', () => {
  it('бит-в-бит совпадает с текущим Native SSOT и MotionProgram-доказательством', () => {
    for (const opacity of [-0, 0, Number.MIN_VALUE, 0.125, 0.5, 1, 123.456, 1e300]) {
      expect(nativeDefaultArtifactLiteral(opacity)).toBe(nativeArtifactLiteral(opacity));
    }
  });

  it('положительный контроль обнаруживает дрейф execution-литерала', () => {
    const oracle = nativeArtifactLiteral(0.5);
    const sabotaged = nativeDefaultArtifactLiteral(0.5).replace('linear(', 'linear(9,');
    expect(sabotaged).not.toBe(oracle);
  });
});
