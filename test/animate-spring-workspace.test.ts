/** Численный модуль владеет scratch; batch выдаёт только readonly-базис. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/animate/index.js';
import { SurfaceBatch, type SurfaceUnit } from '../src/animate/surface-batch.js';
import * as readers from '../src/internal/read-spring.js';
import * as channels from '../src/animate/channels.js';
import { sampleSpringBasisUnchecked } from '../src/internal/solver.js';
import { fakeEl, makeClock } from './animate-facade-helpers.js';

const springs = [
  { mass: 1, stiffness: 100, damping: 5 },
  { mass: 1, stiffness: 100, damping: 20 },
  { mass: 1, stiffness: 100, damping: 80 },
];

afterEach(() => vi.restoreAllMocks());

describe('animate: borrowed numeric projection', () => {
  it('сохраняет бюджет прямых object-ссылок живых и завершённых MainUnit', () => {
    const units: SurfaceUnit[] = [];
    const add = SurfaceBatch.prototype._add;
    vi.spyOn(SurfaceBatch.prototype, '_add').mockImplementation(function (unit, paused) {
      units.push(unit);
      return add.call(this, unit, paused);
    });
    // Структурный ratchet прямых собственных ссылок, не оценка всей retained heap.
    // Symbols/non-enumerable входят; замыкания и native/private slots — отдельный heap-proof.
    const objects = (unit: SurfaceUnit): object[] => Reflect.ownKeys(unit)
      .map((key) => Object.getOwnPropertyDescriptor(unit, key)?.value)
      .filter((value): value is object => value !== null && typeof value === 'object');
    for (const count of [1, 1000]) {
      for (const mode of [{ spring: springs[0] }, { duration: 1000 }]) {
        units.length = 0;
        const clock = makeClock();
        const controls = animate(
          Array.from({ length: count }, () => fakeEl().el),
          { x: [0, 100], opacity: [1, 0.4] },
          { ...mode, requestFrame: clock.requestFrame },
        );
        try {
          expect(units).toHaveLength(count * 2);
          // Единственный объект unit — его options с owner-state. Временный
          // результат принадлежит численному модулю, даже если никто его не использует.
          for (const unit of units) expect(objects(unit)).toHaveLength(1);
          clock.step(16);
          clock.step(16);
          for (const unit of units) expect(objects(unit)).toHaveLength(1);
        } finally {
          controls.cancel();
          clock.step(16);
        }
        // Сами controls ещё удерживаются: cleanup не зависит от их GC.
        for (const unit of units) expect(objects(unit)).toHaveLength(0);
      }
    }
  });

  for (const spring of springs) {
    it(`все проекции используют один scratch без изменения коэффициентов: damping=${spring.damping}`, () => {
      const outputs = new Set<object>();
      const bases = new Set<object>();
      let separate = true;
      let coefficientsIntact = true;
      const read = readers.readSpringFromBasisUnchecked;
      const sample = readers.sampleSpringFromBasisUnchecked;
      const observe = (basis: object, out: object): void => {
        bases.add(basis);
        outputs.add(out);
        separate &&= out !== basis;
      };
      vi.spyOn(readers, 'readSpringFromBasisUnchecked').mockImplementation((basis, from, to, v0) => {
        const coefficients = { ...basis };
        const out = read(basis, from, to, v0);
        coefficientsIntact &&= Object.keys(coefficients).every((key) => Object.is(basis[key as keyof typeof basis], coefficients[key as keyof typeof basis]));
        observe(basis, out);
        return out;
      });
      vi.spyOn(readers, 'sampleSpringFromBasisUnchecked').mockImplementation((basis, v0) => {
        const coefficients = { ...basis };
        const out = sample(basis, v0);
        coefficientsIntact &&= Object.keys(coefficients).every((key) => Object.is(basis[key as keyof typeof basis], coefficients[key as keyof typeof basis]));
        observe(basis, out);
        return out;
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
        expect(separate).toBe(true);
        expect(coefficientsIntact).toBe(true);
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

  it('заимствование заканчивается до реентрантного host-write в другой batch', () => {
    const bases = new Set<object>();
    const outputs = new Set<object>();
    let separate = true;
    const read = readers.readSpringFromBasisUnchecked;
    vi.spyOn(readers, 'readSpringFromBasisUnchecked').mockImplementation((basis, from, to, v0) => {
      const out = read(basis, from, to, v0);
      bases.add(basis);
      outputs.add(out);
      separate &&= out !== basis;
      return out;
    });
    const leftClock = makeClock();
    const rightClock = makeClock();
    const rightTarget = fakeEl();
    const right = animate(rightTarget.el, { x: [0, 300] }, {
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
      expect(separate).toBe(true);
      expect(outputs.size).toBe(1);
      expect(bases.size).toBe(2);
      const x = (target: ReturnType<typeof fakeEl>): number => Number(
        /translateX\(([^p]+)px\)/.exec(target.el.style.getPropertyValue('transform'))?.[1] ?? 0,
      );
      const expectedLeft = readers.sampleSpringUnchecked(springs[0]!, 0, 0.016).value * 100;
      const expectedRight = readers.sampleSpringUnchecked(springs[2]!, 0, 0.037).value * 300;
      expect(x(leftTarget)).toBeCloseTo(expectedLeft, 11);
      expect(x(rightTarget)).toBeCloseTo(expectedRight, 11);
    } finally {
      left.cancel();
      right.cancel();
      leftClock.step(16);
      rightClock.step(16);
    }
  });

  it('снимает оба скаляра до форматирования с injected numerical reentry', () => {
    const cssAt = channels.cssAt;
    vi.spyOn(channels, 'cssAt').mockImplementation((channel, progress) => {
      const rendered = cssAt(channel, progress);
      // Fault injection: соседний вызов численного модуля не должен сделать
      // текущую кривую settled. Это не публичный callback форматтера.
      readers.sampleSpringFromBasisUnchecked({
        _value: 1, _valueV0: 0, _velocity: 0, _velocityV0: 0,
      }, 0);
      return rendered;
    });
    const target = fakeEl({ width: '0px' });
    const clock = makeClock();
    const complete = vi.fn();
    const control = animate(target.el, { width: ['0px', '100px'] }, {
      spring: springs[1], requestFrame: clock.requestFrame, onComplete: complete,
    });
    try {
      clock.step(0);
      clock.step(16);
      const value = parseFloat(target.el.style.getPropertyValue('width'));
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(100);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      control.cancel();
      clock.step(32);
    }
  });

  it('сохраняет битовый результат прежней проекции и не меняет readonly-базис', () => {
    const shared = { _value: 0, _valueV0: 0, _velocity: 0, _velocityV0: 0 };
    const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
    const outputs = new Set<object>();
    for (const spring of springs) {
      for (const t of [0, Number.MIN_VALUE, 1e-200, 0.001, 0.3, 10, Infinity, NaN]) {
        sampleSpringBasisUnchecked(spring, t, shared);
        const coefficients = Object.freeze({ ...shared });
        for (const v0 of [-Number.MAX_VALUE, -3, -0, 0, 7, Number.MAX_VALUE]) {
          const value = finite(coefficients._value + v0 * coefficients._valueV0, 1);
          const velocity = finite(coefficients._velocity + v0 * coefficients._velocityV0, 0);
          const sample = readers.sampleSpringFromBasisUnchecked(coefficients, v0);
          outputs.add(sample);
          expect(Object.is(sample.value, value)).toBe(true);
          expect(Object.is(sample.velocity, velocity)).toBe(true);
          for (const [from, to] of [[-120, 340], [-Number.MAX_VALUE, Number.MAX_VALUE], [-0, 0]]) {
            const range = to! - from!;
            const expectedValue = finite(from! + value * range, to!);
            const expectedVelocity = finite(velocity * range, 0);
            const state = readers.readSpringFromBasisUnchecked(coefficients, from!, to!, v0);
            outputs.add(state);
            expect(Object.is(state.value, expectedValue)).toBe(true);
            expect(Object.is(state.velocity, expectedVelocity)).toBe(true);
          }
          expect(coefficients).toEqual(shared);
        }
      }
    }
    expect(outputs.size).toBe(1);
  });
});
