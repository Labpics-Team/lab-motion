import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MOTION_PROGRAM_CHANNEL_SEMANTICS_V1,
  MOTION_PROGRAM_CODEC_V1,
  MOTION_PROGRAM_CODEC_SEMANTICS_V1,
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_COORDINATE_SEMANTICS_V1,
  MOTION_PROGRAM_CURVE_SEMANTICS_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  MOTION_PROGRAM_FEATURE_V1,
  MOTION_PROGRAM_HOST_EXTENSION_SEMANTICS_V1,
  MOTION_PROGRAM_LIMITS_V1,
  MOTION_PROGRAM_OWNERSHIP_SEMANTICS_V1,
  MOTION_PROGRAM_SCHEDULE_SEMANTICS_V1,
  MOTION_PROGRAM_SEGMENT_SEMANTICS_V1,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1,
  MOTION_PROGRAM_STRING_SEMANTICS_V1,
  MOTION_PROGRAM_TRANSFORM_ORDER_V1,
  MOTION_PROGRAM_TRANSFORM_SEMANTICS_V1,
  MotionProgramParseError,
  parseMotionProgramV1,
  type MotionProgramV1,
} from '../src/internal/motion-program.js';
import {
  MOTION_PROGRAM_MAX_WIRE_BYTES_V1,
  decodeMotionProgramV1,
  encodeMotionProgramV1,
} from '../scripts/motion-program-wire.js';
import {
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
  scheduleV1GreatestIterationAtOrBefore,
  SCHEDULE_V1_ITERATION_OUT_OF_RANGE,
} from '../src/internal/schedule-v1.js';
import { repeatCursor, type RepeatDirection } from '../src/internal/repeat-cursor.js';
import {
  compileSpringExecutionArtifactTupleUnchecked,
  DEFAULT_TOLERANCE,
} from '../src/compositor/curve.js';
import {
  adjacentFloat,
  bytesHex,
  expectIssue,
  hexBytes,
  minimalProgramInput,
  numberHex,
  ownPath,
  validProgramInput,
} from './motion-program-v1.fixtures.js';

const REQUIRED_VALID_WIRE_VECTOR_MANIFEST = [
  {
    name: 'structural-v1-forms',
    categories: ['wire-schema', 'little-endian', 'ieee754', 'tuple-forms'],
  },
  {
    name: 'unicode-canonical-equivalence-distinct-scalars',
    categories: ['string', 'utf8', 'unicode-scalar-identity'],
  },
  {
    name: 'utf8-leading-bom-preserved',
    categories: ['string', 'utf8', 'bom-preservation'],
  },
  { name: 'repeat-zero', categories: ['schedule', 'finite-repeat'] },
  { name: 'repeat-infinite', categories: ['schedule', 'infinite-repeat'] },
  { name: 'feature-current', categories: ['feature', 'current-values'] },
  { name: 'feature-relative', categories: ['feature', 'relative-values'] },
  {
    name: 'feature-host',
    categories: ['feature', 'host-extensions', 'string-index'],
  },
  { name: 'direction-mirror', categories: ['schedule', 'mirror-direction'] },
  { name: 'codec-colors', categories: ['codec', 'color'] },
  {
    name: 'mixed-codec-mirror',
    categories: ['codec', 'color', 'mirror-direction', 'segments'],
  },
  { name: 'steps-jump-none', categories: ['curve', 'sampled', 'steps-jump-none'] },
  { name: 'compiled-v0-spring', categories: ['curve', 'compiled-origin', 'spring'] },
] as const;

function replaceWireBytes(
  input: Uint8Array,
  start: number,
  deleteCount: number,
  replacement: Uint8Array,
): Uint8Array {
  const output = new Uint8Array(input.length - deleteCount + replacement.length);
  output.set(input.subarray(0, start));
  output.set(replacement, start);
  output.set(input.subarray(start + deleteCount), start + replacement.length);
  return output;
}

