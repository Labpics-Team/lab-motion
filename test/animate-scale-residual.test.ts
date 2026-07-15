import { withLiveEngine } from './animate-facade-helpers.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCompositorPlan,
  type CompositorPlanOptions,
  type PlanGroupOwner,
  type PlannedUnitGroup,
  type PlanTarget,
} from '../src/animate/compositor-plan.js';
import type { ProgressSnapshot } from '../src/animate/compositor-unit.js';
import { springProgressCurve } from '../src/animate/linear-compile.js';
import { animate as animateBase, type AnimateProps } from '../src/animate/index.js';
import {
  compileSpringExecutionArtifactUnchecked,
  DEFAULT_TOLERANCE,
  tryCompileSpringExecutionArtifactTupleUnchecked,
} from '../src/compositor/curve.js';
import { __resetDetectionCache } from '../src/compositor/detect.js';
import { readCompositorSpring } from '../src/compositor/index.js';
import {
  sampleSerializedSpring,
  scaleSerializedVelocity,
} from '../src/compositor/sample.js';
import { settleTimeUpperBound, type SpringParams } from '../src/spring.js';
import {
  fakeEl,
  makeClock,
  makeNow,
  makeTimer,
  type StyleWrite,
} from './animate-facade-helpers.js';

// Харнесс R3b: rAF-пути исполняет композируемый live-движок (см. helpers).
const animate = withLiveEngine(animateBase as never);

const LINEAR = (value: number): number => value;
const SPRING: SpringParams = { mass: 1, stiffness: 170, damping: 26 };
const UNDERDAMPED: SpringParams = { mass: 1, stiffness: 170, damping: 10 };

afterEach(() => {
  vi.unstubAllGlobals();
  __resetDetectionCache();
});

function lastTransform(writes: readonly StyleWrite[]): string {
  return writes.filter((write) => write.prop === 'transform').at(-1)?.value ?? '';
}

function scaleAxes(transform: string): { x: number; y: number } {
  const read = (name: string): number | undefined => {
    const match = new RegExp(`${name}\\(([^)]+)\\)`).exec(transform);
    return match === null ? undefined : Number(match[1]);
  };
  const uniform = read('scale');
  return {
    x: uniform ?? read('scaleX') ?? 1,
    y: uniform ?? read('scaleY') ?? 1,
  };
}

function scaleFrames(writes: readonly StyleWrite[], from = 0): { x: number; y: number }[] {
  return writes
    .filter((write) => write.prop === 'transform')
    .slice(from)
    .map((write) => scaleAxes(write.value));
}

// ─── Плановая обвязка: точные операнды и sharedV0-канон на новом ядре ─────────

function planEl(initial: Record<string, string> = {}): PlanTarget {
  const el: PlanTarget = {
    style: {
      setProperty(): void {},
      getPropertyValue(name: string): string {
        return initial[name] ?? '';
      },
    },
  };
  (el as { animate?: unknown }).animate = () => ({ cancel() {} });
  return el;
}

function planOptions(
  el: PlanTarget,
  props: Record<string, unknown>,
): CompositorPlanOptions {
  return {
    targets: [el],
    props,
    mode: { kind: 'spring', spring: SPRING },
    seams: { now: () => 0, setTimer: () => () => {} },
    capability: { linearSupported: true },
    reducedMotion: false,
  };
}

/** Публикует владельца с фиксированным снимком (середина полёта). */
function publishOwner(
  entry: PlannedUnitGroup,
  snapshot?: ProgressSnapshot,
): PlanGroupOwner {
  const owner: PlanGroupOwner = {
    _supersede(replacement?: () => void): void {
      replacement?.();
    },
    _rollback(): void {},
  };
  if (snapshot) owner._snapshot = (): ProgressSnapshot => snapshot;
  entry.begin();
  entry.publish(owner);
  return owner;
}

