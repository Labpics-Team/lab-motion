/**
 * test/future-layout-receipt.test.ts — RED: proof receipt, validator и
 * meta-защита доказательств.
 *
 * Спека: «PROOF RECEIPT», «MAIN-THREAD FREEZE PROOF», «VIRTUALIZATION»;
 * RED-Фаза п.21 (size tool забывает generated CSS), п.22 (повреждённый
 * receipt принимается validator), п.23 (удаление logicalRows=10 000 из
 * fixture не ломает meta-test), п.24 (удаление rAF negative control не
 * ломает freeze proof), п.25 (удаление callback assertion не ломает proof).
 *
 * RED PROOF: src/future-layout/index.ts — заглушка `export {}`; каждый тест
 * падает СВОИМ ассертом через pick-хелпер (канон animate-facade-helpers).
 */

import { describe, expect, it } from 'vitest';
import * as surface from '../src/future-layout/index.js';

const mod = surface as unknown as Record<string, unknown>;

function pick<K extends string>(name: K): (...args: never[]) => Record<string, unknown> {
  return mod[name] as never;
}

describe('proof receipt: версия, validator, fail-closed', () => {
  it('RED п.22: валидный receipt принимается, повреждённый — отвергается', () => {
    const buildReceipt = pick('buildSurfaceReceipt');
    const validateReceipt = pick('validateSurfaceReceipt');

    const receipt = buildReceipt({ fixture: 'v1-width-240-360', spring: { mass: 1, stiffness: 170, damping: 26 } });
    expect(validateReceipt(receipt)).toBe(true);

    const corrupted = { ...(receipt as object), schemaVersion: 999, minBoundaryErrorPx: 'NaN' };
    expect(validateReceipt(corrupted)).toBe(false);
  });

  it('RED п.22: receipt фиксирует отдельный precision budget и вклады', () => {
    const buildReceipt = pick('buildSurfaceReceipt');
    const receipt = buildReceipt({ fixture: 'v1-width-240-360', spring: { mass: 1, stiffness: 170, damping: 26 } });
    // Отдельные бюджеты: spring/boundary/coupling/observer + certified bound.
    for (const key of ['authoringBudgetPx', 'certifiedBoundPx', 'denseMaximumPx', 'serializationContributionPx', 'browserObservedMaximumPx']) {
      expect(Number.isFinite((receipt as Record<string, unknown>)[key])).toBe(true);
    }
  });
});

describe('meta-tests: доказательства ломаются при ослаблении', () => {
  it('RED п.23: fixture-манифест обязан содержать logicalRows 100/10 000/1 000 000', () => {
    const fixtures = pick('surfaceFixtureManifest')();
    expect(fixtures['logicalRows']).toEqual([100, 10_000, 1_000_000]);
  });

  it('RED п.24: freeze proof обязан содержать rAF negative control', () => {
    const proof = pick('freezeProofManifest')();
    // Без negative control proof не доказывает заморозку: busy-loop двигает
    // raw WAAPI control, rAF control обязан остаться на месте.
    expect(proof['rafNegativeControl']).toBe(true);
    expect(proof['waapiPositiveControl']).toBe(true);
  });

  it('RED п.25: freeze proof обязан содержать callback assertion', () => {
    const proof = pick('freezeProofManifest')();
    expect(proof['observerCallbackAssertion']).toBe(true);
  });

  it('RED п.21: size-учёт включает generated CSS в consumer total', () => {
    const accounting = pick('surfaceSizeAccounting')();
    // Generated CSS входит в consumer total size (спека SIZE): флаг и байты.
    expect(accounting['includesGeneratedCss']).toBe(true);
    expect(Number(accounting['generatedCssBytesGzip'])).toBeGreaterThanOrEqual(0);
  });
});
