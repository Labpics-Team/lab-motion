/**
 * Независимый от хоста контракт данных MotionProgram V1.
 *
 * Модуль намеренно не владеет часами, DOM-возможностями, колбэками или ресурсами
 * жизненного цикла. Неизвестный вход превращается в ограниченный глубоко
 * неизменяемый граф кортежей; хост появляется лишь при привязке программы.
 */

import {
  isScheduleV1Representable,
  scheduleV1Binary64Gap,
  scheduleV1IterationBoundary,
  SCHEDULE_V1_INT32_MAX,
} from './schedule-v1.js';

export const MOTION_PROGRAM_VERSION_V1 = 1 as const;

export const MOTION_PROGRAM_FEATURE_V1: Readonly<{
    readonly currentValues: number;
    readonly relativeValues: number;
    readonly hostExtensions: number;
}> = Object.freeze({
  currentValues: 1 << 0,
  relativeValues: 1 << 1,
  /** Любой host-специфичный channel/codec/composite; portable executor обязан отказать. */
  hostExtensions: 1 << 2,
} as const);

export const MOTION_PROGRAM_SUPPORTED_FEATURES_V1: number =
  MOTION_PROGRAM_FEATURE_V1.currentValues |
  MOTION_PROGRAM_FEATURE_V1.relativeValues |
  MOTION_PROGRAM_FEATURE_V1.hostExtensions;

/**
 * Индексы и размеры коллекций V1 имеют ширину uint16 в нативном формате обмена.
 * Общий бюджет также учитывает вложенные кадры, выборки и компоненты векторов,
 * поэтому внешне плоская враждебная программа не усиливает аллокации рекурсивно.
 */
export const MOTION_PROGRAM_LIMITS_V1: Readonly<{
    readonly maxItems: 65535;
    readonly maxStringCodeUnits: 65535;
}> = Object.freeze({
  maxItems: 0xffff,
  maxStringCodeUnits: 0xffff,
} as const);

/** Native ports сравнивают строки по scalar sequence, не по своей Unicode equality. */
export const MOTION_PROGRAM_STRING_SEMANTICS_V1: Readonly<{
    readonly encoding: "utf-8";
    readonly identity: "exact-scalar-sequence";
    readonly normalization: "none";
    readonly canonicallyEquivalentSequencesMayDiffer: true;
}> = Object.freeze({
  encoding: 'utf-8',
  identity: 'exact-scalar-sequence',
  normalization: 'none',
  canonicallyEquivalentSequencesMayDiffer: true,
} as const);

/**
 * V1 фиксирует только реально общий 2D-срез. Трёхмерные матрицы, layout и SVG
 * не маскируются generic-векторами: до отдельной схемы они проходят через
 * host-extension и потому не могут случайно получить ложный native parity.
 */
export const MOTION_PROGRAM_STANDARD_CHANNEL_V1: Readonly<{
    readonly value: 0;
    readonly opacity: 1;
    readonly translateX: 2;
    readonly translateY: 3;
    readonly scaleX: 4;
    readonly scaleY: 5;
    readonly rotate: 6;
    readonly skewX: 7;
    readonly skewY: 8;
    readonly color: 9;
    readonly backgroundColor: 10;
    readonly borderColor: 11;
}> = Object.freeze({
  value: 0,
  opacity: 1,
  translateX: 2,
  translateY: 3,
  scaleX: 4,
  scaleY: 5,
  rotate: 6,
  skewX: 7,
  skewY: 8,
  color: 9,
  backgroundColor: 10,
  borderColor: 11,
} as const);

/**
 * Surface — единица host-записи. Все transform-компоненты принадлежат
 * одному surface: адаптер обязан собрать их в одну атомарную запись.
 */
export const MOTION_PROGRAM_SURFACE_V1: Readonly<{
    readonly value: 0;
    readonly opacity: 1;
    readonly transform: 2;
    readonly color: 3;
    readonly backgroundColor: 4;
    readonly borderColor: 5;
}> = Object.freeze({
  value: 0,
  opacity: 1,
  transform: 2,
  color: 3,
  backgroundColor: 4,
  borderColor: 5,
} as const);

/** Index — `MOTION_PROGRAM_STANDARD_CHANNEL_V1`, value — `MOTION_PROGRAM_SURFACE_V1`. */
export const MOTION_PROGRAM_CHANNEL_SURFACE_V1: readonly [0, 1, 2, 2, 2, 2, 2, 2, 2, 3, 4, 5] = Object.freeze([
  MOTION_PROGRAM_SURFACE_V1.value,
  MOTION_PROGRAM_SURFACE_V1.opacity,
  MOTION_PROGRAM_SURFACE_V1.transform,
  MOTION_PROGRAM_SURFACE_V1.transform,
  MOTION_PROGRAM_SURFACE_V1.transform,
  MOTION_PROGRAM_SURFACE_V1.transform,
  MOTION_PROGRAM_SURFACE_V1.transform,
  MOTION_PROGRAM_SURFACE_V1.transform,
  MOTION_PROGRAM_SURFACE_V1.transform,
  MOTION_PROGRAM_SURFACE_V1.color,
  MOTION_PROGRAM_SURFACE_V1.backgroundColor,
  MOTION_PROGRAM_SURFACE_V1.borderColor,
] as const);

export const MOTION_PROGRAM_OWNERSHIP_SEMANTICS_V1: Readonly<{
    readonly ownerGroupScope: "program-local";
    readonly invariant: "one-owner-per-subject-surface";
    readonly duplicateChannel: "forbidden";
    readonly transformWrite: "single-batched-surface-write";
    readonly transformCoverage: "all-seven-standard-components-required";
    readonly transformCurrent: "adapter-owned-component-state-or-identity-never-matrix-decomposition";
    readonly surfaceCapture: "all-binding-baselines-once-before-first-surface-write";
    readonly inactiveTrackPresentation: "captured-binding-baseline";
    readonly subjectSlotBinding: "owned-injective-snapshot-before-capture-or-io";
}> = Object.freeze({
  ownerGroupScope: 'program-local',
  invariant: 'one-owner-per-subject-surface',
  duplicateChannel: 'forbidden',
  transformWrite: 'single-batched-surface-write',
  transformCoverage: 'all-seven-standard-components-required',
  transformCurrent: 'adapter-owned-component-state-or-identity-never-matrix-decomposition',
  surfaceCapture: 'all-binding-baselines-once-before-first-surface-write',
  inactiveTrackPresentation: 'captured-binding-baseline',
  subjectSlotBinding: 'owned-injective-snapshot-before-capture-or-io',
} as const);