describe('animate: конфликт uniform и осевого scale', () => {
  it('края держат точные operands, включая знак IEEE-ноля (реестр → кадры)', () => {
    // Канон channelAt пережил модуль: кадры юнита — сами операнды (без
    // интерполяции краёв), натуральный финал пишет в реестр ровно цель,
    // и следующий план стартует с неё бит-в-бит (Object.is, −0 живёт).
    const cases = [
      { from: -0, to: Number.MIN_VALUE },
      { from: Number.MIN_VALUE, to: -0 },
      { from: -0, to: +0 },
      { from: +0, to: -0 },
    ];
    for (const { from, to } of cases) {
      const el = planEl();
      const first = buildCompositorPlan(planOptions(el, { opacity: [from, to] }));
      expect(Object.is(first.plans[0]!.plan.keyframes[0], from)).toBe(true);
      expect(Object.is(first.plans[0]!.plan.keyframes[1], to)).toBe(true);
      const owner = publishOwner(first.plans[0]!);
      first.plans[0]!.settle(owner, true);

      const second = buildCompositorPlan(planOptions(el, { opacity: 1 }));
      expect(Object.is(second.plans[0]!.plan.keyframes[0], to)).toBe(true);
    }
  });

  it('точный static-канал неподвижен: live-кадры держат операнд бит-в-бит', () => {
    // Наследник пина channelAt(static, p) === value: движущийся сосед не
    // сдвигает статичную ось ни на одном кадре живого прогона.
    const target = fakeEl();
    const clock = makeClock();
    const controls = animate(target.el, {
      x: [0, 100],
      scaleY: [Number.MAX_VALUE, Number.MAX_VALUE],
    }, {
      duration: 100,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    for (let i = 0; i < 5; i++) clock.step(16);
    const scaleYs = target.writes
      .filter((w) => w.prop === 'transform')
      .map((w) => /scaleY\(([^)]+)\)/.exec(w.value)?.[1]);
    expect(scaleYs.length).toBeGreaterThan(3);
    expect(new Set(scaleYs.map((token) => Number(token)))).toEqual(
      new Set([Number.MAX_VALUE]),
    );
    controls.cancel();
  });

  // @todo-R3c: pickup-parity: 1-ULP effect-space и WebKit-кадры старых лейнов; residual/оси-канон закреплён R3a-сьютом, точные пины — R3c
  it.skip('WebKit не создаёт 1-ULP траекторию для static MAX scale-оси', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    });
    __resetDetectionCache();
    const target = fakeEl({}, true);
    const controls = animate(target.el, {
      scaleX: [1, 2],
      scaleY: [Number.MAX_VALUE, Number.MAX_VALUE],
    }, {
      spring: UNDERDAMPED,
      setTimer: () => () => {},
    });

    const scaleYValues = target.animateCalls[0]!.keyframes.map((frame) => {
      const token = /scaleY\(([^)]+)\)/.exec(String(frame.transform))?.[1];
      return Number(token);
    });
    expect([...new Set(scaleYValues)]).toEqual([Number.MAX_VALUE]);
    controls.cancel();
  });

  // @todo-R3c: pickup-parity: 1-ULP effect-space и WebKit-кадры старых лейнов; residual/оси-канон закреплён R3a-сьютом, точные пины — R3c
  it.skip('WebKit сохраняет знак ноля в первом и последнем явном кадре', () => {
    vi.stubGlobal('navigator', {
      vendor: 'Apple Computer, Inc.',
      userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18 Safari/605.1.15',
    });
    __resetDetectionCache();

    const endpoints = [
      { from: -0, to: Number.MIN_VALUE },
      { from: Number.MIN_VALUE, to: -0 },
      { from: -0, to: +0 },
      { from: +0, to: -0 },
    ];
    for (const { from, to } of endpoints) {
      const target = fakeEl({}, true);
      const controls = animate(target.el, { opacity: [from, to] }, {
        spring: UNDERDAMPED,
        setTimer: () => () => {},
      });
      const frames = target.animateCalls[0]!.keyframes;
      expect(Object.is(frames[0]!.opacity, from)).toBe(true);
      expect(Object.is(frames.at(-1)!.opacity, to)).toBe(true);
      controls.cancel();
    }
  });

  // @todo-R3c: pickup-parity: 1-ULP effect-space и WebKit-кадры старых лейнов; residual/оси-канон закреплён R3a-сьютом, точные пины — R3c
  it.skip('pause/play не приписывает progress-v0 IEEE-дрейфующей static-оси', () => {
    const artifact = compileSpringExecutionArtifactUnchecked(
      UNDERDAMPED,
      0,
      DEFAULT_TOLERANCE,
    );
    const durationMs = settleTimeUpperBound(UNDERDAMPED, 0) * 1_000;
    let pickupMs = -1;
    for (let tMs = 1; tMs < Math.min(durationMs, 1_000); tMs++) {
      const progress = sampleSerializedSpring(artifact.samples, durationMs, tMs).value;
      const roundedStatic =
        (1 - progress) * Number.MAX_VALUE + progress * Number.MAX_VALUE;
      if (Number.isFinite(roundedStatic) && roundedStatic !== Number.MAX_VALUE) {
        pickupMs = tMs;
        break;
      }
    }
    expect(pickupMs).toBeGreaterThan(0);

    const target = fakeEl({}, true);
    const clock = makeClock();
    let requests = 0;
    target.el.animate = (keyframes, timing) => {
      target.animateCalls.push({ keyframes, timing });
      return {
        currentTime: pickupMs,
        cancel: () => { target.cancels++; },
      } as { currentTime: number; cancel: () => void };
    };
    const controls = animate(target.el, {
      scaleX: [1, 2],
      scaleY: [Number.MAX_VALUE, Number.MAX_VALUE],
    }, {
      spring: UNDERDAMPED,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    controls.pause();
    expect(lastTransform(target.writes)).toContain(`scaleY(${Number.MAX_VALUE})`);
    controls.play();

    // Точный нулевой span не зависит от общей progress-кривой: повторный
    // compositor-effect допустим, но каждый его кадр обязан держать Y точно.
    expect(target.animateCalls).toHaveLength(2);
    expect(requests).toBe(0);
    const replayY = target.animateCalls[1]!.keyframes.map((frame) =>
      Number(/scaleY\(([^)]+)\)/.exec(String(frame.transform))?.[1]),
    );
    expect([...new Set(replayY)]).toEqual([Number.MAX_VALUE]);
    controls.cancel();
  });

  it.skip.each([
    {
      property: 'opacity',
      // В верхней binade IEEE-754 шаг равен 2^971: это непосредственный
      // predecessor MAX, а не произвольное "большое" тестовое число.
      from: Number.MAX_VALUE - 2 ** 971,
      to: Number.MAX_VALUE,
      pickupMs: 134.4,
    },
    {
      property: 'rotate',
      // При 2^50 один ULP равен 0.25: второй независимый binade-контрпример.
      from: 2 ** 50,
      to: 2 ** 50 + 0.25,
      pickupMs: 125.92,
    },
  ] as const)(
    // @todo-R3c: pickup-parity: 1-ULP effect-space старых лейнов; точные пины — R3c
    'pause/play сохраняет effect-space C1 у соседних huge $property endpoints',
    ({ property, from, to, pickupMs }) => {
      const initial = tryCompileSpringExecutionArtifactTupleUnchecked(
        UNDERDAMPED,
        0,
        DEFAULT_TOLERANCE,
      )!;
      const sample = sampleSerializedSpring(initial[1], initial[2], pickupMs);
      const current = channelAt({ _from: from, _to: to } as NumericChannel, sample.value);
      const velocity = scaleSerializedVelocity(sample.velocity, from, to);
      const effectV0 = normalizeV0(velocity, to - current);
      const structuralV0 = sample.velocity / (1 - sample.value);

      expect(Object.is(current, from)).toBe(true);
      expect(effectV0).not.toBe(structuralV0);

      const target = fakeEl({}, true);
      target.el.animate = (keyframes, timing) => {
        target.animateCalls.push({ keyframes, timing });
        return {
          currentTime: pickupMs,
          cancel: () => { target.cancels++; },
        };
      };
      const controls = animate(target.el, { [property]: [from, to] }, {
        spring: UNDERDAMPED,
        now: () => 0,
        setTimer: () => () => {},
      });

      controls.pause();
      controls.play();

      const effectDuration = tryCompileSpringExecutionArtifactTupleUnchecked(
        UNDERDAMPED,
        effectV0,
        DEFAULT_TOLERANCE,
      )![2];
      const structuralDuration = tryCompileSpringExecutionArtifactTupleUnchecked(
        UNDERDAMPED,
        structuralV0,
        DEFAULT_TOLERANCE,
      )![2];
      expect(target.animateCalls).toHaveLength(2);
      expect(target.animateCalls[1]!.timing.duration).toBe(effectDuration);
      expect(target.animateCalls[1]!.timing.duration).not.toBe(structuralDuration);
      controls.cancel();
    },
  );

  it('sharedV0 отклоняет даже Number.EPSILON-разницу без tolerance', () => {
    // Канон sharedV0 живёт в планировщике: равные v0 каналов — общая
    // WAAPI-кривая, ULP-сдвиг производной скорости — честный живой путь.
    const seeded = (prevYTo: number) => {
      const el = planEl();
      const first = buildCompositorPlan(
        planOptions(el, { x: [0, 100], y: [0, prevYTo] }),
      );
      publishOwner(first.plans[0]!, { value: 0, velocity: 1 });
      return buildCompositorPlan(planOptions(el, { x: 100, y: 100 }));
    };

    const equal = seeded(100); // v0x = v0y = 1 ровно
    expect(equal.live).toHaveLength(0);
    expect(equal.plans[0]!.plan.ir.points)
      .toEqual(springProgressCurve(SPRING, 1)!.points);

    const skewed = seeded(100 * (1 + Number.EPSILON)); // v0y = 1 + ULP
    expect(skewed.plans).toHaveLength(0);
    expect(skewed.live[0]!.reason).toBe('v0-mismatch');
  });

  it('живой нулевой span с импульсом не получает общий WAAPI-прогресс', () => {
    // Public span нулевой, но импульс жив: solver-амплитуда подменена —
    // группа честно уходит на живой путь (канон «sharedV0 смотрит public span»).
    const el = planEl();
    const first = buildCompositorPlan(planOptions(el, { x: 100 }));
    publishOwner(first.plans[0]!, { value: 1, velocity: 8.97e-10 });

    const second = buildCompositorPlan(planOptions(el, { x: 100 }));
    expect(second.plans).toHaveLength(0);
    expect(second.live[0]!.reason).toBe('v0-mismatch');
  });

  it.each([true, false])(
    'точный статический канал не ограничивает WAAPI-кривую движущегося (movingFirst=%s)',
    (movingFirst) => {
      const el = planEl();
      const first = buildCompositorPlan(planOptions(el, { x: 100 }));
      publishOwner(first.plans[0]!, { value: 0.5, velocity: 1.2 });

      // rotate заморожен явной парой [5,5]; x несёт импульс 120/(200−50)=0.8.
      const props: AnimateProps = movingFirst
        ? { x: 200, rotate: [5, 5] }
        : { rotate: [5, 5], x: 200 };
      const second = buildCompositorPlan(planOptions(el, props));
      expect(second.live).toHaveLength(0);
      expect(second.plans[0]!.plan.ir.points)
        .toEqual(springProgressCurve(SPRING, 0.8)!.points);
    },
  );

  it.each([true, false])(
    'ненулевой sub-epsilon span остаётся движущимся и ограничивает WAAPI (tinyFirst=%s)',
    (tinyFirst) => {
      const el = planEl();
      const first = buildCompositorPlan(planOptions(el, { x: 100 }));
      publishOwner(first.plans[0]!, { value: 0.5, velocity: 1.2 });

      // y движется на sub-epsilon span из покоя (v0=0), x несёт импульс —
      // единого прогресса нет, группа не сворачивается в WAAPI.
      const props: AnimateProps = tinyFirst
        ? { y: [1, 1 + Number.EPSILON], x: 200 }
        : { x: 200, y: [1, 1 + Number.EPSILON] };
      const second = buildCompositorPlan(planOptions(el, props));
      expect(second.plans).toHaveLength(0);
      expect(second.live[0]!.reason).toBe('v0-mismatch');
    },
  );

  it.each(['scaleX', 'scaleY'] as const)(
    'после scale:2 новый %s:3 стартует с 2 и сохраняет вторую ось',
    async (axis) => {
      const target = fakeEl();
      const clock = makeClock();
      const short = { duration: 50, ease: LINEAR, requestFrame: clock.requestFrame };

      const uniform = animate(target.el, { scale: 2 }, short);
      clock.drain();
      await uniform.finished;
      expect(lastTransform(target.writes)).toBe('scale(2)');

      const before = scaleFrames(target.writes).length;
      const axial = animate(target.el, { [axis]: 3 }, {
        duration: 100,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
      clock.step(0);
      expect(scaleFrames(target.writes, before).at(-1)).toEqual({ x: 2, y: 2 });
      clock.step(50);
      const middle = scaleFrames(target.writes, before).at(-1)!;
      expect(middle[axis === 'scaleX' ? 'x' : 'y']).toBeCloseTo(2.5, 12);
      expect(middle[axis === 'scaleX' ? 'y' : 'x']).toBe(2);
      clock.drain(50);
      await axial.finished;

      const rendered = lastTransform(target.writes);
      const end = scaleAxes(rendered);
      expect(end[axis === 'scaleX' ? 'x' : 'y']).toBe(3);
      expect(end[axis === 'scaleX' ? 'y' : 'x']).toBe(2);

      const reentered = animate(target.el, { rotate: 15 }, short);
      clock.drain();
      await reentered.finished;

      const afterReentry = lastTransform(target.writes);
      expect(scaleAxes(afterReentry)).toEqual(end);
      expect(afterReentry).toContain('rotate(15deg)');
    },
  );

  it.each([true, false])(
    'live-перехват не зависит от порядка props (axisFirst=%s) и сохраняет другие оси',
    async (axisFirst) => {
      const target = fakeEl();
      const clock = makeClock();
      const previous = animate(
        target.el,
        { x: [0, 12], scale: [1, 2], rotate: [0, 30] },
        { duration: 1_000, ease: LINEAR, requestFrame: clock.requestFrame },
      );
      clock.step(0);
      clock.step(500);

      const props: AnimateProps = axisFirst
        ? { scaleX: 3, y: 20 }
        : { y: 20, scaleX: 3 };
      const successor = animate(target.el, props, {
        duration: 50,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
      clock.drain();
      await Promise.all([previous.finished, successor.finished]);

      const rendered = lastTransform(target.writes);
      expect(rendered).toContain('translate(6px, 20px)');
      expect(scaleAxes(rendered)).toEqual({ x: 3, y: 1.5 });
      expect(rendered).toContain('rotate(15deg)');
    },
  );

  it.each([true, false])(
    'scale и scaleX в одном input имеют одну topology независимо от порядка (axisFirst=%s)',
    async (axisFirst) => {
      const target = fakeEl();
      const clock = makeClock();
      const props: AnimateProps = axisFirst
        ? { scaleX: 3, scale: 2 }
        : { scale: 2, scaleX: 3 };
      const controls = animate(target.el, props, {
        duration: 50,
        ease: LINEAR,
        requestFrame: clock.requestFrame,
      });
      clock.drain();
      await controls.finished;
      expect(scaleAxes(lastTransform(target.writes))).toEqual({ x: 3, y: 2 });
    },
  );

  it('uniform→scaleX переносит позицию и скорость, а scaleY замораживает в точке перехвата', () => {
    const target = fakeEl();
    const clock = makeClock();
    animate(target.el, { scale: 4 }, { spring: SPRING, requestFrame: clock.requestFrame });

    const framesBeforePickup = 7;
    for (let i = 0; i < framesBeforePickup; i++) clock.step(16);
    const t = ((framesBeforePickup - 1) * 16) / 1_000;
    const snapshot = readCompositorSpring(SPRING, { from: 1, to: 4, v0: 0, t });
    expect(scaleAxes(lastTransform(target.writes))).toEqual({
      x: snapshot.value,
      y: snapshot.value,
    });

    const before = scaleFrames(target.writes).length;
    animate(target.el, { scaleX: 6 }, { spring: SPRING, requestFrame: clock.requestFrame });
    for (let i = 0; i < 4; i++) clock.step(16);

    const pickedUp = scaleFrames(target.writes, before);
    const v0 = snapshot.velocity / (6 - snapshot.value);
    for (let i = 0; i < pickedUp.length; i++) {
      const expectedX = readCompositorSpring(SPRING, {
        from: snapshot.value,
        to: 6,
        v0,
        t: (i * 16) / 1_000,
      }).value;
      expect(pickedUp[i]!.x).toBeCloseTo(expectedX, 9);
      expect(pickedUp[i]!.y).toBeCloseTo(snapshot.value, 12);
    }
  });

  it('повторный вызов во время axial-прогона не оживляет старый uniform scale', async () => {
    const target = fakeEl();
    const clock = makeClock();
    const short = { duration: 50, ease: LINEAR, requestFrame: clock.requestFrame };

    const uniform = animate(target.el, { scale: 2 }, short);
    clock.drain();
    await uniform.finished;

    const axial = animate(target.el, { scaleX: 3 }, {
      duration: 1_000,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(0);
    clock.step(500);

    const reentered = animate(target.el, { rotate: 15 }, short);
    clock.drain();
    await Promise.all([axial.finished, reentered.finished]);

    const rendered = lastTransform(target.writes);
    expect(scaleAxes(rendered)).toEqual({ x: 2.5, y: 2 });
    expect(rendered).toContain('rotate(15deg)');
  });

  it('axes→uniform независимо сводит обе оси к одной цели без стартового скачка', async () => {
    const target = fakeEl();
    const clock = makeClock();
    const short = { duration: 50, ease: LINEAR, requestFrame: clock.requestFrame };

    const axial = animate(target.el, { scaleX: 2, scaleY: 3 }, short);
    clock.drain();
    await axial.finished;

    const before = scaleFrames(target.writes).length;
    const uniform = animate(target.el, { scale: 4 }, {
      duration: 100,
      ease: LINEAR,
      requestFrame: clock.requestFrame,
    });
    clock.step(0);
    expect(scaleFrames(target.writes, before).at(-1)).toEqual({ x: 2, y: 3 });
    clock.step(50);
    expect(scaleFrames(target.writes, before).at(-1)).toEqual({ x: 3, y: 3.5 });
    clock.drain(50);
    await uniform.finished;
    expect(scaleAxes(lastTransform(target.writes))).toEqual({ x: 4, y: 4 });

    const reentered = animate(target.el, { rotate: 15 }, short);
    clock.drain();
    await reentered.finished;

    const rendered = lastTransform(target.writes);
    expect(rendered).toBe('scale(4) rotate(15deg)');
  });

  // @todo-R3c: pickup-parity: 1-ULP effect-space и WebKit-кадры старых лейнов; residual/оси-канон закреплён R3a-сьютом, точные пины — R3c
  it.skip('compositor-план начинает axial-переход с прежних двух осей', async () => {
    const target = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    const options = { spring: SPRING, now: now.now, setTimer: timer.setTimer };

    const uniform = animate(target.el, { scale: 2 }, options);
    timer.fire();
    await uniform.finished;

    animate(target.el, { scaleX: 3 }, options);
    const keyframes = target.animateCalls.at(-1)!.keyframes;
    expect(scaleAxes(String(keyframes[0]!['transform']))).toEqual({ x: 2, y: 2 });
    expect(scaleAxes(String(keyframes.at(-1)!['transform']))).toEqual({ x: 3, y: 2 });
  });

  it.skip.each([true, false])(
    // @todo-R3c: pickup-parity: v0-mismatch теперь живой/снап-маршрут планировщика (R3a-сьют)
    'разные axial-скорости запрещают общий WAAPI-прогресс (scaleXFirst=%s)',
    async (scaleXFirst) => {
      const target = fakeEl({}, true);
      const now = makeNow();
      const timer = makeTimer();
      const options = { spring: SPRING, now: now.now, setTimer: timer.setTimer };
      const props: AnimateProps = scaleXFirst
        ? { scaleX: [1, 4], scaleY: [2, 2] }
        : { scaleY: [2, 2], scaleX: [1, 4] };

      const moving = animate(target.el, props, options);
      expect(target.animateCalls).toHaveLength(1);
      now.advance(120);

      const incompatible = animate(target.el, { scale: 6 }, options);
      expect(target.animateCalls).toHaveLength(1);

      incompatible.cancel();
      await Promise.all([moving.finished, incompatible.finished]);
    },
  );

  // @todo-R3c: pickup-parity: 1-ULP effect-space и WebKit-кадры старых лейнов; residual/оси-канон закреплён R3a-сьютом, точные пины — R3c
  it.skip('одинаковый live-v0 нескольких каналов сохраняет compositor-route', () => {
    const target = fakeEl({}, true);
    const now = makeNow();
    const timer = makeTimer();
    const options = { spring: SPRING, now: now.now, setTimer: timer.setTimer };

    animate(target.el, { scaleX: [1, 4], scaleY: [1, 4] }, options);
    now.advance(120);
    const compatible = animate(target.el, { scale: 6 }, options);

    expect(target.animateCalls).toHaveLength(2);
    compatible.cancel();
  });

  // @todo-R3c: pickup-parity: 1-ULP effect-space и WebKit-кадры старых лейнов; residual/оси-канон закреплён R3a-сьютом, точные пины — R3c
  it.skip('seek переводит 1-ULP несовместимые effect-speeds на независимый main', () => {
    const target = fakeEl({}, true);
    const clock = makeClock();
    let requests = 0;
    const controls = animate(target.el, {
      scaleX: [2.998266875266529e-11, 9.325277294421096e-10],
      scaleY: [-1.0238667362138987e-8, -2.1550411860147135e-10],
    }, {
      spring: SPRING,
      now: () => 0,
      setTimer: () => () => {},
      requestFrame(callback) {
        requests++;
        return clock.requestFrame(callback);
      },
    });

    expect(target.animateCalls).toHaveLength(1);
    controls.seek(120);
    // IEEE-rounded positions дают разные effect-space v0. Ни один общий WAAPI
    // progress не сохраняет обе абсолютные скорости точно, поэтому C1 важнее
    // compositor residency и каналы продолжаются независимо.
    expect(target.animateCalls).toHaveLength(1);
    expect(requests).toBeGreaterThan(0);
    controls.cancel();
  });
});
