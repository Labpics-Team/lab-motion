import { describe, expect, it } from 'vitest';
import {
  MOTION_PROGRAM_CHANNEL_SEMANTICS_V1,
  MOTION_PROGRAM_CHANNEL_SURFACE_V1,
  MOTION_PROGRAM_CODEC_V1,
  MOTION_PROGRAM_CODEC_SEMANTICS_V1,
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  MOTION_PROGRAM_FEATURE_V1,
  MOTION_PROGRAM_OWNERSHIP_SEMANTICS_V1,
  MOTION_PROGRAM_SEGMENT_SEMANTICS_V1,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1,
  MOTION_PROGRAM_SURFACE_V1,
  MOTION_PROGRAM_TRANSFORM_ORDER_V1,
  MOTION_PROGRAM_TRANSFORM_SEMANTICS_V1,
  motionProgramBinary64GapV1,
  parseMotionProgramV1,
  type MotionProgramEncodedValueV1,
} from '../src/internal/motion-program.js';
import {
  assertPortableMotionProgramV1,
  snapshotInjectiveMotionProgramSubjectsV1,
  composeMotionProgramTransform2DV1,
  evaluateMotionProgramScheduleV1,
  evaluateMotionProgramSegmentsV1,
  evaluateMotionProgramCurveV1,
  formatMotionProgramColorV1,
  interpolateMotionProgramValueV1,
  presentMotionProgramTrackValueV1,
  presentMotionProgramScalarV1,
  resolveMotionProgramSegmentsV1,
} from '../scripts/motion-program-semantics.js';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import { readCompositorSpring } from '../src/compositor/core.js';
import { interpolateColor, parseColor } from '../src/value/color.js';
import {
  FEATURE_MASK,
  adjacentFloat,
  expectIssue,
  minimalProgramInput,
  validProgramInput,
} from './motion-program-v1.fixtures.js';

