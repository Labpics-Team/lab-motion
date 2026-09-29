import { describe, expect, it, vi } from 'vitest';
import { createMotionBinding } from '../src/bindings/index.js';
import { createReorder, type ReorderProposal } from '../src/behaviors/reorder/index.js';
import { createPress } from '../src/gestures/index.js';

const point = (t: number) => ({ x: 0, y: 0, t });
const rect = (x: number, y = 0) => ({ x, y, width: 20, height: 20 });

describe('motion-composition/1: cross-owner signal laws', () => {
  it('state idempotence cannot stand in for a repeatable event', () => {
    const statePort = vi.fn();
    const state = createMotionBinding(
      (model: { selected: boolean; revision: number }) => ({
        surface: { opacity: model.selected ? 1 : 0 },
      }),
      { surface: statePort },
    );

    state.update({ selected: true, revision: 1 });
    state.update({ selected: true, revision: 2 });
    expect(statePort).toHaveBeenCalledTimes(1);

    const onPress = vi.fn();
    const event = createPress({ onPress });
    event.pointerDown(point(0));
    event.pointerUp(point(0.01));
    event.pointerDown(point(0.02));
    event.pointerUp(point(0.03));

    expect(event.pressing).toBe(false);
    expect(onPress).toHaveBeenCalledTimes(2);
    state.destroy();
  });

  it('a successful geometry snapshot invalidates a proposal derived from the previous snapshot', () => {
    let proposal: ReorderProposal<string> | undefined;
    const items = [
      { key: 'a', rect: rect(0) },
      { key: 'b', rect: rect(30) },
    ] as const;
    const reorder = createReorder({
      items,
      axis: 'x',
      onReorder: (_keys, next) => { proposal = next; },
    });

    const session = reorder.start('a');
    expect(session).toBeDefined();
    session!.step('next');
    expect(proposal).toBeDefined();
    expect(reorder.isCurrent(proposal!)).toBe(true);

    // Даже численно эквивалентный успешный snapshot является новой geometry boundary.
    reorder.update([
      { key: 'a', rect: rect(0) },
      { key: 'b', rect: rect(30) },
    ]);

    expect(session!.active).toBe(true);
    expect(reorder.isCurrent(proposal!)).toBe(false);
    reorder.destroy();
  });

  it('linked transform components are delivered as one whole role', () => {
    const transform = vi.fn();
    const binding = createMotionBinding(
      (model: { x: number; y: number }) => ({ transform: { x: model.x, y: model.y } }),
      { transform },
    );

    binding.update({ x: 0, y: 20 });
    binding.update({ x: 40, y: 20 });

    expect(transform).toHaveBeenCalledTimes(2);
    expect(transform.mock.calls[1]![0]).toEqual({ x: 40, y: 20 });
    binding.destroy();
  });
});
