import { describe, expect, it } from 'vitest';
import { keyframes, type EasingFn } from '../src/keyframes/index.js';
import {
  compilePreset,
  runPreset,
  samplePreset,
} from '../src/presets/index.js';
import {
  isRepeatCount,
  isRepeatScheduleRepresentable,
  repeatCursor,
  type RepeatDirection,
} from '../src/internal/repeat-cursor.js';
import {
  parseMotionProgramV1,
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  type MotionProgramDirectionV1,
  type MotionProgramTrackV1,
} from '../src/internal/motion-program.js';
import {
  evaluateMotionProgramScheduleV1,
  evaluateMotionProgramSegmentsV1,
  resolveMotionProgramSegmentsV1,
} from '../scripts/motion-program-semantics.js';
import { compileWaapi } from '../src/waapi/index.js';

const INT32_MAX = 0x7fff_ffff;
const frozenFrame = (): number => 1;

function adjacentFloat(value: number, direction: -1 | 1): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  bits += direction > 0 ? 1n : -1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function decode(cursor: number): readonly [progress: number, mirrored: boolean] {
  return cursor < 0 ? [-1 - cursor, true] : [cursor, false];
}

function referenceTrack(
  duration: number,
  repeat: number,
  repeatDelay: number,
  direction: MotionProgramDirectionV1,
): MotionProgramTrackV1 {
  return [
    0,
    0,
    duration,
    repeat === Infinity ? -1 : repeat,
    direction,
    repeatDelay,
    MOTION_PROGRAM_COMPOSITE_V1.replace,
    [],
  ];
}

const DIRECTIONS = [
  [0, MOTION_PROGRAM_DIRECTION_V1.normal],
  [1, MOTION_PROGRAM_DIRECTION_V1.alternate],
  [2, MOTION_PROGRAM_DIRECTION_V1.mirror],
] as const satisfies readonly (readonly [RepeatDirection, MotionProgramDirectionV1])[];

const PUBLIC_DIRECTIONS = [
  ['loop', MOTION_PROGRAM_DIRECTION_V1.normal],
  ['reverse', MOTION_PROGRAM_DIRECTION_V1.alternate],
  ['mirror', MOTION_PROGRAM_DIRECTION_V1.mirror],
] as const;

function expectedLinearValue(track: MotionProgramTrackV1, time: number): number {
  const schedule = evaluateMotionProgramScheduleV1(track, time);
  return 100 * (schedule.mirrored ? 1 - schedule.progress : schedule.progress);
}

function samplePublicKeyframes(
  duration: number,
  repeat: number,
  repeatDelay: number,
  repeatType: 'loop' | 'reverse' | 'mirror',
  time: number,
): number {
  let value = Number.NaN;
  const controls = keyframes({
    values: [0, 100],
    duration,
    repeat,
    repeatDelay,
    repeatType,
    requestFrame: frozenFrame,
    onStep: (next) => { value = next; },
  });
  controls.pause();
  controls.seek(time);
  controls.cancel();
  return value;
}

function samplePublicTrack(
  values: readonly number[],
  times: readonly number[],
  easing: readonly EasingFn[],
  progress: number,
  mirrored: boolean,
): number {
  let value = Number.NaN;
  const controls = keyframes({
    values,
    times,
    easing,
    duration: 1,
    repeat: mirrored ? 1 : 0,
    repeatType: mirrored ? 'mirror' : 'loop',
    requestFrame: frozenFrame,
    onStep: (next) => { value = next; },
  });
  controls.pause();
  controls.seek((mirrored ? 1 : 0) + progress);
  controls.cancel();
  return value;
}

function samplePublicMirror(
  values: readonly number[],
  times: readonly number[],
  easing: readonly EasingFn[],
  progress: number,
): number {
  return samplePublicTrack(values, times, easing, progress, true);
}