/**
 * `hostLogicalUnit` — координатная единица layout конкретной платформы:
 * CSS px на Web, point на Apple UI, dp на Android. Это намеренно не физический
 * дюйм: одинаковое число означает одинаковую нативную геометрию интерфейса.
 * Углы — градусы; положительный угол вращает по часовой стрелке в обычной
 * экранной системе y-down (адаптер y-up обязан инвертировать знак).
 * Clamp применяется только при presentation и не возвращается в effect-state,
 * поэтому overshoot и скорость пружины не теряются.
 */
export const MOTION_PROGRAM_CHANNEL_SEMANTICS_V1: Readonly<{
    readonly value: Readonly<{
        quantity: "number";
        unit: "one";
        presentationClamp: "none";
    }>;
    readonly opacity: Readonly<{
        quantity: "coverage";
        unit: "one";
        presentationClamp: "unitInterval";
    }>;
    readonly translateX: Readonly<{
        quantity: "length";
        unit: "hostLogicalUnit";
        presentationClamp: "none";
    }>;
    readonly translateY: Readonly<{
        quantity: "length";
        unit: "hostLogicalUnit";
        presentationClamp: "none";
    }>;
    readonly scaleX: Readonly<{
        quantity: "scale";
        unit: "ratio";
        presentationClamp: "none";
    }>;
    readonly scaleY: Readonly<{
        quantity: "scale";
        unit: "ratio";
        presentationClamp: "none";
    }>;
    readonly rotate: Readonly<{
        quantity: "angle";
        unit: "degree";
        presentationClamp: "none";
    }>;
    readonly skewX: Readonly<{
        quantity: "angle";
        unit: "degree";
        presentationClamp: "none";
    }>;
    readonly skewY: Readonly<{
        quantity: "angle";
        unit: "degree";
        presentationClamp: "none";
    }>;
    readonly color: Readonly<{
        quantity: "color";
        unit: "codec";
        presentationClamp: "codec";
    }>;
    readonly backgroundColor: Readonly<{
        quantity: "color";
        unit: "codec";
        presentationClamp: "codec";
    }>;
    readonly borderColor: Readonly<{
        quantity: "color";
        unit: "codec";
        presentationClamp: "codec";
    }>;
}> = Object.freeze({
  value: Object.freeze({ quantity: 'number', unit: 'one', presentationClamp: 'none' }),
  opacity: Object.freeze({ quantity: 'coverage', unit: 'one', presentationClamp: 'unitInterval' }),
  translateX: Object.freeze({ quantity: 'length', unit: 'hostLogicalUnit', presentationClamp: 'none' }),
  translateY: Object.freeze({ quantity: 'length', unit: 'hostLogicalUnit', presentationClamp: 'none' }),
  scaleX: Object.freeze({ quantity: 'scale', unit: 'ratio', presentationClamp: 'none' }),
  scaleY: Object.freeze({ quantity: 'scale', unit: 'ratio', presentationClamp: 'none' }),
  rotate: Object.freeze({ quantity: 'angle', unit: 'degree', presentationClamp: 'none' }),
  skewX: Object.freeze({ quantity: 'angle', unit: 'degree', presentationClamp: 'none' }),
  skewY: Object.freeze({ quantity: 'angle', unit: 'degree', presentationClamp: 'none' }),
  color: Object.freeze({ quantity: 'color', unit: 'codec', presentationClamp: 'codec' }),
  backgroundColor: Object.freeze({ quantity: 'color', unit: 'codec', presentationClamp: 'codec' }),
  borderColor: Object.freeze({ quantity: 'color', unit: 'codec', presentationClamp: 'codec' }),
} as const);

/** Порядок совпадает с текущим Web formatter: translate → scale → rotate → skew. */
export const MOTION_PROGRAM_TRANSFORM_ORDER_V1: readonly [2, 3, 4, 5, 6, 7, 8] = Object.freeze([
  MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateX,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateY,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1.scaleX,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1.scaleY,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1.rotate,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1.skewX,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1.skewY,
] as const);

export const MOTION_PROGRAM_TRANSFORM_SEMANTICS_V1: Readonly<{
    readonly numericModel: "ieee754-binary64";
    readonly matrixOrder: "translate*scale*rotate*combinedSkew";
    readonly matrixEvaluation: "closed-form-T*S*R*combinedSkew";
    readonly cssMatrixLayout: "[a,b,c,d,tx,ty]";
    readonly combinedSkewMatrix: "[1,tan(skewY),tan(skewX),1,0,0]";
    readonly angleReduction: "truncating-remainder-then-half-open-fold-before-radians";
    readonly matrixOverflow: "componentwise-saturate-to-f64-greatest-finite";
    readonly matrixOverflowFeedsBack: false;
    readonly totalityDomain: "all-seven-resolved-finite-scalars";
    readonly yUpAdapter: Readonly<{
        negate: readonly ["translateY", "rotate", "skewX", "skewY"];
        preserve: readonly ["translateX", "scaleX", "scaleY"];
    }>;
}> = Object.freeze({
  numericModel: 'ieee754-binary64',
  matrixOrder: 'translate*scale*rotate*combinedSkew',
  matrixEvaluation: 'closed-form-T*S*R*combinedSkew',
  cssMatrixLayout: '[a,b,c,d,tx,ty]',
  combinedSkewMatrix: '[1,tan(skewY),tan(skewX),1,0,0]',
  angleReduction: 'truncating-remainder-then-half-open-fold-before-radians',
  matrixOverflow: 'componentwise-saturate-to-f64-greatest-finite',
  matrixOverflowFeedsBack: false,
  totalityDomain: 'all-seven-resolved-finite-scalars',
  yUpAdapter: Object.freeze({
    negate: Object.freeze(['translateY', 'rotate', 'skewX', 'skewY'] as const),
    preserve: Object.freeze(['translateX', 'scaleX', 'scaleY'] as const),
  }),
} as const);

