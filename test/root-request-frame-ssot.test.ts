import { afterEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  schedule: vi.fn((_cb: (ts?: number) => void): number => 1),
}));

vi.mock('../src/internal/request-frame.js', () => ({
  defaultRequestFrame: shared.schedule,
}));

import { drive } from '../src/drive.js';
import { MotionValue } from '../src/motion-value.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;

afterEach(() => {
  shared.schedule.mockClear();
});

describe('root default scheduler wiring', () => {
  it('drive без инъекции использует общий scheduler', () => {
    void drive({ from: 0, to: 1, spring: SPRING, onStep: () => {} });
    expect(shared.schedule).toHaveBeenCalledOnce();
  });

  it('MotionValue без инъекции использует тот же scheduler', () => {
    const value = new MotionValue({ initial: 0, spring: SPRING });
    value.setTarget(1);
    expect(shared.schedule).toHaveBeenCalledOnce();
    value.destroy();
  });
});
