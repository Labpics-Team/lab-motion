import { describe, expect, it } from 'vitest';
import { createBottomSheet } from '../src/behaviors/index.js';

describe('./behaviors — reentrant publication ownership', () => {
  it('nested publication cuts off stale outer fanout', () => {
    const sheet = createBottomSheet({ snapPoints: [0, 300] });
    let nested = false;
    const late: Array<{ phase: string; value: number; snapIndex: number }> = [];

    sheet.subscribe((state) => {
      if (state.phase === 'release' && !nested) {
        nested = true;
        sheet.update([0, 100]);
      }
    });
    sheet.subscribe((state) => {
      late.push({ phase: state.phase, value: state.value, snapIndex: state.snapIndex });
    });

    sheet.snapTo(1);

    expect(nested).toBe(true);
    expect(sheet.state).toMatchObject({ value: 100, snapIndex: 1, phase: 'settle' });
    expect(late).toEqual([
      { phase: 'release', value: 0, snapIndex: 1 },
      { phase: 'release', value: 100, snapIndex: 1 },
      { phase: 'settle', value: 100, snapIndex: 1 },
    ]);
  });
});