describe('MotionProgram V1 portable semantics', () => {
  it('помечает escape channel, opaque codec и host-composite как непереносимые', () => {
    const input = validProgramInput();
    expect(parseMotionProgramV1(input)[1]).toBe(FEATURE_MASK);

    input[1] = FEATURE_MASK & ~MOTION_PROGRAM_FEATURE_V1.hostExtensions;
    expectIssue(() => parseMotionProgramV1(input), 'LMP_FEATURE');

    const composite = minimalProgramInput();
    composite[1] = MOTION_PROGRAM_FEATURE_V1.hostExtensions;
    (composite[5] as unknown[][])[0]![6] = MOTION_PROGRAM_COMPOSITE_V1.add;
    expect(parseMotionProgramV1(composite)[1]).toBe(MOTION_PROGRAM_FEATURE_V1.hostExtensions);

    const portable = parseMotionProgramV1(minimalProgramInput());
    expect(assertPortableMotionProgramV1(portable)).toBe(portable);
    expectIssue(
      () => assertPortableMotionProgramV1(parseMotionProgramV1(composite)),
      'LMP_FEATURE',
    );
  });

  it('закрывает alias двух subjectSlot до capture/IO', () => {
    const parsed = parseMotionProgramV1([
      1, 0, [], [0],
      [
        [0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0],
        [1, MOTION_PROGRAM_STANDARD_CHANNEL_V1.opacity, 1],
      ],
      [
        [0, 0, 1, 0, 0, 0, 0, [[0, 1, [1, [0, 0]], [1, [0, 1]], 0, 0]]],
        [1, 0, 1, 0, 0, 0, 0, [[0, 1, [1, [0, 0]], [1, [0, 1]], 0, 0]]],
      ],
    ]);
    const first = {};
    const second = {};
    const separate = [first, second];
    const snapshot = snapshotInjectiveMotionProgramSubjectsV1(parsed, separate);
    expect(snapshot).not.toBe(separate);
    expect(snapshot).toEqual(separate);
    expect(Object.isFrozen(snapshot)).toBe(true);
    separate[1] = first;
    expect(snapshot[1]).toBe(second);
    expectIssue(
      () => snapshotInjectiveMotionProgramSubjectsV1(parsed, [first, first]),
      'LMP_CANONICAL',
    );

    let captureCalls = 0;
    const hostile: unknown[] = [first, {}];
    Object.defineProperty(hostile, '1', {
      configurable: true,
      get() {
        captureCalls++;
        return {};
      },
    });
    expectIssue(() => snapshotInjectiveMotionProgramSubjectsV1(parsed, hostile), 'LMP_BOUNDS');
    expect(captureCalls).toBe(0);

    const revoked = Proxy.revocable<unknown[]>([], {});
    revoked.revoke();
    expectIssue(
      () => snapshotInjectiveMotionProgramSubjectsV1(parsed, revoked.proxy),
      'LMP_SHAPE',
    );
  });

  it('пинит единицы стандартных каналов и единственный порядок 2D-композиции', () => {
    expect(MOTION_PROGRAM_CHANNEL_SEMANTICS_V1).toEqual({
      value: { quantity: 'number', unit: 'one', presentationClamp: 'none' },
      opacity: { quantity: 'coverage', unit: 'one', presentationClamp: 'unitInterval' },
      translateX: { quantity: 'length', unit: 'hostLogicalUnit', presentationClamp: 'none' },
      translateY: { quantity: 'length', unit: 'hostLogicalUnit', presentationClamp: 'none' },
      scaleX: { quantity: 'scale', unit: 'ratio', presentationClamp: 'none' },
      scaleY: { quantity: 'scale', unit: 'ratio', presentationClamp: 'none' },
      rotate: { quantity: 'angle', unit: 'degree', presentationClamp: 'none' },
      skewX: { quantity: 'angle', unit: 'degree', presentationClamp: 'none' },
      skewY: { quantity: 'angle', unit: 'degree', presentationClamp: 'none' },
      color: { quantity: 'color', unit: 'codec', presentationClamp: 'codec' },
      backgroundColor: { quantity: 'color', unit: 'codec', presentationClamp: 'codec' },
      borderColor: { quantity: 'color', unit: 'codec', presentationClamp: 'codec' },
    });
    expect(MOTION_PROGRAM_TRANSFORM_ORDER_V1).toEqual([
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateX,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateY,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.scaleX,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.scaleY,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.rotate,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.skewX,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.skewY,
    ]);
    expect(MOTION_PROGRAM_SURFACE_V1).toEqual({
      value: 0,
      opacity: 1,
      transform: 2,
      color: 3,
      backgroundColor: 4,
      borderColor: 5,
    });
    expect(MOTION_PROGRAM_CHANNEL_SURFACE_V1).toEqual([
      0, 1, 2, 2, 2, 2, 2, 2, 2, 3, 4, 5,
    ]);
    expect(MOTION_PROGRAM_OWNERSHIP_SEMANTICS_V1).toEqual({
      ownerGroupScope: 'program-local',
      invariant: 'one-owner-per-subject-surface',
      duplicateChannel: 'forbidden',
      transformWrite: 'single-batched-surface-write',
      transformCoverage: 'all-seven-standard-components-required',
      transformCurrent: 'adapter-owned-component-state-or-identity-never-matrix-decomposition',
      surfaceCapture: 'all-binding-baselines-once-before-first-surface-write',
      inactiveTrackPresentation: 'captured-binding-baseline',
      subjectSlotBinding: 'owned-injective-snapshot-before-capture-or-io',
    });
  });

  it('пинит layout, alpha и интерполяционный закон каждого codec', () => {
    expect(MOTION_PROGRAM_CODEC_SEMANTICS_V1).toEqual({
      scalar: {
        encoded: 'scalar',
        layout: 'f64',
        interpolation: 'affine-unclamped',
        relative: true,
        portable: true,
      },
      colorGamma2: {
        encoded: 'vector',
        layout: 'encoded-srgb-straight-rgba',
        ranges: ['[0,255]', '[0,255]', '[0,255]', '[0,1]'],
        interpolation: 'sqrt-energy-rgb-linear-alpha-clamped-progress',
        relative: false,
        portable: true,
      },
      colorSrgb: {
        encoded: 'vector',
        layout: 'encoded-srgb-straight-rgba',
        ranges: ['[0,255]', '[0,255]', '[0,255]', '[0,1]'],
        interpolation: 'encoded-srgb-linear-alpha-clamped-progress',
        relative: false,
        portable: true,
      },
      colorHslShortest: {
        encoded: 'vector',
        layout: 'h-deg-s-l-straight-a',
        ranges: ['[0,360)', '[0,1]', '[0,1]', '[0,1]'],
        interpolation: 'shortest-hue-linear-sla-clamped-progress',
        relative: false,
        portable: true,
      },
      discrete: {
        encoded: 'token',
        layout: 'string-index',
        interpolation: 'right-continuous-half-swap',
        relative: false,
        portable: false,
      },
      webCssOpaque: {
        encoded: 'token',
        layout: 'string-index',
        interpolation: 'registered-host',
        relative: false,
        portable: false,
      },
    });
    expect(MOTION_PROGRAM_SEGMENT_SEMANTICS_V1).toEqual({
      codecOwner: 'outgoing-segment',
      coverage: 'strict-positive-contiguous-zero-to-one',
      endpoint: 'exact-before-curve',
      boundary: 'right-segment-wins-at-exact-offset',
      boundaryRepresentation: 'explicit-left-to-and-right-from',
      mixedCodec: 'portable-within-one-track',
    });
  });

  it('оставляет overshoot в effect-state, а coverage clamp делает только presentation', () => {
    expect(interpolateMotionProgramValueV1(
      MOTION_PROGRAM_CODEC_V1.scalar,
      [0, 0],
      [0, 1],
      1.25,
    )).toEqual([0, 1.25]);
    expect(presentMotionProgramScalarV1(MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 1.25)).toBe(1.25);
    expect(presentMotionProgramScalarV1(MOTION_PROGRAM_STANDARD_CHANNEL_V1.opacity, 1.25)).toBe(1);
  });

  it('пинит T·S·R·combined-skew и y-up mapping без матричной двусмысленности', () => {
    expect(MOTION_PROGRAM_TRANSFORM_SEMANTICS_V1).toEqual({
      numericModel: 'ieee754-binary64',
      matrixOrder: 'translate*scale*rotate*combinedSkew',
      matrixEvaluation: 'closed-form-T*S*R*combinedSkew',
      cssMatrixLayout: '[a,b,c,d,tx,ty]',
      combinedSkewMatrix: '[1,tan(skewY),tan(skewX),1,0,0]',
      angleReduction: 'truncating-remainder-then-half-open-fold-before-radians',
      matrixOverflow: 'componentwise-saturate-to-f64-greatest-finite',
      matrixOverflowFeedsBack: false,
      totalityDomain: 'all-seven-resolved-finite-scalars',
      yUpAdapter: {
        negate: ['translateY', 'rotate', 'skewX', 'skewY'],
        preserve: ['translateX', 'scaleX', 'scaleY'],
      },
    });
    expect(composeMotionProgramTransform2DV1({
      translateX: 10,
      translateY: 0,
      scaleX: 2,
      scaleY: 1,
      rotate: 0,
      skewX: 0,
      skewY: 0,
    })).toEqual([2, 0, 0, 1, 10, 0]);

    const combinedSkew = composeMotionProgramTransform2DV1({
      translateX: 0,
      translateY: 0,
      scaleX: 1,
      scaleY: 1,
      rotate: 0,
      skewX: 45,
      skewY: 45,
    });
    expect(combinedSkew[0]).toBeCloseTo(1, 12);
    expect(combinedSkew[1]).toBeCloseTo(1, 12);
    expect(combinedSkew[2]).toBeCloseTo(1, 12);
    expect(combinedSkew[3]).toBeCloseTo(1, 12);
  });

  it('делает transform presentation total для каждого конечного effect-state', () => {
    const cases = [
      {
        translateX: 0,
        translateY: 0,
        scaleX: 1,
        scaleY: 1,
        rotate: Number.MAX_VALUE,
        skewX: 0,
        skewY: 0,
      },
      {
        translateX: Number.MAX_VALUE,
        translateY: -Number.MAX_VALUE,
        scaleX: Number.MAX_VALUE,
        scaleY: -Number.MAX_VALUE,
        rotate: -45,
        skewX: -45,
        skewY: 45,
      },
      {
        translateX: -0,
        translateY: 0,
        scaleX: -Number.MAX_VALUE,
        scaleY: Number.MAX_VALUE,
        rotate: -Number.MAX_VALUE,
        skewX: Number.MAX_VALUE,
        skewY: -Number.MAX_VALUE,
      },
    ];
    for (const state of cases) {
      const before = { ...state };
      const matrix = composeMotionProgramTransform2DV1(state);
      expect(matrix).toHaveLength(6);
      expect(matrix.every(Number.isFinite)).toBe(true);
      expect(Object.isFrozen(matrix)).toBe(true);
      expect(state).toEqual(before);
    }
    const saturated = composeMotionProgramTransform2DV1(cases[1]!);
    expect(saturated[0]).toBe(Number.MAX_VALUE);
    expect(saturated[3]).toBe(-Number.MAX_VALUE);

    const principal = composeMotionProgramTransform2DV1({
      translateX: 3,
      translateY: -4,
      scaleX: 1.25,
      scaleY: -0.75,
      rotate: 37,
      skewX: 11,
      skewY: -23,
    });
    expect(composeMotionProgramTransform2DV1({
      translateX: 3,
      translateY: -4,
      scaleX: 1.25,
      scaleY: -0.75,
      rotate: 37 + 360 * 1_000_000,
      skewX: 11 - 180 * 1_000_000,
      skewY: -23 + 180 * 1_000_000,
    })).toEqual(principal);
  });

  it('остаётся total на seeded raw-binary64 transform corpus', () => {
    let seed = 0x6a09_e667;
    const bits = new DataView(new ArrayBuffer(8));
    const nextFinite = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      bits.setUint32(0, seed, true);
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      bits.setUint32(4, seed, true);
      const value = bits.getFloat64(0, true);
      return Number.isFinite(value) ? value : 0;
    };
    for (let sample = 0; sample < 32_768; sample++) {
      const matrix = composeMotionProgramTransform2DV1({
        translateX: nextFinite(),
        translateY: nextFinite(),
        scaleX: nextFinite(),
        scaleY: nextFinite(),
        rotate: nextFinite(),
        skewX: nextFinite(),
        skewY: nextFinite(),
      });
      expect(matrix.every(Number.isFinite), `non-finite matrix at seed sample ${sample}`).toBe(true);
    }
  });

  it('дифференциально сохраняет обычную последовательную T·S·R·K композицию', () => {
    type Matrix = readonly [number, number, number, number, number, number];
    const multiply = (left: Matrix, right: Matrix): Matrix => [
      left[0] * right[0] + left[2] * right[1],
      left[1] * right[0] + left[3] * right[1],
      left[0] * right[2] + left[2] * right[3],
      left[1] * right[2] + left[3] * right[3],
      left[0] * right[4] + left[2] * right[5] + left[4],
      left[1] * right[4] + left[3] * right[5] + left[5],
    ];
    let seed = 0xbb67_ae85;
    const random = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 2_048; sample++) {
      const state = {
        translateX: (random() - 0.5) * 2_000,
        translateY: (random() - 0.5) * 2_000,
        scaleX: (random() - 0.5) * 20,
        scaleY: (random() - 0.5) * 20,
        rotate: (random() - 0.5) * 160,
        skewX: (random() - 0.5) * 160,
        skewY: (random() - 0.5) * 160,
      };
      const radians = state.rotate * Math.PI / 180;
      const skewXRadians = state.skewX * Math.PI / 180;
      const skewYRadians = state.skewY * Math.PI / 180;
      const expected = multiply(multiply(multiply(
        [1, 0, 0, 1, state.translateX, state.translateY],
        [state.scaleX, 0, 0, state.scaleY, 0, 0],
      ), [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0]), [
        1, Math.tan(skewYRadians), Math.tan(skewXRadians), 1, 0, 0,
      ]);
      const actual = composeMotionProgramTransform2DV1(state);
      for (let component = 0; component < 6; component++) {
        const scale = Math.max(1, Math.abs(expected[component]!), Math.abs(actual[component]!));
        // Два пути суммарно делают <16 округляемых операций на компонент;
        // 32 epsilon — Higham-style first-order bound с двукратным запасом.
        expect(Math.abs(actual[component]! - expected[component]!))
          .toBeLessThanOrEqual(32 * Number.EPSILON * scale);
      }
    }
  });

  it('дифференциально сохраняет три текущих web-режима цвета без premultiply', () => {
    const rgbFrom = parseColor('rgba(255, 0, 0, 0)')!;
    const rgbTo = parseColor('rgba(0, 0, 255, 1)')!;
    const hslFrom = parseColor('hsla(350, 100%, 50%, 0.2)')!;
    const hslTo = parseColor('hsla(10, 50%, 25%, 0.8)')!;
    const progress = [0, 0.125, 0.5, 0.875, 1];
    for (const p of progress) {
      const gamma = interpolateMotionProgramValueV1(
        MOTION_PROGRAM_CODEC_V1.colorGamma2,
        [1, rgbFrom.r, rgbFrom.g, rgbFrom.b, rgbFrom.a],
        [1, rgbTo.r, rgbTo.g, rgbTo.b, rgbTo.a],
        p,
      );
      expect(formatMotionProgramColorV1(MOTION_PROGRAM_CODEC_V1.colorGamma2, gamma))
        .toBe(interpolateColor(rgbFrom, rgbTo, p));

      const srgb = interpolateMotionProgramValueV1(
        MOTION_PROGRAM_CODEC_V1.colorSrgb,
        [1, rgbFrom.r, rgbFrom.g, rgbFrom.b, rgbFrom.a],
        [1, rgbTo.r, rgbTo.g, rgbTo.b, rgbTo.a],
        p,
      );
      expect(formatMotionProgramColorV1(MOTION_PROGRAM_CODEC_V1.colorSrgb, srgb))
        .toBe(interpolateColor(rgbFrom, rgbTo, p, { space: 'srgb' }));

      const hsl = interpolateMotionProgramValueV1(
        MOTION_PROGRAM_CODEC_V1.colorHslShortest,
        [1, hslFrom.hsl!.h, hslFrom.hsl!.s, hslFrom.hsl!.l, hslFrom.a],
        [1, hslTo.hsl!.h, hslTo.hsl!.s, hslTo.hsl!.l, hslTo.a],
        p,
      );
      expect(formatMotionProgramColorV1(MOTION_PROGRAM_CODEC_V1.colorHslShortest, hsl))
        .toBe(interpolateColor(hslFrom, hslTo, p));
    }
    const midpoint = interpolateMotionProgramValueV1(
      MOTION_PROGRAM_CODEC_V1.colorGamma2,
      [1, 255, 0, 0, 0],
      [1, 0, 0, 255, 1],
      0.5,
    );
    expect(midpoint).toEqual([1, Math.sqrt(255 * 255 * 0.5), 0, Math.sqrt(255 * 255 * 0.5), 0.5]);
  });

  it('повторяет порядок IEEE-операций Web color lerp, а не только его алгебру', () => {
    const from = 0.23645552527159452;
    const to = 0.3692706737201661;
    const progress = 0.5042420323006809;
    const expectedAlpha = from + (to - from) * progress;
    const weightedAlpha = (1 - progress) * from + progress * to;
    expect(Object.is(expectedAlpha, weightedAlpha)).toBe(false);

    const result = interpolateMotionProgramValueV1(
      MOTION_PROGRAM_CODEC_V1.colorSrgb,
      [1, 0, 0, 0, from],
      [1, 255, 255, 255, to],
      progress,
    );
    expect(Object.is(result[4], expectedAlpha)).toBe(true);
  });

  it('sampled curve задаёт скачок повторным offset; на точной границе побеждает последний', () => {
    // steps(3, jump-none): два внутренних скачка, крайние значения без прыжка.
    const curve = [
      1,
      0, 0,
      1 / 3, 0,
      1 / 3, 0.5,
      2 / 3, 0.5,
      2 / 3, 1,
      1, 1,
    ] as const;
    expect(evaluateMotionProgramCurveV1(curve, 1 / 3 - Number.EPSILON)).toBeLessThan(0.5);
    expect(evaluateMotionProgramCurveV1(curve, 1 / 3)).toBe(0.5);
    expect(evaluateMotionProgramCurveV1(curve, 2 / 3)).toBe(1);
    expect(evaluateMotionProgramCurveV1(curve, 0)).toBe(0);
    expect(evaluateMotionProgramCurveV1(curve, 1)).toBe(1);
  });

  it('v0-пружина компилируется в тот же sampled IR и остаётся в пределах tolerance', () => {
    const spring = { mass: 1, stiffness: 170, damping: 26 };
    const v0 = 3;
    const artifact = compileSpringExecutionArtifactTupleUnchecked(
      spring,
      v0,
      DEFAULT_TOLERANCE,
    );
    const samples = artifact[1];
    const curve: number[] = [1];
    for (let i = 0; i < samples.length; i += 2) {
      curve.push(samples[i]! / 100, samples[i + 1]!);
    }
    const durationSeconds = artifact[2] / 1_000;
    const firstSlope = (curve[4]! - curve[2]!) / (curve[3]! - curve[1]!);
    expect(firstSlope / durationSeconds).toBeCloseTo(v0, 12);
    for (let i = 0; i <= 128; i++) {
      const u = i / 128;
      const expected = readCompositorSpring(spring, { v0, t: u * durationSeconds }).value;
      expect(Math.abs(evaluateMotionProgramCurveV1(curve as never, u) - expected))
        .toBeLessThanOrEqual(DEFAULT_TOLERANCE);
    }
  });

  it('даёт точные half-open repeat boundaries, terminal hold и O(1) zero-duration', () => {
    const input = minimalProgramInput();
    const track = (input[5] as unknown[][])[0]!;
    track[1] = 10;
    track[2] = 100;
    track[3] = 1;
    track[5] = 20;
    const parsed = parseMotionProgramV1(input)[5][0]!;
    expect(evaluateMotionProgramScheduleV1(parsed, 9)).toMatchObject({ state: 'before', progress: 0 });
    expect(evaluateMotionProgramScheduleV1(parsed, 10)).toMatchObject({ state: 'motion', iteration: 0, progress: 0 });
    expect(evaluateMotionProgramScheduleV1(parsed, 110)).toMatchObject({ state: 'repeatDelay', iteration: 0, progress: 1 });
    expect(evaluateMotionProgramScheduleV1(parsed, 130)).toMatchObject({ state: 'motion', iteration: 1, progress: 0 });
    expect(evaluateMotionProgramScheduleV1(parsed, 230)).toMatchObject({ state: 'terminal', iteration: 1, progress: 1 });
    expect(evaluateMotionProgramScheduleV1(parsed, 231)).toMatchObject({ state: 'after', iteration: 1, progress: 1 });

    const zero = minimalProgramInput();
    const zeroTrack = (zero[5] as unknown[][])[0]!;
    zeroTrack[2] = 0;
    zeroTrack[3] = 1;
    zeroTrack[4] = MOTION_PROGRAM_DIRECTION_V1.alternate;
    zeroTrack[5] = 1;
    const zeroParsed = parseMotionProgramV1(zero)[5][0]!;
    expect(evaluateMotionProgramScheduleV1(zeroParsed, 0)).toMatchObject({
      state: 'repeatDelay', iteration: 0, progress: 1,
    });
    expect(evaluateMotionProgramScheduleV1(zeroParsed, 1)).toMatchObject({
      state: 'terminal', iteration: 1, progress: 0,
    });

    const collapsed = minimalProgramInput();
    const collapsedTrack = (collapsed[5] as unknown[][])[0]!;
    collapsedTrack[2] = 0;
    collapsedTrack[3] = 7;
    collapsedTrack[4] = MOTION_PROGRAM_DIRECTION_V1.alternate;
    expect(evaluateMotionProgramScheduleV1(
      parseMotionProgramV1(collapsed)[5][0]!,
      0,
    )).toMatchObject({ state: 'terminal', iteration: 7, progress: 0 });
  });

  it('не перескакивает repeat-boundary на соседних binary64 значениях', () => {
    for (const [duration, repeatDelay] of [[1.3, 0], [0.1, 0.2], [10 / 3, 0.7]] as const) {
      const input = minimalProgramInput();
      const track = (input[5] as unknown[][])[0]!;
      track[2] = duration;
      track[3] = 5;
      track[4] = MOTION_PROGRAM_DIRECTION_V1.normal;
      track[5] = repeatDelay;
      const parsed = parseMotionProgramV1(input)[5][0]!;
      const cycle = duration + repeatDelay;

      for (let iteration = 1; iteration <= 5; iteration++) {
        const boundary = cycle * iteration;
        const before = evaluateMotionProgramScheduleV1(
          parsed,
          adjacentFloat(boundary, -1),
        );
        const exact = evaluateMotionProgramScheduleV1(parsed, boundary);
        const after = evaluateMotionProgramScheduleV1(
          parsed,
          adjacentFloat(boundary, 1),
        );

        expect(before.iteration, `${duration}/${repeatDelay} before ${iteration}`).toBe(iteration - 1);
        expect(before.progress, `${duration}/${repeatDelay} progress before ${iteration}`)
          .toBeGreaterThanOrEqual(0);
        expect(exact, `${duration}/${repeatDelay} exact ${iteration}`).toMatchObject({
          state: 'motion',
          iteration,
          progress: 0,
        });
        expect(after.iteration, `${duration}/${repeatDelay} after ${iteration}`).toBe(iteration);
        expect(after.progress, `${duration}/${repeatDelay} progress after ${iteration}`)
          .toBeGreaterThanOrEqual(0);
      }
    }

    const alternate = minimalProgramInput();
    const alternateTrack = (alternate[5] as unknown[][])[0]!;
    alternateTrack[2] = 1.3;
    alternateTrack[3] = 3;
    alternateTrack[4] = MOTION_PROGRAM_DIRECTION_V1.alternate;
    const alternateParsed = parseMotionProgramV1(alternate)[5][0]!;
    const beforeThird = evaluateMotionProgramScheduleV1(
      alternateParsed,
      adjacentFloat(1.3 * 3, -1),
    );
    expect(beforeThird).toMatchObject({ iteration: 2, iterationParity: 0 });
    expect(beforeThird.progress).toBeGreaterThanOrEqual(0);
    expect(beforeThird.progress).toBeLessThan(1);
  });

  it('строит finite schedule по абсолютным representable boundaries', () => {
    const terminalInput = minimalProgramInput();
    const terminalTrack = (terminalInput[5] as unknown[][])[0]!;
    terminalTrack[1] = 0.1;
    terminalTrack[2] = 0.2;
    const terminalParsed = parseMotionProgramV1(terminalInput)[5][0]!;
    const terminal = 0.1 + 0.2;
    expect(evaluateMotionProgramScheduleV1(
      terminalParsed,
      adjacentFloat(terminal, -1),
    )).toMatchObject({ state: 'motion', iteration: 0 });
    expect(evaluateMotionProgramScheduleV1(terminalParsed, terminal)).toMatchObject({
      state: 'terminal', iteration: 0, progress: 1,
    });
    expect(evaluateMotionProgramScheduleV1(
      terminalParsed,
      adjacentFloat(terminal, 1),
    )).toMatchObject({ state: 'after', iteration: 0, progress: 1 });

    for (const start of [0.1, -0.1]) {
      const input = minimalProgramInput();
      const track = (input[5] as unknown[][])[0]!;
      track[1] = start;
      track[2] = 1;
      track[3] = 5;
      track[5] = 3;
      const parsed = parseMotionProgramV1(input)[5][0]!;
      const boundary = start + (1 + 3);
      expect(evaluateMotionProgramScheduleV1(
        parsed,
        adjacentFloat(boundary, -1),
      )).toMatchObject({ state: 'repeatDelay', iteration: 0, progress: 1 });
      expect(evaluateMotionProgramScheduleV1(parsed, boundary)).toMatchObject({
        state: 'motion', iteration: 1, progress: 0,
      });
      expect(evaluateMotionProgramScheduleV1(
        parsed,
        adjacentFloat(boundary, 1),
      )).toMatchObject({ state: 'motion', iteration: 1 });
    }
  });

  it('parse отвергает finite schedules с непредставимой ненулевой фазой', () => {
    const rejected = [
      [0, 0.1, 5, 1e15],
      [2 ** 60, 1, 2, 1024],
      [2 ** 60, 1024, 2, 1],
      [
        3.192153723814767e255,
        1.4590828405955197e240,
        287,
        5.069789595563282e239,
      ],
      [0, Number.MAX_VALUE / 2, 3, 0],
    ] as const;
    for (const [start, duration, repeat, repeatDelay] of rejected) {
      const input = minimalProgramInput();
      const track = (input[5] as unknown[][])[0]!;
      track[1] = start;
      track[2] = duration;
      track[3] = repeat;
      track[5] = repeatDelay;
      expectIssue(() => parseMotionProgramV1(input), 'LMP_BOUNDS');
    }

    for (const start of [2 ** 60, -(2 ** 60)]) {
      const input = minimalProgramInput();
      const track = (input[5] as unknown[][])[0]!;
      track[1] = start;
      track[2] = 1024;
      track[3] = 2;
      track[5] = 2048;
      expect(() => parseMotionProgramV1(input)).not.toThrow();
    }
  });

  it('извлекает gap из фактического binade у nextDown степеней двойки', () => {
    for (const exponent of [-1000, -100, 0, 10, 100, 500, 1023]) {
      const power = 2 ** exponent;
      const below = adjacentFloat(power, -1);
      expect(motionProgramBinary64GapV1(below)).toBe(2 ** (exponent - 53));
      expect(motionProgramBinary64GapV1(power)).toBe(2 ** (exponent - 52));
    }

    const input = minimalProgramInput();
    const rawTrack = (input[5] as unknown[][])[0]!;
    rawTrack[2] = 6.821210263296962e-13;
    rawTrack[3] = 1;
    rawTrack[5] = 1023.9999999999992;
    expect(() => parseMotionProgramV1(input)).not.toThrow();
  });

  it('различает все direction и считает infinite parity без опасного quotient', () => {
    const expected = [
      [MOTION_PROGRAM_DIRECTION_V1.normal, 0, 0, false],
      [MOTION_PROGRAM_DIRECTION_V1.reverse, 1, 1, false],
      [MOTION_PROGRAM_DIRECTION_V1.alternate, 0, 1, false],
      [MOTION_PROGRAM_DIRECTION_V1.alternateReverse, 1, 0, false],
      [MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, true],
    ] as const;
    for (const [direction, first, second, mirroredSecond] of expected) {
      const input = minimalProgramInput();
      const track = (input[5] as unknown[][])[0]!;
      track[2] = 1;
      track[3] = 1;
      track[4] = direction;
      const parsed = parseMotionProgramV1(input)[5][0]!;
      expect(evaluateMotionProgramScheduleV1(parsed, 0)).toMatchObject({ progress: first, mirrored: false });
      expect(evaluateMotionProgramScheduleV1(parsed, 1)).toMatchObject({ progress: second, mirrored: mirroredSecond });
    }

    const tiny = minimalProgramInput();
    const tinyTrack = (tiny[5] as unknown[][])[0]!;
    tinyTrack[2] = Number.MIN_VALUE;
    tinyTrack[3] = -1;
    tinyTrack[4] = MOTION_PROGRAM_DIRECTION_V1.alternate;
    const tinyParsed = parseMotionProgramV1(tiny)[5][0]!;
    expect(evaluateMotionProgramScheduleV1(tinyParsed, Number.MIN_VALUE)).toMatchObject({
      iteration: null,
      iterationParity: 1,
      progress: 1,
    });
  });

  it('разрешает current/relative до IO и отклоняет overflow атомарно', () => {
    const chain = parseMotionProgramV1([
      1,
      MOTION_PROGRAM_FEATURE_V1.currentValues | MOTION_PROGRAM_FEATURE_V1.relativeValues,
      [],
      [0],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, 0, 1, 0, 0, 0, 0, [
        [0, 0.5, [0], [2, 1, [0, 2]], 0, 0],
        [0.5, 1, [0], [2, -1, [0, 1]], 0, 0],
      ]]],
    ]);
    expect(resolveMotionProgramSegmentsV1(chain[5][0]![7], [0, 10])).toEqual([
      [[0, 10], [0, 12]],
      [[0, 12], [0, 11]],
    ]);

    const overflow = parseMotionProgramV1([
      1, MOTION_PROGRAM_FEATURE_V1.relativeValues, [], [0],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, 0, 1, 0, 0, 0, 0, [[
        0, 1, [1, [0, Number.MAX_VALUE]], [2, 1, [0, Number.MAX_VALUE]], 0, 0,
      ]]]],
    ]);
    expectIssue(() => resolveMotionProgramSegmentsV1(overflow[5][0]![7]), 'LMP_NUMBER');

    const currentOverflow = parseMotionProgramV1([
      1,
      MOTION_PROGRAM_FEATURE_V1.currentValues | MOTION_PROGRAM_FEATURE_V1.relativeValues,
      [], [0], [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, 0, 1, 0, 0, 0, 0, [[0, 1, [0], [2, 1, [0, Number.MAX_VALUE]], 0, 0]]]],
    ]);
    expectIssue(
      () => resolveMotionProgramSegmentsV1(currentOverflow[5][0]![7], [0, Number.MAX_VALUE]),
      'LMP_NUMBER',
    );
  });

  it('сначала snapshot-ит hostile baseline и валидирует именно snapshot', () => {
    const current = parseMotionProgramV1([
      1,
      MOTION_PROGRAM_FEATURE_V1.currentValues,
      [], [0], [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, 0, 1, 0, 0, 0, 0, [[0, 1, [0], [1, [0, 20]], 0, 0]]]],
    ]);
    const iteratorDrift = new Proxy<MotionProgramEncodedValueV1>([0, 10] as const, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) {
          return function* hostileIterator(): Generator<number> {
            yield 0;
            yield Infinity;
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(resolveMotionProgramSegmentsV1(current[5][0]![7], iteratorDrift)).toEqual([
      [[0, 10], [0, 20]],
    ]);

    const descriptorTrap = new Proxy<MotionProgramEncodedValueV1>([0, 10] as const, {
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor trap');
      },
    });
    expectIssue(
      () => resolveMotionProgramSegmentsV1(current[5][0]![7], descriptorTrap),
      'LMP_SHAPE',
    );
  });

  it('исполняет per-segment codec с authored timing/curve и exact mirror endpoint', () => {
    const parsed = parseMotionProgramV1([
      1, 0, [], [0, [1, 0, 0, 1, 0.25]],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, 0, 1, 1, MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, [
        [0, 0.25, [1, [0, 0]], [1, [0, 10]], 0, 0],
        [0.25, 1, [1, [0, 12]], [1, [0, 20]], 1, 0],
      ]]],
    ]);
    const track = parsed[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);
    const at = (time: number): number => {
      const value = evaluateMotionProgramSegmentsV1(
        track[7], resolved, parsed[3], evaluateMotionProgramScheduleV1(track, time),
      );
      return value[1]!;
    };
    expect(at(1)).toBe(20);
    expect(at(1.75)).toBe(25 / 3);
    expect(at(2)).toBe(0);

    const normalBoundary = evaluateMotionProgramSegmentsV1(
      track[7], resolved, parsed[3],
      { state: 'motion', iteration: 0, iterationParity: 0, progress: 0.25, mirrored: false },
    );
    expect(normalBoundary).toEqual([0, 12]);
  });

  it('оставляет authored mirror interval total для минимального положительного offset', () => {
    const parsed = parseMotionProgramV1([
      1, 0, [], [0],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, 0, 1, 1, MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, [
        [0, Number.MIN_VALUE, [1, [0, 10]], [1, [0, 11]], 0, 0],
        [Number.MIN_VALUE, 1, [1, [0, 11]], [1, [0, 20]], 0, 0],
      ]]],
    ]);
    const track = parsed[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);
    const at = (progress: number) => evaluateMotionProgramSegmentsV1(
      track[7],
      resolved,
      parsed[3],
      { state: 'motion', iteration: null, iterationParity: 1, progress, mirrored: true },
    );
    expect(at(adjacentFloat(1, -1))).toEqual([0, 10]);
    expect(at(1)).toEqual([0, 10]);
  });

  it('выбирает правый authored segment по representable mirror-boundary', () => {
    const boundary = 0.00003051760077154911;
    const parsed = parseMotionProgramV1([
      1, 0, [], [0],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, 0, 1, 1, MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, [
        [0, boundary, [1, [0, 0]], [1, [0, 10]], 0, 0],
        [boundary, 1, [1, [0, 20]], [1, [0, 30]], 0, 0],
      ]]],
    ]);
    const track = parsed[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);
    const at = (progress: number) => evaluateMotionProgramSegmentsV1(
      track[7],
      resolved,
      parsed[3],
      { state: 'motion', iteration: null, iterationParity: 1, progress, mirrored: true },
    )[1]!;

    expect(at(adjacentFloat(boundary, -1))).toBe(20.000000000000004);
    expect(at(boundary)).toBe(10);
    expect(at(adjacentFloat(boundary, 1))).toBe(10);
  });

  it('сохраняет sampled-curve jump в authored forward координатах', () => {
    const boundary = 0.10720231540575624;
    const parsed = parseMotionProgramV1([
      1, 0, [], [0, [1, 0, 0, boundary, 0, boundary, 1, 1, 1]],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
      [[0, -1, 1, 1, MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, [
        [0, 1, [1, [0, 0]], [1, [0, 1]], 1, 0],
      ]]],
    ]);
    const track = parsed[5][0]!;
    const schedule = evaluateMotionProgramScheduleV1(track, boundary);
    expect(schedule).toMatchObject({
      state: 'motion',
      iteration: 1,
      iterationParity: 1,
      progress: boundary,
      mirrored: true,
    });
    expect(evaluateMotionProgramSegmentsV1(
      track[7],
      resolveMotionProgramSegmentsV1(track[7]),
      parsed[3],
      schedule,
    )).toEqual([0, 0]);
  });

  it('не сводит HSL→HSL→RGB к binding-level codec при normal и mirror', () => {
    const parsed = parseMotionProgramV1([
      1, 0, [], [0],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.color, 0]],
      [[0, 0, 1, 1, MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, [
        [
          0, 0.5,
          [1, [1, 0, 1, 0.5, 1]],
          [1, [1, 120, 1, 0.5, 1]],
          0, MOTION_PROGRAM_CODEC_V1.colorHslShortest,
        ],
        [
          0.5, 1,
          [1, [1, 0, 255, 0, 1]],
          [1, [1, 255, 255, 0, 1]],
          0, MOTION_PROGRAM_CODEC_V1.colorSrgb,
        ],
      ]]],
    ]);
    const track = parsed[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);
    const at = (timeMs: number) => evaluateMotionProgramSegmentsV1(
      track[7], resolved, parsed[3], evaluateMotionProgramScheduleV1(track, timeMs),
    );

    expect(at(0.25)).toEqual([1, 60, 1, 0.5, 1]);
    // На общей границе побеждает right-segment representation: RGB green.
    expect(at(0.5)).toEqual([1, 0, 255, 0, 1]);
    expect(at(0.75)).toEqual([1, 127.5, 255, 0, 1]);
    expect(at(1.25)).toEqual([1, 127.5, 255, 0, 1]);
    // Mirror меняет порядок сегментов; на границе теперь побеждает HSL green.
    expect(at(1.5)).toEqual([1, 120, 1, 0.5, 1]);
    expect(at(1.75)).toEqual([1, 60, 1, 0.5, 1]);
  });

  it('возвращает exact heterogeneous endpoints до sampled curve при normal и mirror', () => {
    const parsed = parseMotionProgramV1([
      1, 0, [], [0, [1, 0, 0.25, 1, 0.25]],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.color, 0]],
      [[0, 0, 1, 0, MOTION_PROGRAM_DIRECTION_V1.normal, 0, 0, [
        [
          0, 0.5,
          [1, [1, 0, 1, 0.5, 1]],
          [1, [1, 120, 1, 0.5, 1]],
          1, MOTION_PROGRAM_CODEC_V1.colorHslShortest,
        ],
        [
          0.5, 1,
          [1, [1, 0, 255, 0, 1]],
          [1, [1, 255, 255, 0, 1]],
          1, MOTION_PROGRAM_CODEC_V1.colorSrgb,
        ],
      ]]],
    ]);
    const track = parsed[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);
    const at = (progress: number, mirrored: boolean) => evaluateMotionProgramSegmentsV1(
      track[7],
      resolved,
      parsed[3],
      { state: 'motion', iteration: null, iterationParity: 0, progress, mirrored },
    );

    expect(at(0, false)).toEqual([1, 0, 1, 0.5, 1]);
    expect(at(1, false)).toEqual([1, 255, 255, 0, 1]);
    expect(at(0, true)).toEqual([1, 255, 255, 0, 1]);
    expect(at(1, true)).toEqual([1, 0, 1, 0.5, 1]);
  });

  it('в batched transform до start берёт captured baseline задержанного канала', () => {
    const program = minimalProgramInput();
    (program[5] as unknown[][])[0]![1] = 100;
    const parsed = parseMotionProgramV1(program);
    const track = parsed[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);
    const x = presentMotionProgramTrackValueV1(
      track[7], resolved, parsed[3], evaluateMotionProgramScheduleV1(track, 0), [0, 7],
    );
    expect(x).toEqual([0, 7]);
  });
});
