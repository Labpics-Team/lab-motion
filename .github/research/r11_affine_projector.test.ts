import { describe, expect, it } from 'vitest';
import { createProjector, type BoxRadii } from '../src/projection/geometry.js';

function radii(x: number): BoxRadii {
  return [
    { x, y: x },
    { x, y: x },
    { x, y: x },
    { x, y: x },
  ];
}

describe('projection affine primitive ownership', () => {
  it('keeps the exact terminal radius on hostile finite endpoints', () => {
    const terminal = Number.MIN_VALUE;
    const projector = createProjector([
      {
        id: 'n',
        first: { x: 0, y: 0, width: 100, height: 100 },
        last: { x: 0, y: 0, width: 100, height: 100 },
        radii: { first: radii(100), last: radii(terminal) },
      },
    ]);

    const frame = projector.at(1)[0];
    expect(frame.radii).toBeDefined();
    for (const corner of frame.radii!) {
      expect(corner.x).toBe(terminal);
      expect(corner.y).toBe(terminal);
    }
  });
});