/** Числа остаются в effect-space; адаптер меняет только представление на границе. */
export const MOTION_PROGRAM_COORDINATE_SEMANTICS_V1: Readonly<{
    readonly hostLogicalUnit: Readonly<{
        web: "css-px";
        apple: "point";
        android: "dp";
        other: "host-layout-logical-unit";
    }>;
    readonly angle: Readonly<{
        unit: "degree";
        positive: "clockwise-in-y-down";
        yUpAdapter: "negate-rotate-skewX-skewY-at-presentation";
    }>;
    readonly yAxis: Readonly<{
        positive: "down";
        yUpAdapter: "negate-translateY-at-presentation";
    }>;
    readonly transformComposition: "translate-scale-rotate-skew";
    readonly pathCompilation: "sampled-translateX-translateY-optional-rotate";
    readonly effectClamp: "none";
    readonly presentationClampFeedsBack: false;
}> = Object.freeze({
  hostLogicalUnit: Object.freeze({
    web: 'css-px',
    apple: 'point',
    android: 'dp',
    other: 'host-layout-logical-unit',
  }),
  angle: Object.freeze({
    unit: 'degree',
    positive: 'clockwise-in-y-down',
    yUpAdapter: 'negate-rotate-skewX-skewY-at-presentation',
  }),
  yAxis: Object.freeze({
    positive: 'down',
    yUpAdapter: 'negate-translateY-at-presentation',
  }),
  transformComposition: 'translate-scale-rotate-skew',
  pathCompilation: 'sampled-translateX-translateY-optional-rotate',
  effectClamp: 'none',
  presentationClampFeedsBack: false,
} as const);

export const MOTION_PROGRAM_CURVE_SEMANTICS_V1: Readonly<{
    readonly forms: "linear-or-sampled";
    readonly sourceCurves: "compiled-out";
    readonly interpolation: "piecewise-affine";
    readonly duplicateOffset: "last-sample-wins-at-exact-boundary";
}> = Object.freeze({
  forms: 'linear-or-sampled',
  sourceCurves: 'compiled-out',
  interpolation: 'piecewise-affine',
  duplicateOffset: 'last-sample-wins-at-exact-boundary',
} as const);

/**
 * Закон интерполяции принадлежит сегменту, а не binding: одна дорожка
 * может точно выразить HSL→HSL→RGB и тот же цикл repeat/mirror.
 * Граничное значение дублируется в `to` левого и `from` правого
 * сегмента: это позволяет хранить один цвет в двух codec-layout без потери.
 */
export const MOTION_PROGRAM_SEGMENT_SEMANTICS_V1: Readonly<{
    readonly codecOwner: "outgoing-segment";
    readonly coverage: "strict-positive-contiguous-zero-to-one";
    readonly endpoint: "exact-before-curve";
    readonly boundary: "right-segment-wins-at-exact-offset";
    readonly boundaryRepresentation: "explicit-left-to-and-right-from";
    readonly mixedCodec: "portable-within-one-track";
}> = Object.freeze({
  codecOwner: 'outgoing-segment',
  coverage: 'strict-positive-contiguous-zero-to-one',
  endpoint: 'exact-before-curve',
  boundary: 'right-segment-wins-at-exact-offset',
  boundaryRepresentation: 'explicit-left-to-and-right-from',
  mixedCodec: 'portable-within-one-track',
} as const);

export const MOTION_PROGRAM_HOST_EXTENSION_SEMANTICS_V1: Readonly<{
    readonly portable: false;
    readonly nativePolicy: "reject-before-bind";
    readonly escapedChannel: "adapter-registered";
    readonly additiveComposite: "adapter-registered";
    readonly webCssOpaque: "adapter-registered";
}> = Object.freeze({
  portable: false,
  nativePolicy: 'reject-before-bind',
  escapedChannel: 'adapter-registered',
  additiveComposite: 'adapter-registered',
  webCssOpaque: 'adapter-registered',
} as const);

export const MOTION_PROGRAM_CODEC_V1: Readonly<{
    readonly scalar: 0;
    readonly colorGamma2: 1;
    readonly colorSrgb: 2;
    readonly colorHslShortest: 3;
    readonly discrete: 4;
    readonly webCssOpaque: 5;
}> = Object.freeze({
  scalar: 0,
  colorGamma2: 1,
  colorSrgb: 2,
  colorHslShortest: 3,
  discrete: 4,
  webCssOpaque: 5,
} as const);

const RGBA_RANGES = Object.freeze([
  '[0,255]',
  '[0,255]',
  '[0,255]',
  '[0,1]',
] as const);
const HSLA_RANGES = Object.freeze([
  '[0,360)',
  '[0,1]',
  '[0,1]',
  '[0,1]',
] as const);

/**
 * Цвет хранит straight (не premultiplied) alpha. `colorGamma2` намеренно
 * называет фактическую sqrt-аппроксимацию нынешнего Web API, не выдавая её за
 * точный linear-light sRGB. Opaque codec делегирует и разбор, и интерполяцию
 * зарегистрированному хосту, поэтому сам по себе не является portable.
 */
