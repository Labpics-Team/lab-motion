import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useMotionValue, useSpring } from '../src/vue/index.js';

const SPRING = { mass: 1, stiffness: 300, damping: 30 } as const;

function makeClock() {
  const frames: Array<(time?: number) => void> = [];
  let now = 0;
  return {
    requestFrame(callback: (time?: number) => void): number {
      frames.push(callback);
      return 1;
    },
    step(): void {
      now += 16;
      for (const callback of frames.splice(0)) callback(now);
    },
    pending: () => frames.length,
  };
}

describe('Vue: владение анимацией в effectScope', () => {
  it('stop освобождает активное значение и делает уже поставленный кадр инертным', () => {
    const scope = effectScope();
    const clock = makeClock();
    const mv = scope.run(() => useMotionValue(0, SPRING, clock.requestFrame))!;
    const changes: number[] = [];
    mv.onChange(value => changes.push(value));
    try {
      mv.setTarget(100);
      clock.step();
      clock.step();
      expect(mv.value).toBeGreaterThan(0);
      expect(changes.length).toBeGreaterThan(1);
      expect(clock.pending()).toBe(1);
      const before = [...changes];

      scope.stop();
      clock.step();
      mv.setTarget(200);
      const lateListener = vi.fn();
      const off = mv.onChange(lateListener);

      expect(changes).toEqual(before);
      expect(lateListener).not.toHaveBeenCalled();
      expect(clock.pending()).toBe(0);
      off();
    } finally {
      scope.stop();
      mv.destroy();
    }
  });

  it('useSpring прекращает движение и наблюдение цели вместе со scope', async () => {
    const scope = effectScope();
    const sibling = effectScope();
    const clock = makeClock();
    const target = ref(0);
    const value = scope.run(() => useSpring(target, SPRING, 'instant', clock.requestFrame))!;
    const neighbor = sibling.run(() => useMotionValue(0, SPRING, clock.requestFrame))!;
    try {
      target.value = 100;
      await nextTick();
      neighbor.setTarget(100);
      clock.step();
      clock.step();
      expect(value.value).toBeGreaterThan(0);
      expect(neighbor.value).toBeGreaterThan(0);
      const stoppedValue = value.value;
      const liveValue = neighbor.value;

      scope.stop();
      target.value = 200;
      await nextTick();
      clock.step();

      expect(value.value).toBe(stoppedValue);
      expect(neighbor.value).toBeGreaterThan(liveValue);
      expect(clock.pending()).toBe(1);
      sibling.stop();
      clock.step();
      expect(clock.pending()).toBe(0);
    } finally {
      scope.stop();
      sibling.stop();
      neighbor.destroy();
    }
  });

  it('вне scope MotionValue сохраняет явный destroy без lifecycle-предупреждений', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = makeClock();
    const mv = useMotionValue(0, SPRING, clock.requestFrame);
    try {
      mv.setTarget(100);
      clock.step();
      clock.step();
      expect(mv.value).toBeGreaterThan(0);
      const before = mv.value;
      mv.destroy();
      clock.step();
      mv.setTarget(200);
      expect(mv.value).toBe(before);
      expect(clock.pending()).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      mv.destroy();
      warn.mockRestore();
    }
  });
});
