import { describe, expect, it, vi } from 'vitest';
import { MotionValue, type SpringParams } from '../src/index.js';

const critical = { mass: 1, stiffness: 100, damping: 20 };

function clock() {
  const pending: Array<(timestamp?: number) => void> = [];
  let requests = 0;
  return {
    pending,
    get requests() { return requests; },
    requestFrame(callback: (timestamp?: number) => void) {
      pending.push(callback);
      return ++requests;
    },
    step(timestamp?: number) {
      const scheduled = pending.splice(0);
      for (const callback of scheduled) callback(timestamp);
    },
  };
}

// Независимое решение x'' + 20x' + 100(x − target) = 0, не солвер пакета.
function criticalStep(x: number, v: number, target: number, seconds: number) {
  const y = x - target;
  const b = v + 10 * y;
  const decay = Math.exp(-10 * seconds);
  return {
    x: target + (y + b * seconds) * decay,
    v: (v - 10 * b * seconds) * decay,
  };
}

// Независимая интеграция исходного ОДУ, а не копия closed-form реализации.
function integrate(x: number, v: number, target: number, dt: number, p: SpringParams) {
  const count = Math.ceil(dt / 0.0001);
  const h = dt / count;
  const acceleration = (position: number, velocity: number) =>
    (p.stiffness * (target - position) - p.damping * velocity) / p.mass;
  for (let i = 0; i < count; i++) {
    const a = acceleration(x, v);
    const vb = v + h * a / 2;
    const ab = acceleration(x + h * v / 2, vb);
    const vc = v + h * ab / 2;
    const ac = acceleration(x + h * vb / 2, vc);
    const vd = v + h * ac;
    const ad = acceleration(x + h * vc, vd);
    x += h * (v + 2 * vb + 2 * vc + vd) / 6;
    v += h * (a + 2 * ab + 2 * ac + ad) / 6;
  }
  return { x, v };
}