export const MOTION_PROGRAM_CODEC_SEMANTICS_V1: Readonly<{
    readonly scalar: Readonly<{
        encoded: "scalar";
        layout: "f64";
        interpolation: "affine-unclamped";
        relative: true;
        portable: true;
    }>;
    readonly colorGamma2: Readonly<{
        encoded: "vector";
        layout: "encoded-srgb-straight-rgba";
        ranges: readonly ["[0,255]", "[0,255]", "[0,255]", "[0,1]"];
        interpolation: "sqrt-energy-rgb-linear-alpha-clamped-progress";
        relative: false;
        portable: true;
    }>;
    readonly colorSrgb: Readonly<{
        encoded: "vector";
        layout: "encoded-srgb-straight-rgba";
        ranges: readonly ["[0,255]", "[0,255]", "[0,255]", "[0,1]"];
        interpolation: "encoded-srgb-linear-alpha-clamped-progress";
        relative: false;
        portable: true;
    }>;
    readonly colorHslShortest: Readonly<{
        encoded: "vector";
        layout: "h-deg-s-l-straight-a";
        ranges: readonly ["[0,360)", "[0,1]", "[0,1]", "[0,1]"];
        interpolation: "shortest-hue-linear-sla-clamped-progress";
        relative: false;
        portable: true;
    }>;
    readonly discrete: Readonly<{
        encoded: "token";
        layout: "string-index";
        interpolation: "right-continuous-half-swap";
        relative: false;
        portable: false;
    }>;
    readonly webCssOpaque: Readonly<{
        encoded: "token";
        layout: "string-index";
        interpolation: "registered-host";
        relative: false;
        portable: false;
    }>;
}> = Object.freeze({
  scalar: Object.freeze({
    encoded: 'scalar',
    layout: 'f64',
    interpolation: 'affine-unclamped',
    relative: true,
    portable: true,
  }),
  colorGamma2: Object.freeze({
    encoded: 'vector',
    layout: 'encoded-srgb-straight-rgba',
    ranges: RGBA_RANGES,
    interpolation: 'sqrt-energy-rgb-linear-alpha-clamped-progress',
    relative: false,
    portable: true,
  }),
  colorSrgb: Object.freeze({
    encoded: 'vector',
    layout: 'encoded-srgb-straight-rgba',
    ranges: RGBA_RANGES,
    interpolation: 'encoded-srgb-linear-alpha-clamped-progress',
    relative: false,
    portable: true,
  }),
  colorHslShortest: Object.freeze({
    encoded: 'vector',
    layout: 'h-deg-s-l-straight-a',
    ranges: HSLA_RANGES,
    interpolation: 'shortest-hue-linear-sla-clamped-progress',
    relative: false,
    portable: true,
  }),
  discrete: Object.freeze({
    encoded: 'token',
    layout: 'string-index',
    interpolation: 'right-continuous-half-swap',
    relative: false,
    portable: false,
  }),
  webCssOpaque: Object.freeze({
    encoded: 'token',
    layout: 'string-index',
    interpolation: 'registered-host',
    relative: false,
    portable: false,
  }),
} as const);

export const MOTION_PROGRAM_DIRECTION_V1: Readonly<{
    readonly normal: 0;
    readonly reverse: 1;
    readonly alternate: 2;
    readonly alternateReverse: 3;
    readonly mirror: 4;
}> = Object.freeze({
  normal: 0,
  reverse: 1,
  alternate: 2,
  alternateReverse: 3,
  // Motion-style mirror меняет концы, сохраняя прямой easing сегмента;
  // WAAPI alternate разворачивает время/easing и потому не эквивалентен ему.
  mirror: 4,
} as const);

export const MOTION_PROGRAM_COMPOSITE_V1: Readonly<{
    readonly replace: 0;
    readonly add: 1;
    readonly accumulate: 2;
}> = Object.freeze({
  replace: 0,
  add: 1,
  accumulate: 2,
} as const);

export const MOTION_PROGRAM_SCHEDULE_SEMANTICS_V1: Readonly<{
    readonly timeDomain: "finite-ieee754-binary64-milliseconds";
    readonly startTime: "any-finite";
    readonly repeat: "additional-iterations";
    readonly infiniteRepeat: -1;
    readonly repeatDelay: "between-iterations-only";
    readonly cycleArithmetic: "round-ties-even-duration-plus-repeatDelay";
    readonly iterationBoundary: "round-ties-even(round-ties-even(index-times-cycle)-plus-start)";
    readonly zeroDelayMotionEnd: "next-iteration-boundary";
    readonly positiveDelayMotionEnd: "round-ties-even(iteration-boundary-plus-duration)";
    readonly finiteTerminalBoundary: "round-ties-even(last-iteration-boundary-plus-duration)";
    readonly finiteRepresentability: "reject-unproven-distinct-nonzero-phase-boundaries";
    readonly finiteResolutionBudget: "max-product-gap-plus-twice-max-absolute-gap";
    readonly zeroFiniteDuration: "allowed";
    readonly infiniteCycle: "duration-plus-repeatDelay-must-be-positive";
    readonly infiniteRepresentability: "sample-defined-no-global-phase-resolution-guarantee";
    readonly infiniteBoundarySelection: "greatest-exact-integer-index-with-absolute-boundary-not-after-sample";
    readonly infiniteIterationIndex: "zero-through-9007199254740991-internal-null-public";
    readonly infiniteParity: "exact-low-bit-within-supported-iteration-domain";
    readonly unsafeQuotient: "fail-LMP_BOUNDS-before-iteration-9007199254740992-boundary";
    readonly beforeStart: "inactive";
    readonly motionInterval: "half-open";
    readonly repeatBoundary: "next-iteration-wins";
    readonly repeatDelayPose: "directional-endpoint";
    readonly finiteEnd: "closed-terminal-commit";
    readonly afterEnd: "terminal-pose-remains-committed-without-live-writer";
    readonly zeroDuration: "instant-terminal-of-current-direction";
    readonly normal: "forward-every-iteration";
    readonly reverse: "reverse-every-iteration";
    readonly alternate: "forward-even-reverse-odd";
    readonly alternateReverse: "reverse-even-forward-odd";
    readonly mirror: "odd-reverse-values-keep-authored-interval-and-curve-forward";
    readonly publicRepeatTypeCompilerMapping: Readonly<{
        loop: "normal";
        reverse: "alternate";
        mirror: "mirror";
    }>;
}> = Object.freeze({
  timeDomain: 'finite-ieee754-binary64-milliseconds',
  startTime: 'any-finite',
  repeat: 'additional-iterations',
  infiniteRepeat: -1,
  repeatDelay: 'between-iterations-only',
  cycleArithmetic: 'round-ties-even-duration-plus-repeatDelay',
  iterationBoundary: 'round-ties-even(round-ties-even(index-times-cycle)-plus-start)',
  zeroDelayMotionEnd: 'next-iteration-boundary',
  positiveDelayMotionEnd: 'round-ties-even(iteration-boundary-plus-duration)',
  finiteTerminalBoundary: 'round-ties-even(last-iteration-boundary-plus-duration)',
  finiteRepresentability: 'reject-unproven-distinct-nonzero-phase-boundaries',
  finiteResolutionBudget: 'max-product-gap-plus-twice-max-absolute-gap',
  zeroFiniteDuration: 'allowed',
  infiniteCycle: 'duration-plus-repeatDelay-must-be-positive',
  infiniteRepresentability: 'sample-defined-no-global-phase-resolution-guarantee',
  infiniteBoundarySelection: 'greatest-exact-integer-index-with-absolute-boundary-not-after-sample',
  infiniteIterationIndex: 'zero-through-9007199254740991-internal-null-public',
  infiniteParity: 'exact-low-bit-within-supported-iteration-domain',
  unsafeQuotient: 'fail-LMP_BOUNDS-before-iteration-9007199254740992-boundary',
  beforeStart: 'inactive',
  motionInterval: 'half-open',
  repeatBoundary: 'next-iteration-wins',
  repeatDelayPose: 'directional-endpoint',
  finiteEnd: 'closed-terminal-commit',
  afterEnd: 'terminal-pose-remains-committed-without-live-writer',
  zeroDuration: 'instant-terminal-of-current-direction',
  normal: 'forward-every-iteration',
  reverse: 'reverse-every-iteration',
  alternate: 'forward-even-reverse-odd',
  alternateReverse: 'reverse-even-forward-odd',
  mirror: 'odd-reverse-values-keep-authored-interval-and-curve-forward',
  publicRepeatTypeCompilerMapping: Object.freeze({
    loop: 'normal',
    reverse: 'alternate',
    mirror: 'mirror',
  }),
} as const);