describe('MotionProgram V1 canonical wire', () => {
  it('детерминированно делает round-trip и сохраняет каждый IEEE-754 минус-ноль', () => {
    const parsed = parseMotionProgramV1(validProgramInput());
    const first = encodeMotionProgramV1(parsed);
    const second = encodeMotionProgramV1(parsed);
    expect([...second]).toEqual([...first]);

    const decoded = decodeMotionProgramV1(first);
    expect([...encodeMotionProgramV1(decoded)]).toEqual([...first]);
    expect(Object.is(ownPath(decoded, [3, 1, 2]), -0)).toBe(true);
    expect(Object.is(ownPath(decoded, [5, 0, 1]), -0)).toBe(true);
    expect(Object.is(ownPath(decoded, [5, 0, 7, 0, 3, 1, 1]), -0)).toBe(true);
  });

  it('отклоняет каждое усечение канонической программы', () => {
    const bytes = encodeMotionProgramV1(parseMotionProgramV1(validProgramInput()));
    for (let length = 0; length < bytes.length; length++) {
      expectIssue(() => decodeMotionProgramV1(bytes.subarray(0, length)), 'LMP_WIRE');
    }
  });

  it('отклоняет хвост, неверный UTF-8 и враждебные не-byte входы', () => {
    const bytes = encodeMotionProgramV1(parseMotionProgramV1(validProgramInput()));
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expectIssue(() => decodeMotionProgramV1(trailing), 'LMP_WIRE');

    const invalidUtf8 = bytes.slice();
    // Header занимает 18 байт; первая строка начинается с u32-длины.
    invalidUtf8[22] = 0xff;
    expectIssue(() => decodeMotionProgramV1(invalidUtf8), 'LMP_WIRE');
    expectIssue(() => decodeMotionProgramV1({ byteLength: 18 } as never), 'LMP_WIRE');
    expectIssue(() => decodeMotionProgramV1(new Proxy(bytes, {}) as never), 'LMP_WIRE');
    expectIssue(
      () => decodeMotionProgramV1(new Uint8Array(MOTION_PROGRAM_MAX_WIRE_BYTES_V1 + 1)),
      'LMP_WIRE',
    );
  });

  it('отклоняет wire выше физического ceiling до многомегабайтного snapshot', () => {
    const oversized = new Uint8Array(MOTION_PROGRAM_MAX_WIRE_BYTES_V1 + 1);
    const nativeUint8Array = Uint8Array;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array');
    expect(descriptor).toBeDefined();
    let allocations = 0;
    const countingUint8Array = new Proxy(nativeUint8Array, {
      construct(target, args) {
        allocations++;
        return Reflect.construct(target, args, target);
      },
    });
    let error: unknown;
    Object.defineProperty(globalThis, 'Uint8Array', {
      ...descriptor,
      value: countingUint8Array,
    });
    try {
      decodeMotionProgramV1(oversized);
    } catch (caught) {
      error = caught;
    } finally {
      Object.defineProperty(globalThis, 'Uint8Array', descriptor!);
    }

    expectIssue(() => { throw error; }, 'LMP_WIRE');
    expect(allocations).toBe(0);
  });

  it('принимает ровно maxItems декодированного графа без off-by-one', () => {
    const input = minimalProgramInput();
    const curves = input[3] as unknown[];
    // Budget = две curves + binding + track + segment + sampled points.
    // Последний segment списывает последний разрешённый item ровно в ноль.
    const fixedItems = 2 + 1 + 1 + 1;
    const pointCount = MOTION_PROGRAM_LIMITS_V1.maxItems - fixedItems;
    const sampled = new Array<unknown>(pointCount * 2 + 1);
    sampled[0] = 1;
    for (let point = 0; point < pointCount; point++) {
      const terminal = point === pointCount - 1;
      sampled[point * 2 + 1] = terminal ? 1 : 0;
      sampled[point * 2 + 2] = terminal ? 1 : 0;
    }
    curves.push(sampled);
    const segment = ((input[5] as unknown[][])[0]![7] as unknown[][])[0]!;
    segment[4] = 1;

    const decoded = decodeMotionProgramV1(
      encodeMotionProgramV1(parseMotionProgramV1(input)),
    );
    expect(decoded[3][1]).toHaveLength(pointCount * 2 + 1);
  });

  it('принимает ровно максимальный трёхбайтовый UTF-8 бюджет', () => {
    const value = '\u0800'.repeat(MOTION_PROGRAM_LIMITS_V1.maxStringCodeUnits);
    const encoded = new TextEncoder().encode(value);
    expect(encoded).toHaveLength(MOTION_PROGRAM_LIMITS_V1.maxStringCodeUnits * 3);
    const input = minimalProgramInput();
    input[2] = [value];

    const wire = encodeMotionProgramV1(parseMotionProgramV1(input));
    expect(decodeMotionProgramV1(wire)[2]).toEqual([value]);
  });

  it('сохраняет пустую UTF-8 строку через raw(0)', () => {
    const input = validProgramInput();
    (input[2] as unknown[])[0] = '';
    const wire = encodeMotionProgramV1(parseMotionProgramV1(input));
    // Сразу после 18-byte header идёт u32 длины первой строки.
    expect(new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(18, true))
      .toBe(0);
    expect(decodeMotionProgramV1(wire)[2][0]).toBe('');
  });

  it('не принимает non-Uint8 view даже со spoofed toStringTag', () => {
    const wire = encodeMotionProgramV1(parseMotionProgramV1(minimalProgramInput()));
    const signed = new Int8Array(wire.buffer, wire.byteOffset, wire.byteLength);
    Object.defineProperty(signed, Symbol.toStringTag, { value: 'Uint8Array' });
    expectIssue(() => decodeMotionProgramV1(signed as never), 'LMP_WIRE');
    expectIssue(
      () => decodeMotionProgramV1(
        new Uint8ClampedArray(wire.buffer, wire.byteOffset, wire.byteLength) as never,
      ),
      'LMP_WIRE',
    );
  });

  it('решает magic/version/features до враждебных collection counts', () => {
    const header = (version: number, features: number): Uint8Array => {
      const bytes = hexBytes('4c4d5000000000000000ffffffffffffffff');
      const view = new DataView(bytes.buffer);
      bytes[4] = version;
      view.setUint32(6, features, true);
      return bytes;
    };

    const wrongMagic = header(1, 0);
    wrongMagic[0] ^= 0xff;
    expectIssue(() => decodeMotionProgramV1(wrongMagic), 'LMP_WIRE');
    expectIssue(() => decodeMotionProgramV1(header(2, 0x8000_0000)), 'LMP_VERSION');
    expectIssue(() => decodeMotionProgramV1(header(1, 0x8000_0000)), 'LMP_FEATURE');
  });

  it('отклоняет неизвестные value-expression и encoded-value tags', () => {
    // header + linear curve + binding + track header + segment offsets.
    const fromExpressionOffset = 18 + 1 + 5 + 34 + 16;
    const relativeInput = minimalProgramInput();
    relativeInput[1] = MOTION_PROGRAM_FEATURE_V1.relativeValues;
    const relativeSegment = ((relativeInput[5] as unknown[][])[0]![7] as unknown[][])[0]!;
    relativeSegment[2] = [2, 1, [0, 0]];
    const relativeWire = encodeMotionProgramV1(parseMotionProgramV1(relativeInput));
    expect(relativeWire[fromExpressionOffset]).toBe(2);

    // Unknown tag сохраняет payload последней известной формы: мутант
    // «любой оставшийся tag = relative» принял бы программу без сдвига wire.
    const valueTag = relativeWire.slice();
    valueTag[fromExpressionOffset] = 3;
    expectIssue(() => decodeMotionProgramV1(valueTag), 'LMP_WIRE');

    const tokenInput = minimalProgramInput();
    tokenInput[1] = MOTION_PROGRAM_FEATURE_V1.hostExtensions;
    tokenInput[2] = ['--custom', 'token'];
    tokenInput[4] = [[0, [255, 0], 0]];
    const tokenSegment = ((tokenInput[5] as unknown[][])[0]![7] as unknown[][])[0]!;
    tokenSegment[2] = [1, [2, 1]];
    tokenSegment[3] = [1, [2, 1]];
    tokenSegment[5] = MOTION_PROGRAM_CODEC_V1.webCssOpaque;
    const tokenWire = encodeMotionProgramV1(parseMotionProgramV1(tokenInput));
    const stringBytes = (tokenInput[2] as string[]).reduce(
      (size, value) => size + 4 + new TextEncoder().encode(value).length,
      0,
    );
    const tokenExpressionOffset = 18 + stringBytes + 1 + 7 + 34 + 16;
    expect(tokenWire[tokenExpressionOffset]).toBe(1);
    expect(tokenWire[tokenExpressionOffset + 1]).toBe(2);
    const encodedTag = tokenWire.slice();
    encodedTag[tokenExpressionOffset + 1] = 3;
    expectIssue(() => decodeMotionProgramV1(encodedTag), 'LMP_WIRE');
  });

  it('классифицирует неизвестный curve tag как повреждение wire до shape-parser', () => {
    expectIssue(
      () => decodeMotionProgramV1(hexBytes('4c4d5000010000000000000001000000000002')),
      'LMP_WIRE',
    );
  });

  it('не выпускает RangeError из нулевых и дробных preallocation-размеров', () => {
    const canonical = encodeMotionProgramV1(
      parseMotionProgramV1(minimalProgramInput()),
    );
    // header + linear curve + binding + track header + segment offsets + absolute tag.
    const encodedValueOffset = 18 + 1 + 5 + 34 + 16 + 1;
    const emptyVector = replaceWireBytes(
      canonical,
      encodedValueOffset,
      9,
      Uint8Array.of(1, 0, 0),
    );
    const emptySampledCurve = replaceWireBytes(
      canonical,
      18,
      1,
      Uint8Array.of(1, 0, 0),
    );
    const onePointSampledCurve = replaceWireBytes(
      canonical,
      18,
      1,
      Uint8Array.of(1, 1, 0, ...new Uint8Array(16)),
    );

    expectIssue(() => decodeMotionProgramV1(emptyVector), 'LMP_SHAPE');
    expectIssue(() => decodeMotionProgramV1(emptySampledCurve), 'LMP_SHAPE');
    expectIssue(() => decodeMotionProgramV1(onePointSampledCurve), 'LMP_SHAPE');
  });

  it('отличает исчерпание смысловых лимитов от повреждения wire', () => {
    expectIssue(
      () => decodeMotionProgramV1(hexBytes(
        '4c4d5000010000000000ffff010000000000',
      )),
      'LMP_LIMIT',
    );
    expectIssue(
      () => decodeMotionProgramV1(hexBytes(
        '4c4d50000100000000000100000000000000feff0200',
      )),
      'LMP_LIMIT',
    );
  });

  it('делает round-trip детерминированного property-корпуса без нормализации', () => {
    let state = 0x7f4a_7c15;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 128; sample++) {
      const input = validProgramInput();
      const segments = (input[5] as unknown[][])[0]![7] as unknown[][];
      const value = (random() - 0.5) * Number.MAX_VALUE;
      ((segments[0]![3] as unknown[])[1] as unknown[])[1] = sample % 7 === 0 ? -0 : value;
      (input[5] as unknown[][])[0]![1] = sample % 11 === 0 ? -0 : random() * 10_000;
      const parsed = parseMotionProgramV1(input);
      const wire = encodeMotionProgramV1(parsed);
      expect([...encodeMotionProgramV1(decodeMotionProgramV1(wire))]).toEqual([...wire]);
    }
  });

  it('точно делает round-trip произвольных конечных binary64-паттернов', () => {
    const edgeValues = [
      0,
      -0,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.EPSILON,
      -Number.EPSILON,
    ];
    let state = 0x243f_6a88;
    const bits = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 256; i++) {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      bits.setUint32(0, state, true);
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      bits.setUint32(4, state, true);
      const value = bits.getFloat64(0, true);
      if (Number.isFinite(value)) edgeValues.push(value);
    }

    for (const value of edgeValues) {
      const input = validProgramInput();
      const expr = ((input[5] as unknown[][])[0]![7] as unknown[][])[0]![3] as unknown[];
      (expr[1] as unknown[])[1] = value;
      const decoded = decodeMotionProgramV1(
        encodeMotionProgramV1(parseMotionProgramV1(input)),
      );
      expect(numberHex(ownPath(decoded, [5, 0, 7, 0, 3, 1, 1]) as number))
        .toBe(numberHex(value));
    }
  });

  it('пинит независимый от языка valid/malformed native conformance-корпус', () => {
    type Corpus = {
      format: string;
      version: number;
      endianness: string;
      canonicality: string;
      limits: typeof MOTION_PROGRAM_LIMITS_V1;
      coverageCounts: {
        validWireVectors: number;
        invalidWireVectors: number;
        invalidProgramVectors: number;
        semanticValueVectors: number;
        semanticScheduleCaseVectors: number;
        semanticMirrorSegmentVectors: number;
        generatedLimitVectors: number;
      };
      stringSemantics: typeof MOTION_PROGRAM_STRING_SEMANTICS_V1;
      registry: {
        features: Record<string, number>;
        channels: Record<string, number>;
        codecs: Record<string, number>;
        directions: Record<string, number>;
        composites: Record<string, number>;
      };
      channelSemantics: typeof MOTION_PROGRAM_CHANNEL_SEMANTICS_V1;
      transformOrder: number[];
      transformSemantics: typeof MOTION_PROGRAM_TRANSFORM_SEMANTICS_V1;
      coordinateSemantics: typeof MOTION_PROGRAM_COORDINATE_SEMANTICS_V1;
      codecSemantics: typeof MOTION_PROGRAM_CODEC_SEMANTICS_V1;
      curveSemantics: typeof MOTION_PROGRAM_CURVE_SEMANTICS_V1;
      segmentSemantics: typeof MOTION_PROGRAM_SEGMENT_SEMANTICS_V1;
      ownershipSemantics: typeof MOTION_PROGRAM_OWNERSHIP_SEMANTICS_V1;
      hostExtensions: Record<string, string | boolean>;
      scheduleSemantics: typeof MOTION_PROGRAM_SCHEDULE_SEMANTICS_V1;
      valueResolution: Record<string, string | boolean>;
      semanticProbes: {
        curves: Array<{
          source: string;
          curveIndex: number;
          probes: Array<{ progress: number; value: number }>;
        }>;
        values: Array<{
          name?: string;
          codec: number;
          from: number[];
          to: number[];
          progress: number;
          result?: number[];
          signedHueDeltaDegrees?: 180 | -180;
          resultNumberBits?: Array<{
            componentIndex: number;
            ieee754LittleEndianHex: string;
          }>;
          formatted?: string;
          issue?: MotionProgramParseError['code'];
        }>;
        presentation: Array<{ channel: number; value: number; result: number }>;
        schedules: Array<{
          source: string;
          trackIndex: number;
          probes: Array<{
            boundary?: 'start' | 'motion-end-0' | 'iteration-start-1' | 'terminal';
            relation?: 'previous-f64' | 'exact' | 'next-f64';
            timeMs: number;
            timeMsIeee754LittleEndianHex?: string;
            state: 'before' | 'motion' | 'repeatDelay' | 'terminal' | 'after';
            iteration: number | null;
            iterationParity: 0 | 1;
            progress: number;
            mirrored: boolean;
          }>;
        }>;
        trackValues: Array<{
          source: string;
          trackIndex: number;
          bindingBaseline: number[];
          probes: Array<{ timeMs: number; result: number[] }>;
        }>;
        resolutions: Array<{
          name: string;
          features: number;
          segments: unknown[][];
          bindingSnapshot?: number[];
          result?: number[][][];
          issue?: MotionProgramParseError['code'];
        }>;
        transforms: Array<{
          name: string;
          input: {
            translateX: number;
            translateY: number;
            scaleX: number;
            scaleY: number;
            rotate: number;
            skewX: number;
            skewY: number;
          };
          matrix: number[];
          yUpPresentation: {
            translateX: number;
            translateY: number;
            scaleX: number;
            scaleY: number;
            rotate: number;
            skewX: number;
            skewY: number;
          };
          yUpMatrix: number[];
          comparison: {
            kind: 'absolute';
            tolerance: number;
            provenance: string;
          };
        }>;
        transformTotality: Array<{
          name: string;
          input: {
            translateX: number;
            translateY: number;
            scaleX: number;
            scaleY: number;
            rotate: number;
            skewX: number;
            skewY: number;
          };
          expected: {
            reducedDegrees: {
              rotate: number;
              skewX: number;
              skewY: number;
            };
            allFinite: true;
            componentSigns: Array<'negative' | 'positive' | 'negative-zero' | 'positive-zero'>;
            saturatedComponents?: Array<{
              component: number;
              sign: -1 | 1;
              magnitude: 'f64-greatest-finite';
              ieee754LittleEndianHex: string;
            }>;
          };
        }>;
        scheduleCases: Array<{
          name: string;
          track: {
            startMs: number;
            durationMs: number;
            repeat: number;
            direction: number;
            repeatDelayMs: number;
          };
          probes: Array<{
            boundary?: 'start' | 'motion-end-0' | 'iteration-start-1' | 'terminal';
            relation?: 'previous-f64' | 'exact' | 'next-f64';
            timeMs: number;
            timeMsIeee754LittleEndianHex?: string;
            state: 'before' | 'motion' | 'repeatDelay' | 'terminal' | 'after';
            iteration: number | null;
            iterationParity: 0 | 1;
            progress: number;
            mirrored: boolean;
          }>;
        }>;
        rejectedSchedules: Array<{
          name: string;
          track: {
            startMs: number;
            durationMs: number;
            repeat: -1;
            direction: number;
            consumerDirection: RepeatDirection;
            repeatDelayMs: number;
          };
          probes: Array<{
            relation: 'last-supported' | 'horizon' | 'next-f64';
            timeMs: number;
            timeMsIeee754LittleEndianHex: string;
            generatorIteration: number;
            sample?: {
              state: 'before' | 'motion' | 'repeatDelay' | 'terminal' | 'after';
              iteration: number | null;
              iterationParity: 0 | 1;
              progress: number;
              mirrored: boolean;
            };
            referenceIssue?: MotionProgramParseError['code'];
            consumerIssue?: 'LM166';
            consumerCursor?: number;
          }>;
        }>;
        mirrorSegments: Array<{
          name: string;
          channel?: number;
          curves: unknown[];
          segments: unknown[][];
          probes: Array<{
            progress: number;
            progressIeee754LittleEndianHex: string;
            result: number[];
          }>;
        }>;
        ownership: Array<{
          name: string;
          program: unknown[];
          subjectIdentities: number[];
          expected: {
            issue?: MotionProgramParseError['code'];
            snapshotIdentities?: number[];
            frozen?: boolean;
            captureCalls: number;
            writeCalls: number;
            events: string[];
          };
        }>;
      };
      compiledOrigins: Array<{
        source: string;
        curveIndex: number;
        kind: 'spring';
        generator: string;
        generatorVersion: number;
        verification: 'exact-regeneration';
        mass: number;
        stiffness: number;
        damping: number;
        v0: number;
        compilerTolerance: number;
        durationMs: number;
      }>;
      valid: Array<{
        name: string;
        categories: string[];
        program: unknown[];
        wireHex: string;
        probes?: Array<{ path: number[]; ieee754LittleEndianHex: string }>;
        stringProbes?: Array<{
          index: number;
          utf8Hex: string;
          unicodeScalarsHex: string[];
          canonicalEquivalenceGroup?: string;
        }>;
      }>;
      invalid: Array<{
        name: string;
        wireHex?: string;
        issue: MotionProgramParseError['code'];
        invariant?:
          | 'all-seven-standard-transform-components-required'
          | 'duplicate-subject-channel-writer-forbidden'
          | 'one-owner-per-subject-surface'
          | 'finite-last-motion-duration-representable'
          | 'finite-duration-representable-at-start-magnitude'
          | 'finite-repeat-delay-representable-at-start-magnitude'
          | 'finite-interior-boundaries-strictly-increasing'
          | 'finite-repeat-cycle-product-finite';
        program?: unknown[];
      }>;
      limitRecipes: {
        generator: 'concat-repeated-scalars-at-program-path';
        generatorVersion: 1;
        limit: keyof typeof MOTION_PROGRAM_LIMITS_V1;
        countingUnit: 'utf16-code-units';
        targetPath: number[];
        baseProgram: unknown[];
        cases: Array<{
          name: string;
          components: Array<{
            scalar: string;
            utf8Hex: string;
            unicodeScalarsHex: string[];
            utf16CodeUnits: number;
            repeat: number;
          }>;
          expected: {
            utf16CodeUnits: number;
            parse: 'valid' | 'invalid';
            issue?: MotionProgramParseError['code'];
          };
        }>;
      };
    };
    const corpus = JSON.parse(readFileSync(
      new URL('../conformance/motion-program-v1.json', import.meta.url),
      'utf8',
    )) as Corpus;
    expect(corpus.format).toBe('lab-motion-program-conformance');
    expect(corpus.version).toBe(1);
    expect(corpus.endianness).toBe('little');
    expect(corpus.canonicality).toBe('tuple-graph');
    expect(corpus.limits).toEqual(MOTION_PROGRAM_LIMITS_V1);
    expect(corpus.coverageCounts).toEqual({
      validWireVectors: corpus.valid.length,
      invalidWireVectors: corpus.invalid.filter((vector) => vector.wireHex !== undefined).length,
      invalidProgramVectors: corpus.invalid.filter((vector) => vector.program !== undefined).length,
      semanticValueVectors: corpus.semanticProbes.values.length,
      semanticScheduleCaseVectors: corpus.semanticProbes.scheduleCases.length,
      semanticRejectedScheduleVectors: corpus.semanticProbes.rejectedSchedules.length,
      semanticMirrorSegmentVectors: corpus.semanticProbes.mirrorSegments.length,
      generatedLimitVectors: corpus.limitRecipes.cases.length,
    });
    expect(corpus.stringSemantics).toEqual(MOTION_PROGRAM_STRING_SEMANTICS_V1);
    expect(corpus.registry.features).toEqual(MOTION_PROGRAM_FEATURE_V1);
    expect(corpus.registry.channels).toEqual(MOTION_PROGRAM_STANDARD_CHANNEL_V1);
    expect(corpus.registry.codecs).toEqual(MOTION_PROGRAM_CODEC_V1);
    expect(corpus.registry.directions).toEqual(MOTION_PROGRAM_DIRECTION_V1);
    expect(corpus.registry.composites).toEqual(MOTION_PROGRAM_COMPOSITE_V1);
    expect(corpus.channelSemantics).toEqual(MOTION_PROGRAM_CHANNEL_SEMANTICS_V1);
    expect(corpus.transformOrder).toEqual(MOTION_PROGRAM_TRANSFORM_ORDER_V1);
    expect(corpus.transformSemantics).toEqual(MOTION_PROGRAM_TRANSFORM_SEMANTICS_V1);
    expect(corpus.coordinateSemantics).toEqual(MOTION_PROGRAM_COORDINATE_SEMANTICS_V1);
    expect(corpus.codecSemantics).toEqual(MOTION_PROGRAM_CODEC_SEMANTICS_V1);
    expect(corpus.curveSemantics).toEqual(MOTION_PROGRAM_CURVE_SEMANTICS_V1);
    expect(corpus.segmentSemantics).toEqual(MOTION_PROGRAM_SEGMENT_SEMANTICS_V1);
    expect(corpus.ownershipSemantics).toEqual(MOTION_PROGRAM_OWNERSHIP_SEMANTICS_V1);
    expect(corpus.hostExtensions).toEqual(MOTION_PROGRAM_HOST_EXTENSION_SEMANTICS_V1);
    expect(corpus.scheduleSemantics).toEqual(MOTION_PROGRAM_SCHEDULE_SEMANTICS_V1);
    expect(corpus.valueResolution).toEqual({
      capture: 'once-before-first-host-write',
      firstCurrent: 'binding-snapshot',
      laterCurrent: 'previous-resolved-frame',
      firstRelativeBase: 'binding-snapshot',
      laterRelativeBase: 'previous-resolved-frame',
      relativeMagnitude: 'nonnegative-and-not-negative-zero',
      repeatRecaptures: false,
      mirrorRecaptures: false,
      mirrorEasing: 'forward-after-endpoint-swap',
    });
    expect(corpus.valid.map(({ name, categories }) => ({ name, categories })))
      .toEqual(REQUIRED_VALID_WIRE_VECTOR_MANIFEST);
    const decodedSource = new Map<string, MotionProgramV1>();
    for (const vector of corpus.valid) {
      const bytes = hexBytes(vector.wireHex);
      const decoded = decodeMotionProgramV1(bytes);
      expect(decoded).toEqual(vector.program);
      expect(bytesHex(encodeMotionProgramV1(decoded))).toBe(vector.wireHex);
      for (const probe of vector.probes ?? []) {
        expect(numberHex(ownPath(decoded, probe.path) as number))
          .toBe(probe.ieee754LittleEndianHex);
      }
      for (const probe of vector.stringProbes ?? []) {
        const value = decoded[2][probe.index];
        expect(value).toBeDefined();
        expect(bytesHex(new TextEncoder().encode(value))).toBe(probe.utf8Hex);
        expect(Array.from(value!, (scalar) =>
          scalar.codePointAt(0)!.toString(16).padStart(4, '0')))
          .toEqual(probe.unicodeScalarsHex);
      }
      const equivalenceGroups = new Map<string, string[]>();
      for (const probe of vector.stringProbes ?? []) {
        if (probe.canonicalEquivalenceGroup === undefined) continue;
        const values = equivalenceGroups.get(probe.canonicalEquivalenceGroup) ?? [];
        values.push(decoded[2][probe.index]!);
        equivalenceGroups.set(probe.canonicalEquivalenceGroup, values);
      }
      for (const values of equivalenceGroups.values()) {
        expect(new Set(values).size).toBe(values.length);
        expect(new Set(values.map((value) => value.normalize('NFC'))).size).toBe(1);
      }
      decodedSource.set(vector.name, decoded);
    }
    expect(decodedSource.has('unicode-canonical-equivalence-distinct-scalars')).toBe(true);
    expect(decodedSource.has('utf8-leading-bom-preserved')).toBe(true);
    const structural = corpus.valid.find((vector) => vector.name === 'structural-v1-forms');
    expect(structural).toBeDefined();
    expect(bytesHex(encodeMotionProgramV1(parseMotionProgramV1(validProgramInput()))))
      .toBe(structural!.wireHex);

    for (const probe of corpus.semanticProbes.curves) {
      const program = decodedSource.get(probe.source);
      expect(program).toBeDefined();
      const curve = program![3][probe.curveIndex];
      expect(curve).toBeDefined();
      for (const point of probe.probes) {
        expect(evaluateMotionProgramCurveV1(curve!, point.progress)).toBe(point.value);
      }
    }
    for (const probe of corpus.semanticProbes.values) {
      const run = (): ReturnType<typeof interpolateMotionProgramValueV1> =>
        interpolateMotionProgramValueV1(
          probe.codec as never,
          probe.from as never,
          probe.to as never,
          probe.progress,
        );
      if (probe.issue !== undefined) {
        expectIssue(run, probe.issue);
        continue;
      }
      const result = run();
      expect(result).toEqual(probe.result);
      if (probe.signedHueDeltaDegrees !== undefined) {
        expect(probe.to[1]! - probe.from[1]!).toBe(probe.signedHueDeltaDegrees);
      }
      for (const bitProbe of probe.resultNumberBits ?? []) {
        expect(numberHex(result[bitProbe.componentIndex]!))
          .toBe(bitProbe.ieee754LittleEndianHex);
      }
      if (probe.formatted !== undefined) {
        expect(formatMotionProgramColorV1(probe.codec as never, result)).toBe(probe.formatted);
      }
    }
    expect(corpus.semanticProbes.values.map((probe) => probe.name)).toEqual(expect.arrayContaining([
      'scalar-affine-weighted-binary64-order',
      'hsl-shortest-positive-180-tie',
      'hsl-shortest-negative-180-tie',
    ]));
    for (const probe of corpus.semanticProbes.presentation) {
      expect(presentMotionProgramScalarV1(probe.channel as never, probe.value)).toBe(probe.result);
    }
    for (const vector of corpus.semanticProbes.schedules) {
      const program = decodedSource.get(vector.source);
      expect(program).toBeDefined();
      const track = program![5][vector.trackIndex];
      expect(track).toBeDefined();
      for (const { timeMs, ...expected } of vector.probes) {
        expect(evaluateMotionProgramScheduleV1(track!, timeMs)).toEqual(expected);
      }
    }
    for (const vector of corpus.semanticProbes.trackValues) {
      const program = decodedSource.get(vector.source);
      expect(program).toBeDefined();
      const track = program![5][vector.trackIndex];
      expect(track).toBeDefined();
      const resolved = resolveMotionProgramSegmentsV1(track![7]);
      for (const probe of vector.probes) {
        expect(presentMotionProgramTrackValueV1(
          track![7],
          resolved,
          program![3],
          evaluateMotionProgramScheduleV1(track!, probe.timeMs),
          vector.bindingBaseline as never,
        )).toEqual(probe.result);
      }
    }
    for (const vector of corpus.semanticProbes.resolutions) {
      const program = parseMotionProgramV1([
        1,
        vector.features,
        [],
        [0],
        [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
        [[
          0, 0, 1, 0,
          MOTION_PROGRAM_DIRECTION_V1.normal,
          0,
          MOTION_PROGRAM_COMPOSITE_V1.replace,
          vector.segments,
        ]],
      ]);
      const run = (): ReturnType<typeof resolveMotionProgramSegmentsV1> =>
        resolveMotionProgramSegmentsV1(
          program[5][0]![7],
          vector.bindingSnapshot as never,
        );
      if (vector.issue !== undefined) {
        expectIssue(run, vector.issue);
      } else {
        expect(run()).toEqual(vector.result);
      }
    }
    for (const vector of corpus.semanticProbes.transforms) {
      const yUpPresentation = {
        ...vector.input,
        translateY: -vector.input.translateY,
        rotate: -vector.input.rotate,
        skewX: -vector.input.skewX,
        skewY: -vector.input.skewY,
      };
      expect(yUpPresentation).toEqual(vector.yUpPresentation);
      expect(vector.comparison).toMatchObject({
        kind: 'absolute',
        provenance: 'cross-language-libm-roundoff-for-bounded-trigonometric-probe',
      });
      const actualMatrices = [
        composeMotionProgramTransform2DV1(vector.input),
        composeMotionProgramTransform2DV1(yUpPresentation),
      ];
      const expectedMatrices = [vector.matrix, vector.yUpMatrix];
      for (let matrixIndex = 0; matrixIndex < actualMatrices.length; matrixIndex++) {
        const actual = actualMatrices[matrixIndex]!;
        const expected = expectedMatrices[matrixIndex]!;
        expect(actual).toHaveLength(expected.length);
        for (let component = 0; component < actual.length; component++) {
          expect(Math.abs(actual[component]! - expected[component]!))
            .toBeLessThanOrEqual(vector.comparison.tolerance);
        }
      }
    }
    for (const vector of corpus.semanticProbes.transformTotality) {
      const reduce = (degrees: number, period: 180 | 360): number => {
        const half = period / 2;
        if (degrees >= -half && degrees < half) return degrees;
        let reduced = degrees % period;
        if (reduced >= half) reduced -= period;
        else if (reduced < -half) reduced += period;
        return reduced;
      };
      expect({
        rotate: reduce(vector.input.rotate, 360),
        skewX: reduce(vector.input.skewX, 180),
        skewY: reduce(vector.input.skewY, 180),
      }).toEqual(vector.expected.reducedDegrees);
      const matrix = composeMotionProgramTransform2DV1(vector.input);
      expect(matrix.every(Number.isFinite)).toBe(vector.expected.allFinite);
      expect(matrix.map((component) => {
        if (component === 0) return Object.is(component, -0) ? 'negative-zero' : 'positive-zero';
        return component < 0 ? 'negative' : 'positive';
      })).toEqual(vector.expected.componentSigns);
      for (const saturated of vector.expected.saturatedComponents ?? []) {
        expect(matrix[saturated.component])
          .toBe(saturated.sign * Number.MAX_VALUE);
        expect(numberHex(matrix[saturated.component]!))
          .toBe(saturated.ieee754LittleEndianHex);
      }
    }
    const representabilityNames = [
      'finite-decimal-positive-start-boundaries',
      'finite-decimal-negative-start-boundaries',
      'finite-huge-positive-start-boundaries',
      'finite-huge-negative-start-boundaries',
    ];
    for (const name of representabilityNames) {
      const vector = corpus.semanticProbes.scheduleCases.find((candidate) => candidate.name === name);
      expect(vector).toBeDefined();
      expect(vector!.probes.length).toBeGreaterThan(0);
      const probes = vector!.probes;
      const boundaryGroups = new Map<string, typeof probes>();
      for (const probe of probes) {
        expect(probe.boundary).toBeDefined();
        expect(probe.relation).toBeDefined();
        expect(probe.timeMsIeee754LittleEndianHex).toMatch(/^[0-9a-f]{16}$/);
        const group = boundaryGroups.get(probe.boundary!) ?? [];
        group.push(probe);
        boundaryGroups.set(probe.boundary!, group);
      }
      for (const group of boundaryGroups.values()) {
        expect(group.map((probe) => probe.relation).sort()).toEqual([
          'exact',
          'next-f64',
          'previous-f64',
        ]);
        const exact = group.find((probe) => probe.relation === 'exact')!;
        expect(group.find((probe) => probe.relation === 'previous-f64')!.timeMs)
          .toBe(adjacentFloat(exact.timeMs, -1));
        expect(group.find((probe) => probe.relation === 'next-f64')!.timeMs)
          .toBe(adjacentFloat(exact.timeMs, 1));
      }
    }
    expect(corpus.semanticProbes.scheduleCases.some((candidate) =>
      candidate.name === 'finite-nextdown-binade-gap-accepted'))
      .toBe(true);
    for (const vector of corpus.semanticProbes.scheduleCases) {
      const input = minimalProgramInput();
      const rawTrack = (input[5] as unknown[][])[0]!;
      rawTrack[1] = vector.track.startMs;
      rawTrack[2] = vector.track.durationMs;
      rawTrack[3] = vector.track.repeat;
      rawTrack[4] = vector.track.direction;
      rawTrack[5] = vector.track.repeatDelayMs;
      const track = parseMotionProgramV1(input)[5][0]!;
      for (const { timeMs, ...expected } of vector.probes) {
        const {
          boundary: _boundary,
          relation: _relation,
          timeMsIeee754LittleEndianHex,
          ...sample
        } = expected;
        if (timeMsIeee754LittleEndianHex !== undefined) {
          expect(numberHex(timeMs)).toBe(timeMsIeee754LittleEndianHex);
        }
        expect(evaluateMotionProgramScheduleV1(track as never, timeMs))
          .toEqual(sample);
      }
    }
    expect(corpus.semanticProbes.rejectedSchedules.map((vector) => vector.name))
      .toContain('infinite-exact-index-horizon');
    for (const vector of corpus.semanticProbes.rejectedSchedules) {
      const input = minimalProgramInput();
      const rawTrack = (input[5] as unknown[][])[0]!;
      rawTrack[1] = vector.track.startMs;
      rawTrack[2] = vector.track.durationMs;
      rawTrack[3] = vector.track.repeat;
      rawTrack[4] = vector.track.direction;
      rawTrack[5] = vector.track.repeatDelayMs;
      const track = parseMotionProgramV1(input)[5][0]!;
      const cycle = vector.track.durationMs + vector.track.repeatDelayMs;
      for (const probe of vector.probes) {
        expect(numberHex(probe.timeMs)).toBe(probe.timeMsIeee754LittleEndianHex);
        expect(scheduleV1GreatestIterationAtOrBefore(
          vector.track.startMs,
          cycle,
          vector.track.repeat,
          probe.timeMs,
        )).toBe(probe.generatorIteration);
        if (probe.referenceIssue !== undefined) {
          expect(probe.generatorIteration).toBe(SCHEDULE_V1_ITERATION_OUT_OF_RANGE);
          expectIssue(
            () => evaluateMotionProgramScheduleV1(track, probe.timeMs),
            probe.referenceIssue,
          );
        } else {
          expect(evaluateMotionProgramScheduleV1(track, probe.timeMs))
            .toEqual(probe.sample);
        }
        const consume = (): number => repeatCursor(
          probe.timeMs,
          vector.track.startMs,
          vector.track.durationMs,
          Infinity,
          vector.track.repeatDelayMs,
          vector.track.consumerDirection,
        );
        if (probe.consumerIssue !== undefined) {
          expect(consume).toThrowError(new RegExp(`^${probe.consumerIssue}$`));
        } else {
          expect(consume()).toBe(probe.consumerCursor);
        }
      }
    }
    expect(corpus.semanticProbes.mirrorSegments.map((vector) => vector.name))
      .toEqual(expect.arrayContaining([
        'mirror-min-positive-offset-total',
        'mirror-nonuniform-forward-easing-matrix',
        'mirror-exact-heterogeneous-endpoints-before-curve',
      ]));
    for (const vector of corpus.semanticProbes.mirrorSegments) {
      const input = minimalProgramInput();
      input[3] = vector.curves;
      if (vector.channel !== undefined) (input[4] as unknown[][])[0]![1] = vector.channel;
      (input[5] as unknown[][])[0]![7] = vector.segments;
      const program = parseMotionProgramV1(input);
      const segments = program[5][0]![7];
      const resolved = resolveMotionProgramSegmentsV1(segments);
      for (const probe of vector.probes) {
        expect(numberHex(probe.progress)).toBe(probe.progressIeee754LittleEndianHex);
        expect(evaluateMotionProgramSegmentsV1(
          segments,
          resolved,
          program[3],
          {
            state: 'motion',
            iteration: null,
            iterationParity: 1,
            progress: probe.progress,
            mirrored: true,
          },
        )).toEqual(probe.result);
      }
    }
    for (const vector of corpus.semanticProbes.ownership) {
      const program = parseMotionProgramV1(vector.program);
      const identities = new Map<number, object>();
      const subjects = vector.subjectIdentities.map((identity) => {
        let subject = identities.get(identity);
        if (subject === undefined) {
          subject = Object.freeze({ identity });
          identities.set(identity, subject);
        }
        return subject;
      });
      let captureCalls = 0;
      let writeCalls = 0;
      const events: string[] = [];
      const bind = (): readonly unknown[] => {
        const snapshot = snapshotInjectiveMotionProgramSubjectsV1(program, subjects);
        events.push('snapshot');
        for (const binding of program[4]) {
          void snapshot[binding[0]];
          captureCalls++;
          events.push(`capture:${binding[0]}`);
        }
        writeCalls++;
        events.push('write');
        return snapshot;
      };
      if (vector.expected.issue !== undefined) {
        expectIssue(bind, vector.expected.issue);
      } else {
        const snapshot = bind();
        expect(Object.isFrozen(snapshot)).toBe(vector.expected.frozen);
        expect(program[4].map((binding) =>
          vector.subjectIdentities[subjects.indexOf(snapshot[binding[0]] as object)]))
          .toEqual(vector.expected.snapshotIdentities);
      }
      expect({ captureCalls, writeCalls }).toEqual({
        captureCalls: vector.expected.captureCalls,
        writeCalls: vector.expected.writeCalls,
      });
      expect(events).toEqual(vector.expected.events);
    }
    for (const origin of corpus.compiledOrigins) {
      const program = decodedSource.get(origin.source);
      expect(program).toBeDefined();
      const curve = program![3][origin.curveIndex];
      expect(curve).not.toBe(0);
      expect(origin.generator).toBe('lab-motion.compileSpringExecutionArtifactTupleUnchecked');
      expect(origin.generatorVersion).toBe(1);
      expect(origin.verification).toBe('exact-regeneration');
      expect(origin.compilerTolerance).toBe(DEFAULT_TOLERANCE);
      const artifact = compileSpringExecutionArtifactTupleUnchecked(
        { mass: origin.mass, stiffness: origin.stiffness, damping: origin.damping },
        origin.v0,
        origin.compilerTolerance,
      );
      const regeneratedCurve: number[] = [1];
      for (let i = 0; i < artifact[1].length; i += 2) {
        regeneratedCurve.push(artifact[1][i]! / 100, artifact[1][i + 1]!);
      }
      expect(curve).toEqual(regeneratedCurve);
      expect(Object.is(program![5][0]![2], artifact[2])).toBe(true);
      expect(Object.is(origin.durationMs, artifact[2])).toBe(true);
    }

    expect(corpus.limitRecipes).toMatchObject({
      generator: 'concat-repeated-scalars-at-program-path',
      generatorVersion: 1,
      limit: 'maxStringCodeUnits',
      countingUnit: 'utf16-code-units',
    });
    for (const vector of corpus.limitRecipes.cases) {
      const generated = vector.components.map((component) => {
        expect(bytesHex(new TextEncoder().encode(component.scalar))).toBe(component.utf8Hex);
        expect(Array.from(component.scalar, (scalar) =>
          scalar.codePointAt(0)!.toString(16).padStart(4, '0')))
          .toEqual(component.unicodeScalarsHex);
        expect(component.scalar.length).toBe(component.utf16CodeUnits);
        return component.scalar.repeat(component.repeat);
      }).join('');
      expect(generated.length).toBe(vector.expected.utf16CodeUnits);

      const input = structuredClone(corpus.limitRecipes.baseProgram);
      let target = input;
      for (let i = 0; i < corpus.limitRecipes.targetPath.length - 1; i++) {
        target = target[corpus.limitRecipes.targetPath[i]!] as unknown[];
      }
      target[corpus.limitRecipes.targetPath.at(-1)!] = generated;
      if (vector.expected.parse === 'invalid') {
        expect(vector.expected.issue).toBeDefined();
        expectIssue(() => parseMotionProgramV1(input), vector.expected.issue!);
      } else {
        expect(generated.length).toBeLessThanOrEqual(
          corpus.limits[corpus.limitRecipes.limit],
        );
        expect(parseMotionProgramV1(input)[2][0]).toBe(generated);
      }
    }

    expect(corpus.invalid.filter((vector) => vector.invariant !== undefined).map((vector) =>
      vector.invariant)).toEqual(expect.arrayContaining([
      'all-seven-standard-transform-components-required',
      'duplicate-subject-channel-writer-forbidden',
      'one-owner-per-subject-surface',
      'finite-last-motion-duration-representable',
      'finite-duration-representable-at-start-magnitude',
      'finite-repeat-delay-representable-at-start-magnitude',
      'finite-interior-boundaries-strictly-increasing',
      'finite-repeat-cycle-product-finite',
    ]));
    expect(corpus.invalid.some((vector) => vector.name === 'utf8-overlong-sequence'))
      .toBe(true);
    for (const vector of corpus.invalid) {
      if (vector.program !== undefined) {
        expectIssue(() => parseMotionProgramV1(vector.program), vector.issue);
      }
      if (vector.wireHex !== undefined) {
        expectIssue(() => decodeMotionProgramV1(hexBytes(vector.wireHex!)), vector.issue);
      }
    }
  });
});
