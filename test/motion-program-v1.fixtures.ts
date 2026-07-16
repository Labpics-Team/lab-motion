import { expect } from 'vitest';
import {
  MOTION_PROGRAM_CODEC_V1,
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  MOTION_PROGRAM_FEATURE_V1,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1,
  MotionProgramParseError,
} from '../src/internal/motion-program.js';

export const FEATURE_MASK =
  MOTION_PROGRAM_FEATURE_V1.currentValues |
  MOTION_PROGRAM_FEATURE_V1.relativeValues |
  MOTION_PROGRAM_FEATURE_V1.hostExtensions;

export function validProgramInput(): unknown[] {
  return [
    1,
    FEATURE_MASK,
    ['--lab-x', 'red'],
    [
      0,
      [1, 0, -0, 0.5, 1, 0.5, 2, 1, 3],
    ],
    [
      [0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 7],
      [1, [255, 0], 8],
      [2, MOTION_PROGRAM_STANDARD_CHANNEL_V1.backgroundColor, 9],
    ],
    [
      [
        0,
        -0,
        1_000,
        2,
        MOTION_PROGRAM_DIRECTION_V1.alternateReverse,
        -0,
        MOTION_PROGRAM_COMPOSITE_V1.replace,
        [
          [-0, 0.5, [0], [1, [0, -0]], 0, MOTION_PROGRAM_CODEC_V1.scalar],
          [0.5, 1, [2, -1, [0, 2]], [1, [0, 3]], 1, MOTION_PROGRAM_CODEC_V1.scalar],
        ],
      ],
      [
        1,
        250,
        500,
        -1,
        MOTION_PROGRAM_DIRECTION_V1.normal,
        25,
        MOTION_PROGRAM_COMPOSITE_V1.accumulate,
        [
          [0, 1, [1, [2, 1]], [1, [2, 1]], 1, MOTION_PROGRAM_CODEC_V1.webCssOpaque],
        ],
      ],
      [
        2,
        0,
        100,
        0,
        MOTION_PROGRAM_DIRECTION_V1.mirror,
        0,
        MOTION_PROGRAM_COMPOSITE_V1.add,
        [
          [
            0,
            1,
            [1, [1, 0, 0, 0, 1]],
            [1, [1, 255, 128, 64, 0.5]],
            1,
            MOTION_PROGRAM_CODEC_V1.colorGamma2,
          ],
        ],
      ],
    ],
  ];
}

export function minimalProgramInput(): unknown[] {
  return [
    1,
    0,
    [],
    [0],
    [[0, MOTION_PROGRAM_STANDARD_CHANNEL_V1.value, 0]],
    [[
      0,
      0,
      1,
      0,
      MOTION_PROGRAM_DIRECTION_V1.normal,
      0,
      MOTION_PROGRAM_COMPOSITE_V1.replace,
      [[0, 1, [1, [0, 0]], [1, [0, 1]], 0, MOTION_PROGRAM_CODEC_V1.scalar]],
    ]],
  ];
}

export function expectIssue(run: () => unknown, code: MotionProgramParseError['code']): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(MotionProgramParseError);
  expect((error as MotionProgramParseError).code).toBe(code);
  expect((error as Error).message).toBe(code);
}

export function adjacentFloat(value: number, direction: -1 | 1): number {
  if (!Number.isFinite(value)) throw new Error('expected finite f64');
  if (value === 0) return direction < 0 ? -Number.MIN_VALUE : Number.MIN_VALUE;
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, true);
  const step = value > 0 ? direction : -direction;
  view.setBigUint64(0, view.getBigUint64(0, true) + BigInt(step), true);
  return view.getFloat64(0, true);
}

export function ownPath(root: unknown, path: readonly number[]): unknown {
  let value = root;
  for (const index of path) value = (value as readonly unknown[])[index];
  return value;
}