type ValueOf<T> = T[keyof T];

export type MotionProgramStandardChannelV1 =
  ValueOf<typeof MOTION_PROGRAM_STANDARD_CHANNEL_V1>;
export type MotionProgramCodecV1 = ValueOf<typeof MOTION_PROGRAM_CODEC_V1>;
export type MotionProgramDirectionV1 = ValueOf<typeof MOTION_PROGRAM_DIRECTION_V1>;
export type MotionProgramCompositeV1 = ValueOf<typeof MOTION_PROGRAM_COMPOSITE_V1>;

/** `255` — явный escape; имя хостового канала хранится в таблице строк. */
export type MotionProgramChannelV1 =
  | MotionProgramStandardChannelV1
  | readonly [hostExtension: 255, stringIndex: number];

export type MotionProgramEncodedValueV1 =
  | readonly [scalar: 0, value: number]
  | readonly [vector: 1, firstComponent: number, ...components: number[]]
  | readonly [token: 2, stringIndex: number];

/**
 * Значения разрешаются один раз при привязке, до первой host-записи, в
 * каноническом порядке segment.from → segment.to. Первый `current` означает
 * bind-time snapshot, каждый следующий — уже разрешённую предыдущую точку.
 * `relative` использует ту же базу; переполнение прерывает bind до IO. Repeat и
 * mirror не захватывают current повторно.
 */
export type MotionProgramValueExprV1 =
  | readonly [current: 0]
  | readonly [absolute: 1, value: MotionProgramEncodedValueV1]
  | readonly [relative: 2, sign: -1 | 1, value: MotionProgramEncodedValueV1];

/**
 * Fully-compiled curve: source spring/cubic/steps сюда не попадают. Компилятор
 * превращает их в кусочно-линейные samples; повторный offset кодирует скачок.
 * На точной повторной границе исполнитель выбирает ПОСЛЕДНЮЮ запись (правый
 * предел), что делает steps/mirror одинаковыми во всех языках.
 */
export type MotionProgramCurveV1 =
  | 0
  | readonly [
    samples: 1,
    firstOffset: number,
    firstValue: number,
    lastOffset: number,
    lastValue: number,
    ...offsetValuePairs: number[],
  ];

export type MotionProgramBindingV1 = readonly [
  subjectSlot: number,
  channel: MotionProgramChannelV1,
  ownerGroup: number,
];

export type MotionProgramSegmentV1 = readonly [
  startOffset: number,
  endOffset: number,
  from: MotionProgramValueExprV1,
  to: MotionProgramValueExprV1,
  outgoingCurve: number,
  codec: MotionProgramCodecV1,
];

export type MotionProgramTrackV1 = readonly [
  binding: number,
  startMs: number,
  durationMs: number,
  repeat: number,
  direction: MotionProgramDirectionV1,
  repeatDelayMs: number,
  composite: MotionProgramCompositeV1,
  segments: readonly MotionProgramSegmentV1[],
];

declare const MOTION_PROGRAM_V1_BRAND: unique symbol;

/** Brand существует только в типах; runtime-форма остаётся кортежем из шести слотов. */
export type MotionProgramV1 = readonly [
  version: 1,
  requiredFeatures: number,
  strings: readonly string[],
  curves: readonly MotionProgramCurveV1[],
  bindings: readonly MotionProgramBindingV1[],
  tracks: readonly MotionProgramTrackV1[],
] & { readonly [MOTION_PROGRAM_V1_BRAND]: true };

export type MotionProgramParseIssue =
  | 'LMP_SHAPE'
  | 'LMP_LIMIT'
  | 'LMP_VERSION'
  | 'LMP_FEATURE'
  | 'LMP_NUMBER'
  | 'LMP_BOUNDS'
  | 'LMP_INDEX'
  | 'LMP_OFFSET'
  | 'LMP_CANONICAL'
  | 'LMP_CODEC'
  | 'LMP_WIRE';

/** Стабильная ошибка без данных входа, общая для парсера и нативного wire-эталона. */
export class MotionProgramParseError extends TypeError {
  override readonly name = 'MotionProgramParseError';
  readonly code: MotionProgramParseIssue;

  constructor(code: MotionProgramParseIssue) {
    super(code);
    this.code = code;
  }
}

interface ParseBudget {
  remaining: number;
}

interface FeatureUse {
  mask: number;
}

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const STANDARD_CHANNEL_MAX = MOTION_PROGRAM_STANDARD_CHANNEL_V1.borderColor;
const CODEC_MAX = MOTION_PROGRAM_CODEC_V1.webCssOpaque;
const DIRECTION_MAX = MOTION_PROGRAM_DIRECTION_V1.mirror;
const COMPOSITE_MAX = MOTION_PROGRAM_COMPOSITE_V1.accumulate;

function fail(code: MotionProgramParseIssue): never {
  throw new MotionProgramParseError(code);
}

function ownArrayLength(input: unknown): number {
  let isArray: boolean;
  try {
    isArray = Array.isArray(input);
  } catch {
    fail('LMP_SHAPE');
  }
  if (!isArray) fail('LMP_SHAPE');
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, 'length');
  } catch {
    fail('LMP_SHAPE');
  }
  if (descriptor === undefined || !('value' in descriptor)) fail('LMP_SHAPE');
  const length = descriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) fail('LMP_SHAPE');
  return length;
}