describe('repeat runtime — MotionProgram V1 schedule conformance', () => {
  it('keeps exact normal/mirror endpoints before authored easing across public and V1 paths', () => {
    const constantQuarter = (): number => 0.25;
    const values = [0, 100, 20] as const;
    const times = [0, 0.2, 1] as const;
    const easings = [constantQuarter, constantQuarter] as const;
    const program = parseMotionProgramV1([
      1,
      0,
      [],
      [0, [1, 0, 0.25, 1, 0.25]],
      [[0, 0, 0]],
      [[0, 0, 1, 1, MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, [
        [0, 0.2, [1, [0, 0]], [1, [0, 100]], 1, 0],
        [0.2, 1, [1, [0, 100]], [1, [0, 20]], 1, 0],
      ]]],
    ]);
    const track = program[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);

    for (const mirrored of [false, true]) {
      for (const progress of [0, 1]) {
        const publicValue = samplePublicTrack(values, times, easings, progress, mirrored);
        const portableValue = evaluateMotionProgramSegmentsV1(
          track[7],
          resolved,
          program[3],
          { state: 'motion', iteration: null, iterationParity: 0, progress, mirrored },
        )[1];
        expect(portableValue, `${mirrored ? 'mirror' : 'normal'}@${progress}`)
          .toBe(publicValue);
      }
    }
  });

  it('keeps mirror values reversed while authored nonuniform time/easing run forward', () => {
    const constant0 = (): number => 0;
    const linear = (t: number): number => t;

    // Reviewer regression: reverse-time/reference returned 60 here, while the
    // owner contract is reversed values under the first authored easing.
    expect(samplePublicMirror(
      [0, 100, 20],
      [0, 0.5, 1],
      [constant0, linear],
      0.25,
    )).toBe(20);

    const values = [0, 100, 20] as const;
    const times = [0, 0.2, 1] as const;
    const easings = [constant0, linear] as const;
    const preset = compilePreset({
      duration: 1,
      repeat: 1,
      repeatType: 'mirror',
      tracks: [{ property: 'x', values, times, easing: easings }],
    });
    const program = parseMotionProgramV1([
      1,
      0,
      [],
      [0, [1, 0, 0, 1, 0]],
      [[0, 0, 0]],
      [[0, 0, 1, 1, MOTION_PROGRAM_DIRECTION_V1.mirror, 0, 0, [
        [0, 0.2, [1, [0, 0]], [1, [0, 100]], 1, 0],
        [0.2, 1, [1, [0, 100]], [1, [0, 20]], 0, 0],
      ]]],
    ]);
    const track = program[5][0]!;
    const resolved = resolveMotionProgramSegmentsV1(track[7]);

    for (const progress of [0, 0.1, 0.2, 0.6, 1]) {
      const publicValue = samplePublicMirror(values, times, easings, progress);
      const presetValue = samplePreset(preset, 1 + progress).x;
      const portableValue = evaluateMotionProgramSegmentsV1(
        track[7],
        resolved,
        program[3],
        evaluateMotionProgramScheduleV1(track, 1 + progress),
      )[1];
      expect(presetValue, `preset@${progress}`).toBe(publicValue);
      expect(portableValue, `V1@${progress}`).toBe(publicValue);
    }
  });

  it('keeps public finite non-dyadic terminal probes on the greatest V1 boundary', () => {
    const duration = 0.3;
    const repeat = 5;
    const nominalTerminalProbe = 6 * duration;

    for (const [repeatType, programDirection] of PUBLIC_DIRECTIONS) {
      const track = referenceTrack(duration, repeat, 0, programDirection);
      for (const time of [
        adjacentFloat(nominalTerminalProbe, -1),
        nominalTerminalProbe,
        adjacentFloat(nominalTerminalProbe, 1),
      ]) {
        expect(
          samplePublicKeyframes(duration, repeat, 0, repeatType, time),
          `${repeatType}@${time}`,
        ).toBeCloseTo(expectedLinearValue(track, time), 13);
      }
    }
  });

  it('keeps public absolute-start exact/adjacent probes on the V1 operation order', () => {
    const start = 0.1;
    const duration = 0.1;
    const repeatDelay = 1.8;
    const repeat = 1;
    const boundary = (duration + repeatDelay) + start;

    for (const [repeatType, programDirection] of PUBLIC_DIRECTIONS) {
      const preset = compilePreset({
        delay: start,
        duration,
        repeat,
        repeatDelay,
        repeatType,
        tracks: [{ property: 'x', values: [0, 100] }],
      });
      const track = [
        ...referenceTrack(duration, repeat, repeatDelay, programDirection),
      ] as unknown as MotionProgramTrackV1;
      (track as unknown as number[])[1] = start;

      for (const time of [
        adjacentFloat(boundary, -1),
        boundary,
        adjacentFloat(boundary, 1),
      ]) {
        expect(samplePreset(preset, time).x, `${repeatType}@${time}`)
          .toBeCloseTo(expectedLinearValue(track, time), 13);
      }
    }
  });

  it('does not silently diverge from V1 at a huge infinite quotient', () => {
    const duration = 0.3;
    const repeatDelay = 0.2;
    const time = 2 ** 53;

    for (const [repeatType, programDirection] of PUBLIC_DIRECTIONS) {
      const preset = compilePreset({
        duration,
        repeat: Infinity,
        repeatDelay,
        repeatType,
        tracks: [{ property: 'x', values: [0, 100] }],
      });
      const track = referenceTrack(duration, Infinity, repeatDelay, programDirection);
      for (const probe of [adjacentFloat(time, -1), time, adjacentFloat(time, 1)]) {
        expect(() => evaluateMotionProgramScheduleV1(track, probe), `${repeatType}@${probe}`)
          .toThrowError(/^LMP_BOUNDS$/);
        expect(() => samplePreset(preset, probe), `${repeatType}@${probe}`)
          .toThrowError(/^LM166$/);
      }
    }
  });

  it('fails closed when the first unsafe boundary collapses onto the last exact one', () => {
    const start = 13_475_415_410_688;
    const duration = 0.014899620437063277;
    const time = Number.MAX_SAFE_INTEGER * duration + start;
    const preset = compilePreset({
      delay: start,
      duration,
      repeat: Infinity,
      tracks: [{ property: 'x', values: [0, 100] }],
    });

    expect((Number.MAX_SAFE_INTEGER + 1) * duration + start).toBe(time);
    expect(() => samplePreset(preset, time)).toThrowError(/^LM166$/);
  });

  it('keeps the last exact infinite pose when its quotient rounds unsafe', () => {
    const start = 112_065_955_424;
    const duration = 59.340130001306534;
    const horizon = (Number.MAX_SAFE_INTEGER + 1) * duration + start;
    const beforeHorizon = adjacentFloat(horizon, -1);
    expect(Number.isSafeInteger(Math.floor((beforeHorizon - start) / duration)))
      .toBe(false);

    for (const [repeatType, programDirection] of PUBLIC_DIRECTIONS) {
      const preset = compilePreset({
        delay: start,
        duration,
        repeat: Infinity,
        repeatType,
        tracks: [{ property: 'x', values: [0, 100] }],
      });
      const track = [
        ...referenceTrack(duration, Infinity, 0, programDirection),
      ] as unknown as MotionProgramTrackV1;
      (track as unknown as number[])[1] = start;
      expect(samplePreset(preset, beforeHorizon).x)
        .toBeCloseTo(expectedLinearValue(track, beforeHorizon), 13);
      expect(() => samplePreset(preset, horizon)).toThrowError(/^LM166$/);
    }
  });

  it('rejects infinite control seeks atomically, including +Infinity', () => {
    for (const [repeatType] of PUBLIC_DIRECTIONS) {
      const keyframeControls = keyframes({
        values: [0, 100],
        duration: 0.3,
        repeat: Infinity,
        repeatDelay: 0.2,
        repeatType,
        requestFrame: frozenFrame,
      });
      keyframeControls.pause();
      keyframeControls.seek(1);
      expect(() => keyframeControls.seek(2 ** 53)).toThrowError(/^LM166$/);
      expect(keyframeControls.time).toBe(1);
      expect(() => keyframeControls.seek(Infinity)).toThrowError(/^LM166$/);
      expect(keyframeControls.time).toBe(1);
      keyframeControls.cancel();

      const presetControls = runPreset({
        duration: 0.3,
        repeat: Infinity,
        repeatDelay: 0.2,
        repeatType,
        tracks: [{ property: 'x', values: [0, 100] }],
      }, { requestFrame: frozenFrame });
      presetControls.pause();
      presetControls.seek(1);
      expect(() => presetControls.seek(2 ** 53)).toThrowError(/^LM166$/);
      expect(presetControls.time).toBe(1);
      expect(() => presetControls.seek(Infinity)).toThrowError(/^LM166$/);
      expect(presetControls.time).toBe(1);
      presetControls.cancel();
    }
  });

  it('matches half-open exact/adjacent boundaries, repeat delays, directions and terminal', () => {
    const scenarios = [
      [1, 4, 0],
      [1, 4, 0.5],
      [0.1, 5, 0.2],
      [379.102574955, 5, 147.760447036],
    ] as const;

    for (const [duration, repeat, repeatDelay] of scenarios) {
      const cycle = duration + repeatDelay;
      const probes = new Set<number>([0]);
      for (let iteration = 1; iteration <= repeat; iteration++) {
        const boundary = iteration * cycle;
        probes.add(adjacentFloat(boundary, -1));
        probes.add(boundary);
        probes.add(adjacentFloat(boundary, 1));
        if (repeatDelay > 0) probes.add((iteration - 1) * cycle + duration);
      }
      const terminal = repeat * cycle + duration;
      probes.add(adjacentFloat(terminal, -1));
      probes.add(terminal);
      probes.add(adjacentFloat(terminal, 1));

      for (const [runtimeDirection, programDirection] of DIRECTIONS) {
        const track = referenceTrack(duration, repeat, repeatDelay, programDirection);
        for (const time of probes) {
          const expected = evaluateMotionProgramScheduleV1(track, time);
          const actual = decode(repeatCursor(
            time,
            0,
            duration,
            repeat,
            repeatDelay,
            runtimeDirection,
          ));
          const label = `${duration}/${repeatDelay}/${repeat}/${runtimeDirection}@${time}`;
          expect(actual[1], label).toBe(expected.mirrored);
          if (expected.progress === 0 || expected.progress === 1) {
            expect(actual[0], label).toBe(expected.progress);
          } else {
            expect(actual[0], label).toBeCloseTo(expected.progress, 14);
          }
        }
      }
    }
  });

  it('matches the unbounded V1 schedule on dyadic infinite counts', () => {
    for (const [runtimeDirection, programDirection] of DIRECTIONS) {
      const track = referenceTrack(0.25, Infinity, 0.125, programDirection);
      for (const time of [0, 0.25, 0.375, 0.5, 10_000.125, Number.MAX_SAFE_INTEGER / 8]) {
        const expected = evaluateMotionProgramScheduleV1(track, time);
        expect(decode(repeatCursor(time, 0, 0.25, Infinity, 0.125, runtimeDirection)))
          .toEqual([expected.progress, expected.mirrored]);
      }
    }
  });

  it('matches V1 across a seeded finite schedule corpus', () => {
    let seed = 0x51ce_c001;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let i = 0; i < 2_000; i++) {
      const duration = 0.125 + random() * 8;
      const repeatDelay = random() < 0.4 ? 0 : random() * 3;
      const repeat = Math.floor(random() * 33);
      const [runtimeDirection, programDirection] = DIRECTIONS[Math.floor(random() * 3)]!;
      const total = repeat * (duration + repeatDelay) + duration;
      const time = random() * total;
      const expected = evaluateMotionProgramScheduleV1(
        referenceTrack(duration, repeat, repeatDelay, programDirection),
        time,
      );
      const actual = decode(repeatCursor(
        time,
        0,
        duration,
        repeat,
        repeatDelay,
        runtimeDirection,
      ));
      expect(actual[1], `case ${i}`).toBe(expected.mirrored);
      expect(actual[0], `case ${i}`).toBeCloseTo(expected.progress, 13);
    }
  });

  it('keeps the int32 terminal and distant exact boundaries V1-identical', () => {
    const duration = 1;
    const repeatDelay = 1;
    const repeat = INT32_MAX;
    const cycle = duration + repeatDelay;
    for (const [runtimeDirection, programDirection] of DIRECTIONS) {
      const track = referenceTrack(duration, repeat, repeatDelay, programDirection);
      for (const iteration of [1, 2, 0x4000_0000, repeat]) {
        const boundary = iteration * cycle;
        for (const time of [adjacentFloat(boundary, -1), boundary, adjacentFloat(boundary, 1)]) {
          const expected = evaluateMotionProgramScheduleV1(track, time);
          const actual = decode(repeatCursor(
            time,
            0,
            duration,
            repeat,
            repeatDelay,
            runtimeDirection,
          ));
          expect(actual[1]).toBe(expected.mirrored);
          expect(actual[0]).toBe(expected.progress);
        }
      }
      const terminal = repeat * cycle + duration;
      expect(decode(repeatCursor(
        terminal,
        0,
        duration,
        repeat,
        repeatDelay,
        runtimeDirection,
      ))).toEqual([
        evaluateMotionProgramScheduleV1(track, terminal).progress,
        evaluateMotionProgramScheduleV1(track, terminal).mirrored,
      ]);
    }
  });

  it('keeps preset delay on the same absolute V1 boundary law', () => {
    for (const repeatType of ['loop', 'reverse', 'mirror'] as const) {
      const runtimeDirection = repeatType === 'loop' ? 0 : repeatType === 'reverse' ? 1 : 2;
      const programDirection = repeatType === 'loop'
        ? MOTION_PROGRAM_DIRECTION_V1.normal
        : repeatType === 'reverse'
          ? MOTION_PROGRAM_DIRECTION_V1.alternate
          : MOTION_PROGRAM_DIRECTION_V1.mirror;
      const delay = 0.7;
      const duration = 1.3;
      const repeatDelay = 0.4;
      const repeat = 3;
      const preset = compilePreset({
        delay,
        duration,
        repeat,
        repeatDelay,
        repeatType,
        tracks: [{ property: 'x', values: [0, 100] }],
      });
      const track = [
        ...referenceTrack(duration, repeat, repeatDelay, programDirection),
      ] as unknown as MotionProgramTrackV1;
      (track as unknown as number[])[1] = delay;
      const cycle = duration + repeatDelay;
      const terminal = repeat * cycle + delay + duration;
      for (const time of [
        adjacentFloat(delay, -1),
        delay,
        delay + duration,
        delay + cycle,
        adjacentFloat(delay + cycle, 1),
        terminal,
      ]) {
        const expected = evaluateMotionProgramScheduleV1(track, time);
        const value = samplePreset(preset, time).x!;
        const expectedValue = expected.mirrored
          ? 100 * (1 - expected.progress)
          : 100 * expected.progress;
        expect(value, `${repeatType}@${time}/${runtimeDirection}`)
          .toBeCloseTo(expectedValue, 13);
      }
    }
  });

  it('publishes the next iteration at an intermediate boundary and closes only terminal', () => {
    const keyframeValues: number[] = [];
    const keyframeControls = keyframes({
      values: [0, 100],
      duration: 1,
      repeat: 1,
      requestFrame: frozenFrame,
      onStep: (value) => keyframeValues.push(value),
    });
    keyframeControls.pause();
    keyframeControls.seek(1);
    expect(keyframeValues.at(-1)).toBe(0);
    expect(keyframeControls.progress).toBe(0);
    keyframeControls.seek(2);
    expect(keyframeValues.at(-1)).toBe(100);
    expect(keyframeControls.progress).toBe(1);

    const preset = compilePreset({
      duration: 1,
      delay: 0.5,
      repeat: 1,
      tracks: [{ property: 'x', values: [0, 100] }],
    });
    expect(samplePreset(preset, 1.5).x).toBe(0);
    expect(samplePreset(preset, 2.5).x).toBe(100);

    const presetValues: number[] = [];
    const presetControls = runPreset(preset, {
      requestFrame: frozenFrame,
      onUpdate: (values) => presetValues.push(values.x!),
    });
    presetControls.pause();
    presetControls.seek(1.5);
    expect(presetValues.at(-1)).toBe(0);
    expect(presetControls.progress).toBe(0);
    presetControls.cancel();
    keyframeControls.cancel();
  });
});

