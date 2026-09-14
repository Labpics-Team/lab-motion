import { expect, it, vi } from 'vitest';
import { createReorder } from '../src/behaviors/reorder/index.js';

const row = () => ['a', 'b', 'c'].map((key, i) => ({
  key,
  rect: { x: i * 40, y: 0, width: 20, height: 20 },
}));

// Exact-head review regression: an unsupported axis key must be observationally inert.
it('orthogonal keyboard no-op preserves the outstanding proposal', () => {
  const onReorder = vi.fn();
  const state = createReorder({ items: row(), axis: 'x', onReorder });
  const session = state.start('a')!;

  session.step('next');
  expect(onReorder).toHaveBeenCalledTimes(1);
  const proposal = onReorder.mock.calls[0]![1];
  expect(state.isCurrent(proposal)).toBe(true);

  session.step('up');

  expect(onReorder).toHaveBeenCalledTimes(1);
  expect(state.isCurrent(proposal)).toBe(true);
});