function ownArrayValue(input: readonly unknown[], index: number): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, String(index));
  } catch {
    fail('LMP_SHAPE');
  }
  // Accessor и унаследованные sparse-слоты отклоняются без их вызова.
  if (descriptor === undefined || !('value' in descriptor)) fail('LMP_SHAPE');
  return descriptor.value;
}

function snapshotExact(input: unknown, length: number): unknown[] {
  if (ownArrayLength(input) !== length) fail('LMP_SHAPE');
  const array = input as readonly unknown[];
  const out = new Array<unknown>(length);
  for (let i = 0; i < length; i++) out[i] = ownArrayValue(array, i);
  return out;
}

function take(budget: ParseBudget, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.remaining) {
    fail('LMP_LIMIT');
  }
  budget.remaining -= count;
}

function snapshotCollection(
  input: unknown,
  minimum: number,
  budget: ParseBudget,
): unknown[] {
  const length = ownArrayLength(input);
  if (length < minimum) fail('LMP_SHAPE');
  take(budget, length);
  const array = input as readonly unknown[];
  const out = new Array<unknown>(length);
  for (let i = 0; i < length; i++) out[i] = ownArrayValue(array, i);
  return out;
}

function finite(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) fail('LMP_NUMBER');
  return input;
}

/** Максимальный конечный adjacent gap в binade заданной абсолютной величины. */
export const motionProgramBinary64GapV1: typeof scheduleV1Binary64Gap = scheduleV1Binary64Gap;

/** Канонический порядок: сначала RN64(index * cycle), затем RN64(+ start). */
export const motionProgramIterationBoundaryV1: typeof scheduleV1IterationBoundary = scheduleV1IterationBoundary;

function boundedFinite(input: unknown, minimum: number, maximum: number): number {
  const value = finite(input);
  if (value < minimum || value > maximum) fail('LMP_BOUNDS');
  return value;
}

function unsignedInteger(input: unknown, maximum: number): number {
  if (
    typeof input !== 'number' ||
    !Number.isInteger(input) ||
    Object.is(input, -0) ||
    input < 0 ||
    input > maximum
  ) {
    fail('LMP_BOUNDS');
  }
  return input;
}

function index(input: unknown, length: number): number {
  const value = unsignedInteger(input, UINT16_MAX);
  if (value >= length) fail('LMP_INDEX');
  return value;
}

function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length) return false;
      const low = value.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function parseStrings(input: unknown, budget: ParseBudget): readonly string[] {
  const raw = snapshotCollection(input, 0, budget);
  const strings = new Array<string>(raw.length);
  const seen = new Set<string>();
  let codeUnits = 0;
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value !== 'string') fail('LMP_SHAPE');
    const nextCodeUnits = codeUnits + value.length;
    if (nextCodeUnits > MOTION_PROGRAM_LIMITS_V1.maxStringCodeUnits) fail('LMP_LIMIT');
    if (!isWellFormedUtf16(value)) fail('LMP_SHAPE');
    codeUnits = nextCodeUnits;
    if (seen.has(value)) fail('LMP_CANONICAL');
    seen.add(value);
    strings[i] = value;
  }
  return Object.freeze(strings);
}

function parseSampledCurve(
  input: unknown,
  budget: ParseBudget,
): MotionProgramCurveV1 {
  const length = ownArrayLength(input);
  if (length < 5 || (length & 1) === 0) fail('LMP_SHAPE');
  const pointCount = (length - 1) / 2;
  take(budget, pointCount);
  const array = input as readonly unknown[];
  const out = new Array<number>(length);
  out[0] = 1;
  let previous = 0;
  for (let point = 0; point < pointCount; point++) {
    const offset = boundedFinite(ownArrayValue(array, point * 2 + 1), 0, 1);
    const value = finite(ownArrayValue(array, point * 2 + 2));
    if (point === 0 ? offset !== 0 : offset < previous) fail('LMP_OFFSET');
    if (point === pointCount - 1 && offset !== 1) fail('LMP_OFFSET');
    previous = offset;
    out[point * 2 + 1] = offset;
    out[point * 2 + 2] = value;
  }
  return Object.freeze(out) as MotionProgramCurveV1;
}

function parseCurve(
  input: unknown,
  budget: ParseBudget,
): MotionProgramCurveV1 {
  if (input === 0 && !Object.is(input, -0)) return 0;
  const length = ownArrayLength(input);
  if (length === 0) fail('LMP_SHAPE');
  const array = input as readonly unknown[];
  if (unsignedInteger(ownArrayValue(array, 0), 1) !== 1) fail('LMP_SHAPE');
  return parseSampledCurve(input, budget);
}

function parseCurves(
  input: unknown,
  budget: ParseBudget,
): readonly MotionProgramCurveV1[] {
  const raw = snapshotCollection(input, 1, budget);
  const curves = new Array<MotionProgramCurveV1>(raw.length);
  for (let i = 0; i < raw.length; i++) curves[i] = parseCurve(raw[i], budget);
  if (curves[0] !== 0) fail('LMP_CANONICAL');
  return Object.freeze(curves);
}

function parseChannel(
  input: unknown,
  stringsLength: number,
  features: FeatureUse,
): MotionProgramChannelV1 {
  if (typeof input === 'number') {
    return unsignedInteger(input, STANDARD_CHANNEL_MAX) as MotionProgramStandardChannelV1;
  }
  const raw = snapshotExact(input, 2);
  if (raw[0] !== 255) fail('LMP_SHAPE');
  const stringIndex = index(raw[1], stringsLength);
  features.mask |= MOTION_PROGRAM_FEATURE_V1.hostExtensions;
  return Object.freeze([255, stringIndex] as const);
}

function isColorChannel(channel: MotionProgramStandardChannelV1): boolean {
  return channel >= MOTION_PROGRAM_STANDARD_CHANNEL_V1.color &&
    channel <= MOTION_PROGRAM_STANDARD_CHANNEL_V1.borderColor;
}

