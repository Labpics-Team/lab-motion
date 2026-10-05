import { describe, expect, it } from 'vitest';
import { createCarousel } from '../src/behaviors/index.js';
import { makeClock, reduceMedia } from './behaviors-helpers.js';

for (const mode of ['immediate', 'reduced', 'frame'] as const) {
  describe(`конечность карусели: ${mode}`, () => {
    for (const operation of ['goTo', 'update'] as const) {
      it(`${operation} сохраняет конечное состояние при переполнении цели`, () => {
        const clock = makeClock();
        const seen: Array<{ value: number; velocity: number; index: number }> = [];
        const carousel = createCarousel({ pageCount: 3,
          pageSize: operation === 'goTo' ? Number.MAX_VALUE : 100,
          index: operation === 'goTo' ? 0 : 2,
          requestFrame: mode === 'immediate' ? undefined : clock.requestFrame,
          matchMedia: mode === 'reduced' ? reduceMedia(true) : undefined,
          onChange: state => { seen.push(state); } });
        try {
          if (operation === 'goTo') carousel.goTo(2);
          else carousel.update(3, Number.MAX_VALUE);
          clock.drain(16);
          expect(seen.length).toBeGreaterThan(0);
          expect(seen.every(s => Number.isFinite(s.value) && Number.isFinite(s.velocity))).toBe(true);
          expect(carousel.state).toMatchObject({ value: Number.MAX_VALUE, velocity: 0,
            phase: 'settle', index: 1 });
          expect(clock.pending()).toBe(0);
        } finally {
          carousel.destroy();
        }
      });
    }
  });
}

it('начальная переполненная позиция конечна, видимый индекс согласован с ней', () => {
  const carousel = createCarousel({ pageCount: 3, pageSize: Number.MAX_VALUE, index: 2 });
  try {
    expect(carousel.state).toMatchObject({ value: Number.MAX_VALUE, index: 1 });
    carousel.update(3, 100);
    expect(carousel.state).toMatchObject({ value: 200, index: 2, phase: 'settle' });
  } finally {
    carousel.destroy();
  }
});

it('обычный программный переход сохраняет точную позицию и страницу', () => {
  const carousel = createCarousel({ pageCount: 3, pageSize: 100 });
  try {
    carousel.goTo(2);
    expect(carousel.state).toMatchObject({ value: 200, velocity: 0, index: 2, phase: 'settle' });
  } finally {
    carousel.destroy();
  }
});