describe('MotionValue: непрерывное слежение без потери времени', () => {
  for (const hz of [60, 120, 144]) {
    it(`${hz}Hz: движущаяся цель следует независимому ОДУ на каждом кадре`, () => {
      const host = clock();
      const value = new MotionValue({ initial: 0, spring: critical, clamp: false, requestFrame: host.requestFrame });
      let expected = { x: 0, v: 0 };
      value.setTarget(100);
      host.step(7000); // epoch не обязан начинаться с нуля
      for (let frame = 1; frame <= hz; frame++) {
        const target = 100 + frame;
        const before = { x: value.value, v: value.velocity };
        value.setTarget(target);
        // C0/C1 относятся к границе, не к кадру СПУСТЯ один интервал.
        expect(value.value).toBe(before.x);
        expect(value.velocity).toBe(before.v);
        expect(host.pending.length).toBe(1);
        host.step(7000 + frame * 1000 / hz);
        expected = criticalStep(expected.x, expected.v, target, 1 / hz);
        expect(value.value).toBeCloseTo(expected.x, 8);
        expect(value.velocity).toBeCloseTo(expected.v, 8);
      }
      expect(value.value).toBeGreaterThan(100);
      expect(host.requests).toBe(hz + 2);
      value.destroy();
    });
  }

  for (const clamp of [false, true]) {
    it(`повтор неизменной цели не меняет ни одного кадра (clamp=${clamp})`, () => {
      const hosts = [clock(), clock()];
      const values = hosts.map(host => new MotionValue({
        initial: 0, spring: { mass: 1, stiffness: 200, damping: 20 },
        clamp, requestFrame: host.requestFrame,
      }));
      values.forEach(value => value.setTarget(100));
      for (let frame = 0; frame < 100; frame++) {
        for (let event = 0; event < 100; event++) values[1]!.setTarget(100);
        hosts.forEach(host => host.step(frame * 16));
        expect(values[1]!.value).toBe(values[0]!.value);
        expect(values[1]!.velocity).toBe(values[0]!.velocity);
        expect(hosts[1]!.requests).toBe(hosts[0]!.requests);
      }
      expect(values[0]!.value).toBe(100);
      values.forEach(value => value.destroy());
    });
  }

  it('последняя цель пачки эквивалентна одному обновлению; нет лишних emit/кадров', () => {
    const hosts = [clock(), clock()];
    let emissions = 0;
    const values = hosts.map(host => new MotionValue({ initial: 0, spring: critical, clamp: false, requestFrame: host.requestFrame }));
    values[1]!.onChange(() => emissions++);
    values.forEach(value => value.setTarget(100));
    hosts.forEach(host => host.step(0));
    for (let frame = 1; frame <= 80; frame++) {
      const target = 200 + frame;
      values[0]!.setTarget(target);
      for (let event = 0; event < 1000; event++) values[1]!.setTarget(target + event);
      values[1]!.setTarget(target);
      hosts.forEach(host => host.step(frame * 8));
      expect(values[1]!.value).toBe(values[0]!.value);
      expect(values[1]!.velocity).toBe(values[0]!.velocity);
      expect(hosts[1]!.pending.length).toBe(1);
    }
    expect(values[0]!.value).toBeGreaterThan(100);
    expect(emissions).toBe(82); // подписка + первый кадр + 80 рабочих кадров
    values.forEach(value => value.destroy());
  });

  it('retarget из onChange использует уже опубликованный snapshot времени', () => {
    const host = clock();
    const value = new MotionValue({ initial: 0, spring: critical, clamp: false, requestFrame: host.requestFrame });
    let target = 100;
    let first = true;
    value.onChange(() => {
      if (first) { first = false; return; }
      value.setTarget(++target);
    });
    value.setTarget(target);
    host.step(0);
    let expected = { x: 0, v: 0 };
    for (let frame = 1; frame <= 60; frame++) {
      expected = criticalStep(expected.x, expected.v, target, 0.016);
      host.step(frame * 16);
      expect(value.value).toBeCloseTo(expected.x, 9);
      expect(value.velocity).toBeCloseTo(expected.v, 9);
      expect(host.pending.length).toBe(1);
    }
    value.destroy();
  });

  it('новое поколение не наследует старую epoch; stale callback не двигает состояние', () => {
    const host = clock();
    const value = new MotionValue({ initial: 0, spring: critical, clamp: false, requestFrame: host.requestFrame });
    value.setTarget(100);
    host.step(9000);
    host.step(9100);
    const stale = host.pending.shift()!;
    value.stop();
    const origin = value.value;
    const velocity = value.velocity;
    value.setTarget(200);
    stale(100_000);
    expect(host.pending.length).toBe(1);
    expect(value.value).toBe(origin);
    host.step(50);
    expect(value.value).toBe(origin);
    host.step(66);
    const expected = criticalStep(origin, velocity, 200, 0.016);
    expect(value.value).toBeCloseTo(expected.x, 10);
    expect(value.velocity).toBeCloseTo(expected.v, 10);
    value.snapTo(30);
    host.step(82);
    expect(value.value).toBe(30);
    expect(value.velocity).toBe(0);
    value.setTarget(80);
    host.step(1000);
    expect(value.value).toBe(30);
    value.destroy();
    host.step(1016);
    expect(host.pending.length).toBe(0);
  });

  it('timestamp-free и timestamped одинаковы после начальной привязки epoch', () => {
    const hosts = [clock(), clock()];
    const values = hosts.map(host => new MotionValue({ initial: 0, spring: critical, clamp: false, requestFrame: host.requestFrame }));
    values.forEach(value => value.setTarget(100));
    hosts[0]!.step(0); // timestamp-free начинает с одного FIXED_DT, а не с t=0
    for (let frame = 1; frame <= 60; frame++) {
      values.forEach(value => value.setTarget(100 + frame));
      hosts[0]!.step(frame * 1000 / 60);
      hosts[1]!.step();
      expect(values[0]!.value).toBeCloseTo(values[1]!.value, 9);
      expect(values[0]!.velocity).toBeCloseTo(values[1]!.velocity, 9);
    }
    values.forEach(value => value.destroy());
  });

  it('stop разрешает возобновление той же цели; idempotency не теряет запуск', () => {
    const host = clock();
    const value = new MotionValue({ initial: 0, spring: critical, requestFrame: host.requestFrame });
    value.setTarget(100);
    host.step(0);
    host.step(16);
    const origin = value.value;
    value.stop();
    value.setTarget(100);
    host.step(1000); // старое поколение инертно, новое устанавливает epoch
    host.step(1016);
    expect(value.value).toBeGreaterThan(origin);
    expect(host.pending.length).toBe(1);
    value.destroy();
  });

  it('retarget не возвращает владение кадром host после перехода на fallback', () => {
    vi.useFakeTimers();
    try {
      const late: Array<(timestamp?: number) => void> = [];
      let writes = 0;
      const value = new MotionValue({ initial: 0, spring: critical, requestFrame: callback => {
        late.push(callback);
        return 0;
      } });
      value.onChange(() => writes++);
      value.setTarget(100);
      vi.runOnlyPendingTimers();
      value.setTarget(200);
      const before = { value: value.value, velocity: value.velocity, writes };
      late[0]!(1000); // нарушивший контракт host всё-таки доставил старый callback
      expect({ value: value.value, velocity: value.velocity, writes }).toEqual(before);
      expect(late.length).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(value.value).toBeGreaterThan(before.value);
      value.destroy();
      vi.runOnlyPendingTimers();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeded нерегулярные интервалы и 3 режима сверяются с независимым RK4', () => {
    let seed = 0x369;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (const damping of [4, 20, 32]) {
      const spring = { ...critical, damping };
      const host = clock();
      const value = new MotionValue({ initial: -20, spring, initialVelocity: 15, clamp: false, requestFrame: host.requestFrame });
      let expected = { x: -20, v: 15 };
      let timestamp = 10_000;
      value.setTarget(150);
      host.step(timestamp);
      for (let frame = 0; frame < 300; frame++) {
        const target = 100 + 200 * random();
        const interval = 3 + 25 * random();
        value.setTarget(target);
        timestamp += interval;
        host.step(timestamp);
        expected = integrate(expected.x, expected.v, target, interval / 1000, spring);
        expect(Math.abs(value.value - expected.x)).toBeLessThan(1e-6);
        expect(Math.abs(value.velocity - expected.v)).toBeLessThan(1e-6);
        expect(host.pending.length).toBe(1);
      }
      value.destroy();
    }
  });
});
