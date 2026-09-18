import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chooseCalibrationBatchCopies,
  createCalibrationReceipt,
  finalizeCalibrationReceipt,
  persistCalibrationReceipt,
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
  { aaLeft = 50, aaRight = 50, deliberate = 100, single = 50 } = {},
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
  it('выбирает реальный batch до coarse timing floor до A/A acquisition', async () => {
    const probes: number[] = [];
    const copies = await chooseCalibrationBatchCopies(async (count) => {
      probes.push(count);
      return count * 12.5;
    }, { floorMs: 40, maxCopies: 16, probeCount: 2 });

    expect(copies).toBe(4);
    expect(probes).toEqual([1, 1, 2, 2, 4, 4]);
  });

  it('fail-closed если control workload не разрешается выше timing floor', async () => {
    await expect(chooseCalibrationBatchCopies(
      async (count) => count * 2,
      { floorMs: 40, maxCopies: 8, probeCount: 2 },
    )).rejects.toThrow(/does not resolve above 40ms by 8 real work copies/);
  });

  it('возвращает только валидированный PASS receipt', () => {
    const receipt = finalizeCalibrationReceipt(
      passingCells(),
      '2026-09-18T00:00:00.000Z',
    );

    expect(receipt.status).toBe('PASS');
    expect(receipt.candidateSamples).toBe(0);
    expect(receipt.timing).toEqual({ floorMs: 40, resolved: true });
    expect(receipt.workload.timingFloorMs).toBe(40);
    expect(receipt.aa).toEqual({ lower95: 1, upper95: 1 });
    expect(receipt.deliberate2x.lower95).toBe(2);
  });

  it('не допускает sub-floor raw timing даже при идеальных ratios', () => {
    const cells = passingCells();
    cells[2] = cell('webkit', { aaLeft: 39, aaRight: 39, deliberate: 78, single: 39 });

    const receipt = createCalibrationReceipt(cells);
    expect(receipt.timing).toEqual({ floorMs: 40, resolved: false });
    expect(receipt.status).toBe('FAIL');
    expect(() => finalizeCalibrationReceipt(cells)).toThrow(/calibration receipt is not admitted/);
  });

  it('не выпускает A/A FAIL как успешный артефакт', () => {
    const cells = passingCells();
    cells[0] = cell('chromium', { aaLeft: 53, aaRight: 50 });

    expect(createCalibrationReceipt(cells).status).toBe('FAIL');
    expect(() => finalizeCalibrationReceipt(cells)).toThrow(/A\/A escaped/);
  });

  it('сохраняет raw FAIL до fail-closed admission', async () => {
    const cells = passingCells();
    cells[0] = cell('chromium', { aaLeft: 53, aaRight: 50 });
    const dir = await mkdtemp(join(tmpdir(), 'lab-motion-profile-calibration-'));
    const output = join(dir, 'calibration.json');

    try {
      await expect(persistCalibrationReceipt(cells, output)).rejects.toThrow(/A\/A escaped/);
      const receipt = JSON.parse(await readFile(output, 'utf8'));
      expect(receipt.status).toBe('FAIL');
      expect(receipt.candidateSamples).toBe(0);
      expect(receipt.raw.aa[0].clusters.a).toHaveLength(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('не выпускает неразрешимый positive control как успешный артефакт', () => {
    const cells = passingCells();
    cells[2] = cell('webkit', { deliberate: 70, single: 50 });

    expect(createCalibrationReceipt(cells).status).toBe('FAIL');
    expect(() => finalizeCalibrationReceipt(cells)).toThrow(/positive control unresolved/);
  });
});