function isColorCodec(codec: MotionProgramCodecV1): boolean {
  return codec >= MOTION_PROGRAM_CODEC_V1.colorGamma2 &&
    codec <= MOTION_PROGRAM_CODEC_V1.colorHslShortest;
}

function validateBindingCodec(
  channel: MotionProgramChannelV1,
  codec: MotionProgramCodecV1,
): void {
  if (typeof channel !== 'number') return;
  if (isColorChannel(channel)) {
    if (!isColorCodec(codec)) fail('LMP_CODEC');
  } else if (codec !== MOTION_PROGRAM_CODEC_V1.scalar) {
    fail('LMP_CODEC');
  }
}

function parseBindings(
  input: unknown,
  stringsLength: number,
  budget: ParseBudget,
  features: FeatureUse,
): readonly MotionProgramBindingV1[] {
  const raw = snapshotCollection(input, 1, budget);
  const bindings = new Array<MotionProgramBindingV1>(raw.length);
  const writers = new Set<string>();
  const surfaceOwners = new Map<string, number>();
  const transformMasks = new Map<number, number>();
  for (let i = 0; i < raw.length; i++) {
    const tuple = snapshotExact(raw[i], 3);
    const subjectSlot = unsignedInteger(tuple[0], UINT16_MAX);
    const channel = parseChannel(tuple[1], stringsLength, features);
    const writerKey = typeof channel === 'number'
      ? `${subjectSlot}:s${channel}`
      : `${subjectSlot}:h${channel[1]}`;
    if (writers.has(writerKey)) fail('LMP_CANONICAL');
    writers.add(writerKey);
    const ownerGroup = unsignedInteger(tuple[2], UINT16_MAX);
    const surface = typeof channel === 'number'
      ? `s${MOTION_PROGRAM_CHANNEL_SURFACE_V1[channel]}`
      : `h${channel[1]}`;
    const surfaceKey = `${subjectSlot}:${surface}`;
    const previousOwner = surfaceOwners.get(surfaceKey);
    if (previousOwner !== undefined && previousOwner !== ownerGroup) fail('LMP_CANONICAL');
    surfaceOwners.set(surfaceKey, ownerGroup);
    if (
      typeof channel === 'number' &&
      channel >= MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateX &&
      channel <= MOTION_PROGRAM_STANDARD_CHANNEL_V1.skewY
    ) {
      const bit = 1 << (channel - MOTION_PROGRAM_STANDARD_CHANNEL_V1.translateX);
      transformMasks.set(subjectSlot, (transformMasks.get(subjectSlot) ?? 0) | bit);
    }
    bindings[i] = Object.freeze([subjectSlot, channel, ownerGroup] as const);
  }
  for (const mask of transformMasks.values()) {
    if (mask !== 0x7f) fail('LMP_CANONICAL');
  }
  return Object.freeze(bindings);
}

function parseEncodedValue(
  input: unknown,
  stringsLength: number,
  budget: ParseBudget,
): MotionProgramEncodedValueV1 {
  const length = ownArrayLength(input);
  if (length === 0) fail('LMP_SHAPE');
  const array = input as readonly unknown[];
  const tag = unsignedInteger(ownArrayValue(array, 0), 2);
  if (tag === 0) {
    const raw = snapshotExact(input, 2);
    return Object.freeze([0, finite(raw[1])] as const);
  }
  if (tag === 1) {
    if (length < 2) fail('LMP_SHAPE');
    take(budget, length - 1);
    const vector = new Array<number>(length);
    vector[0] = 1;
    for (let i = 1; i < length; i++) vector[i] = finite(ownArrayValue(array, i));
    return Object.freeze(vector) as MotionProgramEncodedValueV1;
  }
  const raw = snapshotExact(input, 2);
  return Object.freeze([2, index(raw[1], stringsLength)] as const);
}

function parseValueExpr(
  input: unknown,
  stringsLength: number,
  budget: ParseBudget,
  features: FeatureUse,
): MotionProgramValueExprV1 {
  const length = ownArrayLength(input);
  if (length === 0) fail('LMP_SHAPE');
  const array = input as readonly unknown[];
  const tag = unsignedInteger(ownArrayValue(array, 0), 2);
  if (tag === 0) {
    if (length !== 1) fail('LMP_SHAPE');
    features.mask |= MOTION_PROGRAM_FEATURE_V1.currentValues;
    return Object.freeze([0] as const);
  }
  if (tag === 1) {
    const raw = snapshotExact(input, 2);
    return Object.freeze([1, parseEncodedValue(raw[1], stringsLength, budget)] as const);
  }
  const raw = snapshotExact(input, 3);
  const sign = finite(raw[1]);
  if (sign !== -1 && sign !== 1) fail('LMP_BOUNDS');
  const value = parseEncodedValue(raw[2], stringsLength, budget);
  features.mask |= MOTION_PROGRAM_FEATURE_V1.relativeValues;
  return Object.freeze([2, sign, value] as const);
}

function validateCodecValue(
  expression: MotionProgramValueExprV1,
  codec: MotionProgramCodecV1,
): void {
  if (expression[0] === 0) {
    // Web выбирает HSL-vs-RGB law по source-format bind-time цвета;
    // native Color эту синтаксическую историю не хранит. Такой current идёт через
    // escaped channel + webCssOpaque, а не через ложно portable color codec.
    if (isColorCodec(codec)) fail('LMP_CODEC');
    return;
  }
  const value = expression[0] === 1 ? expression[1] : expression[2];
  const relative = expression[0] === 2;

  if (codec === MOTION_PROGRAM_CODEC_V1.scalar) {
    if (value[0] !== 0) fail('LMP_CODEC');
    if (relative && (value[1] < 0 || Object.is(value[1], -0))) fail('LMP_CANONICAL');
    return;
  }
  if (codec === MOTION_PROGRAM_CODEC_V1.discrete || codec === MOTION_PROGRAM_CODEC_V1.webCssOpaque) {
    if (value[0] !== 2 || relative) fail('LMP_CODEC');
    return;
  }
  if (value[0] !== 1 || value.length !== 5 || relative) fail('LMP_CODEC');
  for (let i = 1; i < value.length; i++) {
    if (Object.is(value[i], -0)) fail('LMP_CODEC');
  }
  if (codec === MOTION_PROGRAM_CODEC_V1.colorHslShortest) {
    if (value[1] < 0 || value[1] >= 360) fail('LMP_CODEC');
    if (value[2] < 0 || value[2] > 1 || value[3] < 0 || value[3] > 1 || value[4] < 0 || value[4] > 1) {
      fail('LMP_CODEC');
    }
    return;
  }
  if (
    value[1] < 0 || value[1] > 255 ||
    value[2] < 0 || value[2] > 255 ||
    value[3] < 0 || value[3] > 255 ||
    value[4] < 0 || value[4] > 1
  ) {
    fail('LMP_CODEC');
  }
}

