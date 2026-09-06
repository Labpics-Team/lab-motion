/** Общий синхронный workspace не хранит промежуточный sample на каждой поверхности. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/index.js';
import * as readers from '../src/internal/read-spring.js';
import { sampleSpringBasisUnchecked } from '../src/internal/solver.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const springs = [
  { mass: 1, stiffness: 100, damping: 5 },
  { mass: 1, stiffness: 100, damping: 20 },
  { mass: 1, stiffness: 100, damping: 80 },
];

afterEach(() => vi.restoreAllMocks());

describe('animate: batch-owned spring workspace', () => {
  for (const spring of springs) {
    it(`все проекции используют workspace batch: damping=${spring.damping}`, () => {
      const outputs = new Set<object>();
      const bases = new Set<object>();
      let aliased = true;
      const read = readers.readSpringFromBasisUnchecked;
      const sample = readers.sampleSpringFromBasisUnchecked;
      const observe = (basis: object, out: object): void => {
        bases.add(basis);
        outputs.add(out);
        aliased &&= out === basis;
      };
      vi.spyOn(readers, 'readSpringFromBasisUnchecked').mockImplementation((basis, from, to, v0, out) => {
        observe(basis, out);
        return read(basis, from, to, v0, out);
      });
      vi.spyOn(readers, 'sampleSpringFromBasisUnchecked').mockImplementation((basis, v0, out) => {
        observe(basis, out);
        return sample(basis, v0, out);
      });
      const clock = makeClock();
      const targets = Array.from({ length: 100 }, () => fakeEl({ width: '1px' }));
      const controls = animate(targets.map((target) => target.el), {
        x: [0, 100], y: [30, -70], opacity: [1, 0.4], width: ['1px', '101px'],
      }, { spring, stagger: 0.05, requestFrame: clock.requestFrame });
      try {
        clock.step(16);
        clock.step(16);
        clock.step(16);
        // gap — 0.05 ms; после второго кадра активны все 100 целей.
        // Проверяется факт каждой записи, а не только ожидаемый ход часов.
        for (const target of targets) {
          expect(new Set(target.writes.map((write) => write.prop))).toEqual(
            new Set(['transform', 'opacity', 'width']),
          );
        }
        expect(aliased).toBe(true);
        expect(bases.size).toBe(1);
        expect(outputs.size).toBe(1);
        expect(readers.readSpringFromBasisUnchecked).toHaveBeenCalled();
        expect(readers.sampleSpringFromBasisUnchecked).toHaveBeenCalled();
      } finally {
        controls.cancel();
        clock.step(16);
      }
    });
  }

  it('разные batch не делят mutable workspace даже при реентрантном host-write', () => {
    const bases = new Set<object>();
    let aliased = true;
    const read = readers.readSpringFromBasisUnchecked;
    vi.spyOn(readers, 'readSpringFromBasisUnchecked').mockImplementation((basis, from, to, v0, out) => {
      bases.add(basis);
      aliased &&= out === basis;
      return read(basis, from, to, v0, out);
    });
    const leftClock = makeClock();
    const rightClock = makeClock();
    const right = animate(fakeEl().el, { x: [0, 300] }, {
      spring: springs[2], requestFrame: rightClock.requestFrame,
    });
    const leftTarget = fakeEl();
    const write = leftTarget.el.style.setProperty;
    let reentered = false;
    leftTarget.el.style.setProperty = (name, value): void => {
      write(name, value);
      if (!reentered) {
        reentered = true;
        right.seek(37);
      }
    };
    const left = animate(leftTarget.el, { x: [0, 100] }, {
      spring: springs[0], requestFrame: leftClock.requestFrame,
    });
    try {
      leftClock.step(16);
      leftClock.step(16);
      expect(reentered).toBe(true);
      expect(aliased).toBe(true);
      expect(bases.size).toBe(2);
    } finally {
      left.cancel();
      right.cancel();
      leftClock.step(16);
      rightClock.step(16);
    }
  });

  it('проекция в тот же объект сохраняет коэффициенты и точный отдельный результат', () => {
    const workspace = {
      _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0, value: 0, velocity: 0,
    };
    const separate = { value: 0, velocity: 0 };
    for (const spring of springs) {
      for (const t of [0, Number.MIN_VALUE, 1e-200, 0.001, 0.3, 10, Infinity, NaN]) {
        sampleSpringBasisUnchecked(spring, t, workspace);
        const coefficients = [workspace._value, workspace._valueV0, workspace._velocity, workspace._velocityV0];
        for (const v0 of [-Number.MAX_VALUE, -3, -0, 0, 7, Number.MAX_VALUE]) {
          readers.sampleSpringFromBasisUnchecked(workspace, v0, separate);
          readers.sampleSpringFromBasisUnchecked(workspace, v0, workspace);
          expect(Object.is(workspace.value, separate.value)).toBe(true);
          expect(Object.is(workspace.velocity, separate.velocity)).toBe(true);
          readers.readSpringFromBasisUnchecked(workspace, -120, 340, v0, separate);
          readers.readSpringFromBasisUnchecked(workspace, -120, 340, v0, workspace);
          expect(Object.is(workspace.value, separate.value)).toBe(true);
          expect(Object.is(workspace.velocity, separate.velocity)).toBe(true);
          expect([workspace._value, workspace._valueV0, workspace._velocity, workspace._velocityV0]).toEqual(coefficients);
        }
      }
    }
  });
});
