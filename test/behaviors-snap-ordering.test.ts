import { describe, expect, it } from 'vitest';
import { createBottomSheet } from '../src/behaviors/index.js';

describe('./behaviors — snap ordering representation', () => {
  it('legacy saturated extremes keep numeric snap order across overflow', () => {
    const sheet = createBottomSheet({
      snapPoints: [Number.MAX_VALUE, -Number.MAX_VALUE],
    });

    expect(sheet.state.value).toBe(-Number.MAX_VALUE);
    expect(sheet.state.snapIndex).toBe(0);

    sheet.snapTo(1);
    expect(sheet.state.value).toBe(Number.MAX_VALUE);
    expect(sheet.state.snapIndex).toBe(1);
  });
});
