import { afterEach, describe, expect, it, vi } from 'vitest';
import { animate } from '../src/nano/index.js';

type Timing = KeyframeAnimationOptions & { easing?: string };

interface RecordedAnimation {
  readonly finished: Promise<RecordedAnimation>;
  readonly play: ReturnType<typeof vi.fn>;
  readonly pause: ReturnType<typeof vi.fn>;
  readonly reverse: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly commitStyles: ReturnType<typeof vi.fn>;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  finish(): void;
}

function recordingElement() {
  const calls: Array<{ keyframes: PropertyIndexedKeyframes; timing: Timing }> = [];
  const animations: RecordedAnimation[] = [];
  return {
    calls,
    animations,
    animate(keyframes: PropertyIndexedKeyframes, timing: Timing) {
      let resolve!: (value: RecordedAnimation) => void;
      const finishListeners: Array<() => void> = [];
      const animation = {
        finished: new Promise<RecordedAnimation>((done) => { resolve = done; }),
        play: vi.fn(),
        pause: vi.fn(),
        reverse: vi.fn(),
        cancel: vi.fn(),
        commitStyles: vi.fn(),
        addEventListener: vi.fn((type: string, listener: () => void) => {
          if (type === 'finish') finishListeners.push(listener);
        }),
        finish() {
          resolve(animation);
          for (const listener of finishListeners) listener();
        },
      } satisfies RecordedAnimation;
      calls.push({ keyframes, timing });
      animations.push(animation);
      return animation;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('nano: публичный WAAPI-only контракт', () => {
  it('отдаёт сами native Animation и строит to-only individual-transform кадр', async () => {
    const first = recordingElement();
    const second = recordingElement();

    const controls = animate(
      [first, second] as unknown as Element[],
      { translate: '240px 12px', scale: 1.2, rotate: 90, opacity: 0.5 },
      { delay: 20, stagger: 15 },
    );

    expect(controls).toHaveLength(2);
    expect(controls[0]).toBe(first.animations[0]);
    expect(controls[1]).toBe(second.animations[0]);
    for (const target of [first, second]) {
      expect(target.calls[0]?.keyframes).toEqual({
        translate: '240px 12px',
        scale: 1.2,
        rotate: '90deg',
        opacity: 0.5,
      });
      expect(target.calls[0]?.timing).toMatchObject({ fill: 'both' });
      expect(target.calls[0]?.timing.easing).toMatch(/^linear\(/);
    }
    expect(first.calls[0]?.timing.delay).toBe(20);
    expect(second.calls[0]?.timing.delay).toBe(35);

    first.animations[0]!.finish();
    second.animations[0]!.finish();
    await expect(controls.finished).resolves.toEqual(first.animations.concat(second.animations));
    for (const target of [first, second]) {
      expect(target.animations[0]!.commitStyles).toHaveBeenCalledOnce();
      expect(target.animations[0]!.cancel).toHaveBeenCalledOnce();
    }
  });

  it('делегирует tween и произвольные CSS-значения платформе', () => {
    const target = recordingElement();

    animate(
      target as unknown as Element,
      { backgroundColor: 'rgb(255, 0, 0)', filter: 'blur(4px)' },
      { duration: 180, ease: 'cubic-bezier(.2,.8,.2,1)' },
    );

    expect(target.calls[0]).toEqual({
      keyframes: { backgroundColor: 'rgb(255, 0, 0)', filter: 'blur(4px)' },
      timing: {
        duration: 180,
        easing: 'cubic-bezier(.2,.8,.2,1)',
        delay: 0,
        fill: 'both',
      },
    });
  });

  it('не превращает enumerable prototype props в CSS keyframes', () => {
    const target = recordingElement();
    const props = Object.assign(Object.create({ opacity: 0 }), { color: 'red' }) as {
      color: string;
    };

    animate(target as unknown as Element, props, { duration: 100 });

    expect(target.calls[0]!.keyframes).toEqual({ color: 'red' });
  });

  it('схлопывает и длительность, и каскад при reduced motion', () => {
    const first = recordingElement();
    const second = recordingElement();

    animate(
      [first, second] as unknown as Element[],
      { translate: '10px 0px' },
      { duration: 200, delay: 30, stagger: 40, reducedMotion: true },
    );

    for (const target of [first, second]) {
      expect(target.calls[0]?.timing).toMatchObject({
        duration: 0,
        delay: 0,
        easing: 'linear',
      });
    }
  });

  it('резолвит селектор только в момент вызова', () => {
    const target = recordingElement();
    const querySelectorAll = vi.fn(() => [target]);
    vi.stubGlobal('document', { querySelectorAll });

    const controls = animate('.hero', { opacity: 1 }, { duration: 100 });

    expect(querySelectorAll).toHaveBeenCalledWith('.hero');
    expect(controls[0]).toBe(target.animations[0]);
  });

  it('не маскирует незатухающую пружину terminal-скачком', () => {
    const target = recordingElement();
    expect(() => animate(target as unknown as Element, { opacity: 1 }, {
      spring: { mass: 1, stiffness: 100, damping: 0 },
    })).toThrow(RangeError);
    expect(target.calls).toEqual([]);
  });

  it('не отвергает медленную физическую пружину произвольным wall-clock cap', () => {
    const target = recordingElement();
    animate(target as unknown as Element, { opacity: 1 }, {
      spring: { mass: 1, stiffness: 1, damping: 10 },
    });
    expect(Number(target.calls[0]!.timing.duration)).toBeGreaterThan(10_000);
  });

  it('сохраняет ту же кривую при общем конечном масштабе m/k/c', () => {
    const timings = [Number.MIN_VALUE, 1e-300, 1, 1e300, Number.MAX_VALUE]
      .map((scale) => {
        const target = recordingElement();
        animate(target as unknown as Element, { opacity: 1 }, {
          spring: { mass: scale, stiffness: scale, damping: scale },
        });
        return target.calls[0]!.timing;
      });

    for (const timing of timings.slice(1)) expect(timing).toEqual(timings[0]);
  });

  it('отклоняет кривую выше общего compiler ceiling до materialization и host-write', () => {
    const target = recordingElement();
    const materialize = vi.spyOn(Math, 'round').mockImplementation(() => {
      throw new Error('materialization started');
    });

    expect(() => animate(target as unknown as Element, { opacity: 1 }, {
      spring: { mass: 1, stiffness: 1e20, damping: 26 },
    })).toThrow('spring is not representable');
    expect(materialize).not.toHaveBeenCalled();
    expect(target.calls).toEqual([]);
  });

  it('чистит каждый replay через listener, не занимая пользовательский onfinish', async () => {
    const target = recordingElement();
    const controls = animate(target as unknown as Element, { opacity: 0.5 }, { duration: 100 });

    target.animations[0]!.finish();
    await controls.finished;
    target.animations[0]!.finish();

    expect(target.animations[0]!.addEventListener)
      .toHaveBeenCalledWith('finish', expect.any(Function));
    expect(target.animations[0]!.commitStyles).toHaveBeenCalledTimes(2);
    expect(target.animations[0]!.cancel).toHaveBeenCalledTimes(2);
  });
});

/** Независимый численный оракул: RK4 для m*x'' + c*x' + k*x = k. */
function rk4Curve(k: number, c: number, m: number, durationMs: number, steps = 120_000) {
  const values = new Float64Array(steps + 1);
  let x = 0;
  let v = 0;
  const h = durationMs / 1000 / steps;
  const acceleration = (px: number, pv: number) => (k - k * px - c * pv) / m;
  for (let i = 1; i <= steps; i++) {
    const x1 = v;
    const v1 = acceleration(x, v);
    const x2 = v + h * v1 / 2;
    const v2 = acceleration(x + h * x1 / 2, v + h * v1 / 2);
    const x3 = v + h * v2 / 2;
    const v3 = acceleration(x + h * x2 / 2, v + h * v2 / 2);
    const x4 = v + h * v3;
    const v4 = acceleration(x + h * x3, v + h * v3);
    x += h * (x1 + 2 * x2 + 2 * x3 + x4) / 6;
    v += h * (v1 + 2 * v2 + 2 * v3 + v4) / 6;
    values[i] = x;
  }
  return values;
}

function parseUniformLinear(input: string): number[] {
  expect(input).toMatch(/^linear\([^)]+\)$/);
  return input.slice(7, -1).split(',').map(Number);
}

function expectCertifiedLinearBudget(
  points: readonly number[],
  durationMs: number,
  stiffness: number,
  mass: number,
  terminal: number,
) {
  const intervals = points.length - 1;
  const h = durationMs / 1000 / intervals;
  const interpolation = (stiffness / mass) * h * h / 8;
  const quantization = 0.5e-4;
  const terminalSnap = Math.abs(1 - terminal);
  expect(interpolation + quantization + terminalSnap).toBeLessThanOrEqual(1 / 400);
  expect(terminalSnap).toBeLessThanOrEqual(1e-3);
}

describe('nano: spring → linear() differential', () => {
  it.each([
    [170, 26, 1, 'underdamped default'],
    [200, 2 * Math.sqrt(200), 1, 'critical'],
    [100, 20 * (1 - 1e-8), 1, 'near-critical under'],
    [100, 20 * (1 + 1e-8), 1, 'near-critical over'],
    [100, 40, 1, 'overdamped'],
    [1, 10, 1, 'slow overdamped'],
    [100, 0.4, 1, 'lightly damped'],
    [500, 15, 2, 'bouncy'],
  ] as const)('держит reconstruction error ≤1/400 — %s/%s/%s (%s)', (k, c, m) => {
    const target = recordingElement();
    animate(target as unknown as Element, { opacity: 1 }, {
      spring: { stiffness: k, damping: c, mass: m },
    });
    const timing = target.calls[0]!.timing;
    const points = parseUniformLinear(String(timing.easing));
    const oracle = rk4Curve(k, c, m, Number(timing.duration));
    expectCertifiedLinearBudget(points, Number(timing.duration), k, m, oracle.at(-1)!);
    let maxError = 0;
    for (let i = 0; i < oracle.length; i++) {
      const index = i / (oracle.length - 1) * (points.length - 1);
      const lower = Math.floor(index);
      const mix = index - lower;
      const reconstructed = points[lower]! * (1 - mix)
        + points[Math.min(lower + 1, points.length - 1)]! * mix;
      maxError = Math.max(maxError, Math.abs(reconstructed - oracle[i]!));
    }
    expect(maxError).toBeLessThanOrEqual(1 / 400);
    expect(points.at(-1)).toBe(1);
  });

  it('держит тот же предел на seeded-корпусе физических параметров', () => {
    let seed = 0x5eed_1234;
    const random = () => (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0)
      / 2 ** 32;
    for (let sample = 0; sample < 64; sample++) {
      const mass = 10 ** (-1 + 2 * random());
      const stiffness = 10 ** (1 + 3 * random());
      const dampingRatio = 0.05 + 3.95 * random();
      const damping = 2 * Math.sqrt(stiffness * mass) * dampingRatio;
      const target = recordingElement();
      animate(target as unknown as Element, { opacity: 1 }, {
        spring: { mass, stiffness, damping },
      });
      const timing = target.calls[0]!.timing;
      const points = parseUniformLinear(String(timing.easing));
      const oracle = rk4Curve(stiffness, damping, mass, Number(timing.duration), 30_000);
      expectCertifiedLinearBudget(
        points,
        Number(timing.duration),
        stiffness,
        mass,
        oracle.at(-1)!,
      );
      let maxError = 0;
      for (let index = 0; index < oracle.length; index++) {
        const point = index / (oracle.length - 1) * (points.length - 1);
        const lower = Math.floor(point);
        const mix = point - lower;
        const reconstructed = points[lower]! * (1 - mix)
          + points[Math.min(lower + 1, points.length - 1)]! * mix;
        maxError = Math.max(maxError, Math.abs(reconstructed - oracle[index]!));
      }
      expect(maxError, `seed sample ${sample}`).toBeLessThanOrEqual(1 / 400);
    }
  });
});
