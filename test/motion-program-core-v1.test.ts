import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOTION_PROGRAM_CODEC_V1,
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  MOTION_PROGRAM_FEATURE_V1,
  MOTION_PROGRAM_LIMITS_V1,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1,
  MOTION_PROGRAM_STRING_SEMANTICS_V1,
  MotionProgramParseError,
  parseMotionProgramV1,
} from '../src/internal/motion-program.js';
import {
  FEATURE_MASK,
  expectIssue,
  minimalProgramInput,
  ownPath,
  validProgramInput,
} from './motion-program-v1.fixtures.js';

function ownDataGraphHasHostValue(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value)) return true;
  for (const key of Object.keys(value)) {
    if (ownDataGraphHasHostValue((value as unknown as Record<string, unknown>)[key], seen)) return true;
  }
  return false;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('MotionProgram V1 parser', () => {
  it('задаёт string identity точной UTF-8 последовательностью без Unicode-нормализации', () => {
    const input = minimalProgramInput();
    input[2] = ['é', 'e\u0301'];
    const parsed = parseMotionProgramV1(input);
    expect(parsed[2]).toEqual(['é', 'e\u0301']);
    expect(new TextEncoder().encode(parsed[2][0])).not.toEqual(new TextEncoder().encode(parsed[2][1]));
    expect(MOTION_PROGRAM_STRING_SEMANTICS_V1).toEqual({
      encoding: 'utf-8',
      identity: 'exact-scalar-sequence',
      normalization: 'none',
      canonicallyEquivalentSequencesMayDiffer: true,
    });
  });

  it('parse-don\'t-validate: копирует и глубоко замораживает чистый граф кортежей', () => {
    const input = validProgramInput();
    Object.defineProperty(input, 'host', { value: () => 'must not escape' });

    const parsed = parseMotionProgramV1(input);
    expect(parsed).not.toBe(input);
    expect(parsed[2]).not.toBe(input[2]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[5][0]![7])).toBe(true);
    expect(ownDataGraphHasHostValue(parsed)).toBe(false);

    (input[2] as string[])[0] = '--mutated-after-parse';
    expect(parsed[2][0]).toBe('--lab-x');
    expect(Object.is(ownPath(parsed, [3, 1, 2]), -0)).toBe(true);
    expect(Object.is(ownPath(parsed, [5, 0, 1]), -0)).toBe(true);
    expect(Object.is(ownPath(parsed, [5, 0, 7, 0, 3, 1, 1]), -0)).toBe(true);
  });

  it('принимает смежные segments и повторные curve offsets как явные скачки', () => {
    const parsed = parseMotionProgramV1(validProgramInput());
    expect(parsed[5][0]![7][0]![1]).toBe(0.5);
    expect(parsed[5][0]![7][1]![0]).toBe(0.5);
    expect(parsed[3][1]).toEqual([1, 0, -0, 0.5, 1, 0.5, 2, 1, 3]);
  });

  it('не вызывает геттеры и не проваливается из sparse-слотов в прототип', () => {
    const accessor = validProgramInput();
    let getterCalls = 0;
    Object.defineProperty(accessor[2] as unknown[], '0', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls++;
        return '--hostile';
      },
    });
    expectIssue(() => parseMotionProgramV1(accessor), 'LMP_SHAPE');
    expect(getterCalls).toBe(0);

    const sparse = validProgramInput();
    const strings = new Array<string>(2);
    let inheritedCalls = 0;
    Object.setPrototypeOf(strings, Object.create(Array.prototype, {
      0: { get: () => { inheritedCalls++; return '--inherited'; } },
    }));
    (strings as string[])[1] = 'red';
    sparse[2] = strings;
    expectIssue(() => parseMotionProgramV1(sparse), 'LMP_SHAPE');
    expect(inheritedCalls).toBe(0);
  });

  it('превращает бросающие proxy traps в стабильную ошибку без входного значения', () => {
    const input = validProgramInput();
    input[2] = new Proxy(input[2] as string[], {
      getOwnPropertyDescriptor() {
        throw new Error('secret from host');
      },
    });
    expectIssue(() => parseMotionProgramV1(input), 'LMP_SHAPE');

    const revokedInput = validProgramInput();
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    revokedInput[2] = revoked.proxy;
    expectIssue(() => parseMotionProgramV1(revokedInput), 'LMP_SHAPE');
  });

  it('отклоняет неизвестные version и feature bits до обхода таблиц', () => {
    const version = validProgramInput();
    version[0] = 2;
    const hostileVersionRoot = new Proxy(version, {
      getOwnPropertyDescriptor(target, key) {
        if (key === '2') throw new Error('table trap must stay unreachable');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expectIssue(() => parseMotionProgramV1(hostileVersionRoot), 'LMP_VERSION');

    const feature = validProgramInput();
    feature[1] = FEATURE_MASK | 0x10;
    const hostileFeatureRoot = new Proxy(feature, {
      getOwnPropertyDescriptor(target, key) {
        if (key === '2') throw new Error('table trap must stay unreachable');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expectIssue(() => parseMotionProgramV1(hostileFeatureRoot), 'LMP_FEATURE');
  });

  it('требует точного соответствия feature mask реально использованным формам', () => {
    const missing = validProgramInput();
    missing[1] = 0;
    expectIssue(() => parseMotionProgramV1(missing), 'LMP_FEATURE');

    const unused = minimalProgramInput();
    unused[1] = MOTION_PROGRAM_FEATURE_V1.currentValues;
    expectIssue(() => parseMotionProgramV1(unused), 'LMP_FEATURE');
  });

  it('проверяет конечность, целочисленные границы, repeat, direction и composite', () => {
    const cases: Array<[mutate: (input: unknown[]) => void, code: MotionProgramParseError['code']]> = [
      [(p) => {
        const expr = ((p[5] as unknown[][])[0]![7] as unknown[][])[1]![2] as unknown[];
        (expr[2] as unknown[])[1] = NaN;
      }, 'LMP_NUMBER'],
      [(p) => { (p[5] as unknown[][])[0]![2] = Infinity; }, 'LMP_NUMBER'],
      [(p) => { (p[5] as unknown[][])[0]![2] = -1; }, 'LMP_BOUNDS'],
      [(p) => { (p[5] as unknown[][])[0]![3] = -2; }, 'LMP_BOUNDS'],
      [(p) => { (p[5] as unknown[][])[0]![3] = -0; }, 'LMP_BOUNDS'],
      [(p) => { (p[5] as unknown[][])[0]![3] = 1.5; }, 'LMP_BOUNDS'],
      [(p) => {
        (p[5] as unknown[][])[0]![2] = Number.MAX_VALUE;
        (p[5] as unknown[][])[0]![3] = 1;
      }, 'LMP_BOUNDS'],
      [(p) => {
        (p[5] as unknown[][])[1]![1] = Number.MAX_VALUE;
        (p[5] as unknown[][])[1]![2] = Number.MAX_VALUE;
      }, 'LMP_BOUNDS'],
      [(p) => {
        (p[5] as unknown[][])[1]![2] = Number.MAX_VALUE;
        (p[5] as unknown[][])[1]![5] = Number.MAX_VALUE;
      }, 'LMP_BOUNDS'],
      [(p) => {
        (p[5] as unknown[][])[1]![2] = 0;
        (p[5] as unknown[][])[1]![5] = 0;
      }, 'LMP_BOUNDS'],
      [(p) => { (p[5] as unknown[][])[0]![4] = 5; }, 'LMP_BOUNDS'],
      [(p) => { (p[5] as unknown[][])[0]![6] = 3; }, 'LMP_BOUNDS'],
      [(p) => { (p[4] as unknown[][])[0]![0] = -0; }, 'LMP_BOUNDS'],
      [(p) => { (p[3] as unknown[])[1] = [1, 0, 0, 0.5, 1, 0.25, 2, 1, 3]; }, 'LMP_OFFSET'],
      [(p) => {
        (p[5] as unknown[][])[0]![1] = Number.MAX_VALUE;
        (p[5] as unknown[][])[0]![2] = 1;
      }, 'LMP_BOUNDS'],
      [(p) => {
        (p[5] as unknown[][])[0]![2] = 1;
        (p[5] as unknown[][])[0]![5] = Number.MIN_VALUE;
      }, 'LMP_BOUNDS'],
    ];
    for (const [mutate, code] of cases) {
      const input = validProgramInput();
      mutate(input);
      expectIssue(() => parseMotionProgramV1(input), code);
    }
    expect(parseMotionProgramV1(validProgramInput())[5][1]![3]).toBe(-1);
    const mirror = validProgramInput();
    (mirror[5] as unknown[][])[0]![4] = MOTION_PROGRAM_DIRECTION_V1.mirror;
    expect(parseMotionProgramV1(mirror)[5][0]![4]).toBe(MOTION_PROGRAM_DIRECTION_V1.mirror);

    for (const [repeat, repeatDelay] of [[1, 1], [7, 0]] as const) {
      const zeroDuration = minimalProgramInput();
      (zeroDuration[5] as unknown[][])[0]![2] = 0;
      (zeroDuration[5] as unknown[][])[0]![3] = repeat;
      (zeroDuration[5] as unknown[][])[0]![5] = repeatDelay;
      expect(() => parseMotionProgramV1(zeroDuration)).not.toThrow();
    }
  });

  it('проверяет все ссылки на таблицы и диапазон codec', () => {
    const cases: Array<(input: unknown[]) => void> = [
      (p) => { (p[4] as unknown[][])[1]![1] = [255, 2]; },
      (p) => { (p[5] as unknown[][])[0]![0] = 3; },
      (p) => { ((p[5] as unknown[][])[0]![7] as unknown[][])[0]![4] = 5; },
      (p) => { ((((p[5] as unknown[][])[1]![7] as unknown[][])[0]![2] as unknown[])[1] as unknown[])[1] = 2; },
    ];
    for (const mutate of cases) {
      const input = validProgramInput();
      mutate(input);
      expectIssue(() => parseMotionProgramV1(input), 'LMP_INDEX');
    }

    const codec = validProgramInput();
    ((codec[5] as unknown[][])[0]![7] as unknown[][])[0]![5] = 6;
    expectIssue(() => parseMotionProgramV1(codec), 'LMP_BOUNDS');
  });

  it('делает codec сегмента владельцем layout, диапазона и relative-политики', () => {
    const accepted: Array<[number, number | unknown[], unknown[], unknown[], number]> = [
      [MOTION_PROGRAM_CODEC_V1.scalar, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, [0, 0], [0, 1], 0],
      [MOTION_PROGRAM_CODEC_V1.colorGamma2, MOTION_PROGRAM_STANDARD_CHANNEL_V1.color,
        [1, 0, 0, 0, 0], [1, 255, 255, 255, 1], 0],
      [MOTION_PROGRAM_CODEC_V1.colorSrgb, MOTION_PROGRAM_STANDARD_CHANNEL_V1.backgroundColor,
        [1, 0, 10, 20, 0.25], [1, 255, 245, 235, 0.75], 0],
      [MOTION_PROGRAM_CODEC_V1.colorHslShortest, MOTION_PROGRAM_STANDARD_CHANNEL_V1.borderColor,
        [1, 350, 1, 0.5, 1], [1, 10, 0.5, 0.25, 0], 0],
      [MOTION_PROGRAM_CODEC_V1.discrete, [255, 0], [2, 0], [2, 1], MOTION_PROGRAM_FEATURE_V1.hostExtensions],
      [MOTION_PROGRAM_CODEC_V1.webCssOpaque, [255, 0], [2, 0], [2, 1], MOTION_PROGRAM_FEATURE_V1.hostExtensions],
    ];
    for (const [codec, channel, from, to, feature] of accepted) {
      expect(() => parseMotionProgramV1([
        1,
        feature,
        ['from', 'to'],
        [0],
        [[0, channel, 0]],
        [[0, 0, 1, 0, 0, 0, 0, [[0, 1, [1, from], [1, to], 0, codec]]]],
      ])).not.toThrow();
    }

    const wrongTag = validProgramInput();
    ((wrongTag[5] as unknown[][])[0]![7] as unknown[][])[0]![5] = MOTION_PROGRAM_CODEC_V1.colorGamma2;
    expectIssue(() => parseMotionProgramV1(wrongTag), 'LMP_CODEC');

    const wrongChannel = validProgramInput();
    (wrongChannel[4] as unknown[][])[2]![1] = MOTION_PROGRAM_STANDARD_CHANNEL_V1.value;
    expectIssue(() => parseMotionProgramV1(wrongChannel), 'LMP_CODEC');

    const colorRangeCases: Array<(vector: unknown[]) => void> = [
      (v) => { v[1] = -Number.MIN_VALUE; },
      (v) => { v[2] = 256; },
      (v) => { v[4] = 1 + Number.EPSILON; },
    ];
    for (const mutate of colorRangeCases) {
      const input = validProgramInput();
      const vector = ((((input[5] as unknown[][])[2]![7] as unknown[][])[0]![2] as unknown[])[1]) as unknown[];
      mutate(vector);
      expectIssue(() => parseMotionProgramV1(input), 'LMP_CODEC');
    }

    const hslCases: unknown[][] = [
      [1, -0, 1, 0.5, 1],
      [1, 360, 1, 0.5, 1],
      [1, 10, 1.1, 0.5, 1],
      [1, 10, 1, -0.1, 1],
    ];
    for (const value of hslCases) {
      expectIssue(() => parseMotionProgramV1([
        1, 0, [], [0],
        [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.color, 0]],
        [[0, 0, 1, 0, 0, 0, 0, [[
          0, 1, [1, value], [1, [1, 0, 1, 0.5, 1]], 0,
          MOTION_PROGRAM_CODEC_V1.colorHslShortest,
        ]]]],
      ]), 'LMP_CODEC');
    }

    const relativeColor = validProgramInput();
    const colorSegments = (relativeColor[5] as unknown[][])[2]![7] as unknown[][];
    colorSegments[0]![3] = [2, 1, [1, 1, 1, 1, 1]];
    expectIssue(() => parseMotionProgramV1(relativeColor), 'LMP_CODEC');

    const currentColor = validProgramInput();
    ((currentColor[5] as unknown[][])[2]![7] as unknown[][])[0]![2] = [0];
    expectIssue(() => parseMotionProgramV1(currentColor), 'LMP_CODEC');

    for (const magnitude of [-1, -0]) {
      const relativeScalar = minimalProgramInput();
      relativeScalar[1] = MOTION_PROGRAM_FEATURE_V1.relativeValues;
      const scalarSegments = (relativeScalar[5] as unknown[][])[0]![7] as unknown[][];
      scalarSegments[0]![3] = [2, 1, [0, magnitude]];
      expectIssue(() => parseMotionProgramV1(relativeScalar), 'LMP_CANONICAL');
    }

    expect(() => parseMotionProgramV1([
      1, 0, [], [0],
      [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.color, 0]],
      [[0, 0, 1, 1, MOTION_PROGRAM_DIRECTION_V1.alternate, 0, 0, [
        [
          0, 0.5,
          [1, [1, 350, 1, 0.5, 1]],
          [1, [1, 10, 0.5, 0.25, 1]],
          0, MOTION_PROGRAM_CODEC_V1.colorHslShortest,
        ],
        [
          0.5, 1,
          [1, [1, 255, 64, 32, 1]],
          [1, [1, 0, 0, 255, 1]],
          0, MOTION_PROGRAM_CODEC_V1.colorGamma2,
        ],
      ]]],
    ])).not.toThrow();
  });

  it('требует строго положительное непрерывное segment-покрытие [0,1]', () => {
    const mutations: Array<(segments: unknown[][]) => void> = [
      (segments) => { segments[0]![0] = 0.01; },
      (segments) => { segments[0]![1] = 0; },
      (segments) => { segments[1]![0] = 0.6; },
      (segments) => { segments[1]![0] = 0.4; },
      (segments) => { segments[1]![1] = 0.99; },
    ];
    for (const mutate of mutations) {
      const input = validProgramInput();
      mutate((input[5] as unknown[][])[0]![7] as unknown[][]);
      expectIssue(() => parseMotionProgramV1(input), 'LMP_OFFSET');
    }
  });

  it('отклоняет коллекцию сверх общего u16-бюджета до чтения слотов', () => {
    const input = validProgramInput();
    const huge: unknown[] = [];
    huge.length = MOTION_PROGRAM_LIMITS_V1.maxItems + 1;
    let reads = 0;
    Object.setPrototypeOf(huge, Object.create(Array.prototype, {
      0: { get: () => { reads++; return 'never'; } },
    }));
    input[2] = huge;
    expectIssue(() => parseMotionProgramV1(input), 'LMP_LIMIT');
    expect(reads).toBe(0);
  });

  it('применяет тот же бюджет до обхода вложенных векторов', () => {
    const input = validProgramInput();
    const vector: unknown[] = [1];
    vector.length = MOTION_PROGRAM_LIMITS_V1.maxItems + 1;
    let reads = 0;
    Object.setPrototypeOf(vector, Object.create(Array.prototype, {
      1: { get: () => { reads++; return 0; } },
    }));
    const expr = ((input[5] as unknown[][])[0]![7] as unknown[][])[1]![2] as unknown[];
    expr[2] = vector;
    expectIssue(() => parseMotionProgramV1(input), 'LMP_LIMIT');
    expect(reads).toBe(0);
  });

  it('требует уникальную и корректную каноническую Unicode-таблицу строк', () => {
    const duplicate = validProgramInput();
    duplicate[2] = ['same', 'same'];
    expectIssue(() => parseMotionProgramV1(duplicate), 'LMP_CANONICAL');

    const loneSurrogate = validProgramInput();
    loneSurrogate[2] = ['\ud800', 'red'];
    expectIssue(() => parseMotionProgramV1(loneSurrogate), 'LMP_SHAPE');

    const oversizedBeforeUnicodeScan = validProgramInput();
    oversizedBeforeUnicodeScan[2] = [
      'x'.repeat(MOTION_PROGRAM_LIMITS_V1.maxStringCodeUnits) + '\ud800',
      'red',
    ];
    expectIssue(() => parseMotionProgramV1(oversizedBeforeUnicodeScan), 'LMP_LIMIT');
  });

  it('отклоняет двух писателей одного subject/channel даже из разных ownerGroup', () => {
    const input = minimalProgramInput();
    (input[4] as unknown[][]).push([
      0,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.value,
      1,
    ]);
    const duplicateTrack = structuredClone((input[5] as unknown[][])[0]!);
    duplicateTrack[0] = 1;
    (input[5] as unknown[][]).push(duplicateTrack);
    expectIssue(() => parseMotionProgramV1(input), 'LMP_CANONICAL');
  });

  it('делает transform одним полным surface и не допускает двух owners', () => {
    const channels = [
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateX,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateY,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.scaleX,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.scaleY,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.rotate,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.skewX,
      MOTION_PROGRAM_STANDARD_CHANNEL_V1.skewY,
    ];
    const make = (rotateOwner = 3): unknown[] => [
      1,
      0,
      [],
      [0],
      channels.map((channel, index) => [0, channel, index === 4 ? rotateOwner : 3]),
      channels.map((_, index) => [
        index, 0, 1, 0, 0, 0, 0,
        [[0, 1, [1, [0, index === 2 || index === 3 ? 1 : 0]], [1, [0, 1]], 0, 0]],
      ]),
    ];
    expect(() => parseMotionProgramV1(make())).not.toThrow();
    expectIssue(() => parseMotionProgramV1(make(4)), 'LMP_CANONICAL');

    const partial = make();
    (partial[4] as unknown[][]).splice(1);
    (partial[5] as unknown[][]).splice(1);
    expectIssue(() => parseMotionProgramV1(partial), 'LMP_CANONICAL');
  });

  it('держит host API и бинарный кодек вне браузерного runtime-графа', () => {
    const runtimePath = new URL('../src/internal/motion-program.ts', import.meta.url);
    const runtimeSource = readFileSync(runtimePath, 'utf8');
    expect(runtimeSource).not.toMatch(
      /\b(?:AbortSignal|requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|performance\.now|Date\.now|TextEncoder|TextDecoder|DataView)\b/,
    );
    const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
    const accidentalImports = sourceFiles(srcRoot).filter((path) =>
      readFileSync(path, 'utf8').includes('motion-program-wire'),
    );
    expect(accidentalImports).toEqual([]);
  });
});