function parseSegments(
  input: unknown,
  stringsLength: number,
  curvesLength: number,
  channel: MotionProgramChannelV1,
  budget: ParseBudget,
  features: FeatureUse,
): readonly MotionProgramSegmentV1[] {
  const raw = snapshotCollection(input, 1, budget);
  const segments = new Array<MotionProgramSegmentV1>(raw.length);
  let previousEnd = 0;
  for (let i = 0; i < raw.length; i++) {
    const tuple = snapshotExact(raw[i], 6);
    const startOffset = boundedFinite(tuple[0], 0, 1);
    const endOffset = boundedFinite(tuple[1], 0, 1);
    if (startOffset !== previousEnd || !(endOffset > startOffset)) fail('LMP_OFFSET');
    if (i === raw.length - 1 && endOffset !== 1) fail('LMP_OFFSET');
    previousEnd = endOffset;
    const from = parseValueExpr(tuple[2], stringsLength, budget, features);
    const to = parseValueExpr(tuple[3], stringsLength, budget, features);
    const outgoingCurve = index(tuple[4], curvesLength);
    const codec = unsignedInteger(tuple[5], CODEC_MAX) as MotionProgramCodecV1;
    validateBindingCodec(channel, codec);
    validateCodecValue(from, codec);
    validateCodecValue(to, codec);
    segments[i] = Object.freeze([
      startOffset,
      endOffset,
      from,
      to,
      outgoingCurve,
      codec,
    ] as const);
  }
  return Object.freeze(segments);
}

function parseTracks(
  input: unknown,
  stringsLength: number,
  curvesLength: number,
  bindings: readonly MotionProgramBindingV1[],
  budget: ParseBudget,
  features: FeatureUse,
): readonly MotionProgramTrackV1[] {
  const raw = snapshotCollection(input, 1, budget);
  const tracks = new Array<MotionProgramTrackV1>(raw.length);
  const bindingUse = new Uint8Array(bindings.length);
  for (let i = 0; i < raw.length; i++) {
    const tuple = snapshotExact(raw[i], 8);
    const binding = index(tuple[0], bindings.length);
    if (bindingUse[binding] !== 0) fail('LMP_CANONICAL');
    bindingUse[binding] = 1;
    const startMs = finite(tuple[1]);
    const durationMs = finite(tuple[2]);
    if (durationMs < 0) fail('LMP_BOUNDS');
    const repeat = finite(tuple[3]);
    if (
      !Number.isInteger(repeat) ||
      Object.is(repeat, -0) ||
      repeat < -1 ||
      repeat > SCHEDULE_V1_INT32_MAX
    ) {
      fail('LMP_BOUNDS');
    }
    const direction = unsignedInteger(tuple[4], DIRECTION_MAX) as MotionProgramDirectionV1;
    const repeatDelayMs = finite(tuple[5]);
    if (repeatDelayMs < 0) fail('LMP_BOUNDS');
    if (!isScheduleV1Representable(startMs, durationMs, repeat, repeatDelayMs)) {
      fail('LMP_BOUNDS');
    }
    const composite = unsignedInteger(tuple[6], COMPOSITE_MAX) as MotionProgramCompositeV1;
    if (composite !== MOTION_PROGRAM_COMPOSITE_V1.replace) {
      // Additive algebra принадлежит свойству хоста; V1 не притворяется, что
      // цвет, transform и layout складываются одинаково на всех платформах.
      features.mask |= MOTION_PROGRAM_FEATURE_V1.hostExtensions;
    }
    const segments = parseSegments(
      tuple[7],
      stringsLength,
      curvesLength,
      bindings[binding]![1],
      budget,
      features,
    );
    tracks[i] = Object.freeze([
      binding,
      startMs,
      durationMs,
      repeat,
      direction,
      repeatDelayMs,
      composite,
      segments,
    ] as const);
  }
  for (let i = 0; i < bindingUse.length; i++) {
    if (bindingUse[i] === 0) fail('LMP_CANONICAL');
  }
  return Object.freeze(tracks);
}

/**
 * Разбирает недоверенные данные, не читая element-accessors обычных массивов,
 * и возвращает свой чистый граф. Proxy traps являются исполняемым host-кодом;
 * их броски нормализуются, но сам trap неизбежен по ECMAScript.
 * Повторные offsets — намеренные скачки нулевой ширины; убывающие offsets запрещены.
 */
export function parseMotionProgramV1(input: unknown): MotionProgramV1 {
  if (ownArrayLength(input) !== 6) fail('LMP_SHAPE');
  const root = input as readonly unknown[];
  if (ownArrayValue(root, 0) !== MOTION_PROGRAM_VERSION_V1) fail('LMP_VERSION');
  const requiredFeatures = unsignedInteger(ownArrayValue(root, 1), UINT32_MAX);
  if ((requiredFeatures & ~MOTION_PROGRAM_SUPPORTED_FEATURES_V1) !== 0) {
    fail('LMP_FEATURE');
  }

  const budget: ParseBudget = { remaining: MOTION_PROGRAM_LIMITS_V1.maxItems };
  const features: FeatureUse = { mask: 0 };
  const strings = parseStrings(ownArrayValue(root, 2), budget);
  const curves = parseCurves(ownArrayValue(root, 3), budget);
  const bindings = parseBindings(ownArrayValue(root, 4), strings.length, budget, features);
  const tracks = parseTracks(
    ownArrayValue(root, 5),
    strings.length,
    curves.length,
    bindings,
    budget,
    features,
  );
  if (requiredFeatures !== features.mask) fail('LMP_FEATURE');

  return Object.freeze([
    MOTION_PROGRAM_VERSION_V1,
    requiredFeatures,
    strings,
    curves,
    bindings,
    tracks,
  ]) as MotionProgramV1;
}
