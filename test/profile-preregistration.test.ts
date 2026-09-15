import { describe, expect, it } from 'vitest';
import { PROFILE_PREREGISTRATION } from '../bench/profile/preregistration.mjs';
import {
  eligibleDesktopCells,
  validateCalibrationReceipt,
  validateDesktopInventory,
  validatePreregistration,
} from '../bench/profile/validate.mjs';

const copy = <T>(value: T): T => structuredClone(value);
const hash = '0'.repeat(64);

const inventory = () => ({
  schemaVersion: 1,
  profileId: PROFILE_PREREGISTRATION.profileId,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  generatedAt: '2026-09-15T03:30:00.000Z',
  host: { platform: 'linux', release: 'fixture', arch: 'x64', node: 'v22.0.0' },
  browsers: ['chromium', 'firefox', 'webkit'].map(engine => ({
    engine,
    version: 'fixture',
    executableSha256: hash,
    userAgent: `fixture-${engine}`,
    refreshTargetHz: 60,
  })),
});

const calibration = () => ({
  schemaVersion: 1,
  profileId: PROFILE_PREREGISTRATION.profileId,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  calibrationId: 'fixture-calibration-1',
  attempt: 1,
  raw: { aa: [[1, 1]], deliberate2x: [[2, 2]] },
  aa: { lower95: 0.99, upper95: 1.01 },
  deliberate2x: { workMultiplier: 2, lower95: 1.8 },
  candidateSamples: 0,
});

describe('PROFILE-01 preregistration', () => {
  it('accepts the frozen registration and exact historical ceilings', () => {
    const profile = validatePreregistration();
    expect(profile.baseline.competitors).toEqual({
      motion: '12.42.2',
      gsap: '3.15.0',
      animejs: '4.5.0',
      playwright: '1.61.1',
      esbuild: '0.28.1',
      pngjs: '7.0.0',
    });
    expect(profile.oldCostVector.gzipBytes).toEqual({
      nano: 1024,
      compilerRuntime: 341,
      compilerSurface: 1024,
      fullAnimateConsumer: 15600,
      animateCompositorMixed: 17500,
    });
  });

  it('keeps missing physical mobile cells explicit instead of accepting emulation', () => {
    const profile = copy(PROFILE_PREREGISTRATION) as any;
    const android = profile.roster.find((cell: any) => cell.id === 'android-60');
    android.availability = 'available';
    android.binding = { source: 'desktop-throttle' };
    android.candidateEligible = true;
    expect(() => validatePreregistration(profile)).toThrow(/cannot pre-authorize|explicitly unavailable/);
  });

  it('rejects a profile that turns frames into independent participants', () => {
    const profile = copy(PROFILE_PREREGISTRATION) as any;
    profile.statistics.independentUnit = 'frame';
    expect(() => validatePreregistration(profile)).toThrow(/sampling unit/);
  });

  it('rejects silently raised historical size ceilings', () => {
    const profile = copy(PROFILE_PREREGISTRATION) as any;
    profile.oldCostVector.gzipBytes.nano = 1200;
    expect(() => validatePreregistration(profile)).toThrow(/nano drifted/);
  });

  it('requires exact Chromium, Firefox and WebKit inventory bindings', () => {
    expect(validateDesktopInventory(inventory()).browsers).toHaveLength(3);
    const broken = inventory() as any;
    broken.browsers[2].version = '';
    expect(() => validateDesktopInventory(broken)).toThrow(/version missing/);
  });

  it('fails closed when A/A escapes the preregistered band', () => {
    const receipt = calibration() as any;
    receipt.aa.upper95 = 1.051;
    expect(() => validateCalibrationReceipt(receipt)).toThrow(/A\/A escaped/);
  });

  it('fails closed when deliberate 2x work is not statistically visible', () => {
    const receipt = calibration() as any;
    receipt.deliberate2x.lower95 = 1.49;
    expect(() => validateCalibrationReceipt(receipt)).toThrow(/positive control unresolved/);
  });

  it('rejects repeat-to-green and candidate contamination', () => {
    const retry = calibration() as any;
    retry.attempt = 2;
    expect(() => validateCalibrationReceipt(retry)).toThrow(/repeat-to-green/);

    const contaminated = calibration() as any;
    contaminated.candidateSamples = 1;
    expect(() => validateCalibrationReceipt(contaminated)).toThrow(/candidate data appeared/);
  });

  it('opens only the desktop cells after exact inventory and green calibration', () => {
    expect(eligibleDesktopCells(inventory(), calibration())).toEqual([
      'desktop-chromium', 'desktop-firefox', 'desktop-webkit',
    ]);
  });
});
