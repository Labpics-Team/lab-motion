import { describe, expect, it } from 'vitest';
import {
  createCalibrationReceipt,
  finalizeCalibrationReceipt,
} from '../bench/profile/calibrate-desktop.mjs';

const engines = ['chromium', 'firefox', 'webkit'] as const;

function clusters(value: number) {
  return Array.from({ length: 20 }, (_, run) => ({
    run,
    samples: [value, value, value],
    semantic: true,
  }));
}

function cell(
  engine: typeof engines[number],
  { aaLeft = 10, aaRight = 10, deliberate = 20, single = 10 } = {},
) {
  const aaRatio = aaLeft / aaRight;
  const deliberateRatio = deliberate / single;
  return {
    engine,
    browserVersion: 'fixture',
    aa: { ratio: aaRatio, lower95: aaRatio, upper95: aaRatio },
    deliberate2x: {
      ratio: deliberateRatio,
      lower95: deliberateRatio,
      upper95: deliberateRatio,
    },
    raw: {
      aa: { a: clusters(aaLeft), b: clusters(aaRight) },
      deliberate2x: { single: clusters(single), doubled: clusters(deliberate) },
    },
  };
}

function passingCells() {
  return engines.map(engine => cell(engine));
}

describe('PROFILE-01 calibration generator boundary', () => {
  it('возвращает только валидированный PASS receipt', () => {
    const receipt = finalizeCalibrationReceipt(
      passingCells(),
      '2026-09-18T00:00:00.000Z',
    );

    expect(receipt.status).toBe('PASS');
    expect(receipt.candidateSamples).toBe(0);
    expect(receipt.aa).toEqual({ lower95: 1, upper95: 1 });
    expect(receipt.deliberate2x.lower95).toBe(2);
  });

  it('не выпускает A/A FAIL как успешный артефакт', () => {
    const cells = passingCells();
    cells[0] = cell('chromium', { aaLeft: 106, aaRight: 100 });

    expect(createCalibrationReceipt(cells).status).toBe('FAIL');
    expect(() => finalizeCalibrationReceipt(cells)).toThrow(/A\/A escaped/);
  });

  it('не выпускает неразрешимый positive control как успешный артефакт', () => {
    const cells = passingCells();
    cells[2] = cell('webkit', { deliberate: 14, single: 10 });

    expect(createCalibrationReceipt(cells).status).toBe('FAIL');
    expect(() => finalizeCalibrationReceipt(cells)).toThrow(/positive control unresolved/);
  });
});