describe('repeat runtime — portable count and absolute resolution boundary', () => {
  it('accepts only the V1 finite int32 domain plus public Infinity', () => {
    expect(isRepeatCount(INT32_MAX)).toBe(true);
    expect(isRepeatCount(Infinity)).toBe(true);
    expect(isRepeatCount(INT32_MAX + 1)).toBe(false);

    expect(() => keyframes({
      values: [0, 1],
      duration: 1,
      repeat: INT32_MAX + 1,
      requestFrame: frozenFrame,
    })).toThrowError(/^LM042$/);
    expect(() => compilePreset({
      duration: 1,
      repeat: INT32_MAX + 1,
      tracks: [{ property: 'x', values: [0, 1] }],
    })).toThrowError(/^LM060$/);
    expect(() => compileWaapi({
      property: 'x',
      values: [0, 1],
      duration: 1,
      repeat: INT32_MAX + 1,
    })).toThrowError(/^LM128$/);
  });

  it('rejects absolute schedules whose nominal phases are below the V1 resolution budget', () => {
    const start = 2 ** 60;
    expect(isRepeatScheduleRepresentable(start, 300, 1, 300)).toBe(false);
    expect(() => compilePreset({
      delay: start,
      duration: 300,
      repeat: 1,
      repeatDelay: 300,
      tracks: [{ property: 'x', values: [0, 100] }],
    })).toThrowError(/^LM161$/);

    expect(isRepeatScheduleRepresentable(0, 3e-7, INT32_MAX, 1)).toBe(false);
    expect(() => keyframes({
      values: [0, 1],
      duration: 3e-7,
      repeat: INT32_MAX,
      repeatDelay: 1,
      requestFrame: frozenFrame,
    })).toThrowError(/^LM161$/);
  });
});
