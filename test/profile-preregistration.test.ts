import { describe, expect, it } from 'vitest';
import { PROFILE_PREREGISTRATION } from '../bench/profile/preregistration.mjs';
import {
  eligibleDesktopCells,
  validateCalibrationReceipt,
  validateDesktopInventory,
  validatePoweredDesignReceipt,
  validatePreregistration,
} from '../bench/profile/validate.mjs';

const copy = <T>(value: T): T => structuredClone(value);
const hash = '0'.repeat(64);
const engines = ['chromium', 'firefox', 'webkit'] as const;

const clusters = (value: number) => Array.from({ length: 20 }, (_, run) => ({
  run,
  samples: [value, value, value],
  semantic: true,
}));

const inventory = () => ({
  schemaVersion: 1,
  profileId: PROFILE_PREREGISTRATION.profileId,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  generatedAt: '2026-09-15T03:30:00.000Z',
  host: { platform: 'linux', release: 'fixture', arch: 'x64', node: 'v22.0.0' },
  browsers: engines.map(engine => ({
    engine,
    version: 'fixture',
    playwrightVersion: '1.61.1',
    executableSha256: hash,
    launchMode: 'headless',
    userAgent: `fixture-${engine}`,
    platform: 'Linux x86_64',
    devicePixelRatio: 2,
    viewport: { width: 390, height: 844 },
    refreshTargetHz: 60,
  })),
});

const calibration = () => ({
  schemaVersion: 1,
  profileId: PROFILE_PREREGISTRATION.profileId,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  calibrationId: 'fixture-calibration-1',
  attempt: 1,
  raw: {
    aa: engines.map(engine => ({
      engine,
      interval: { ratio: 1, lower95: 1, upper95: 1 },
      clusters: { a: clusters(10), b: clusters(10) },
    })),
    deliberate2x: engines.map(engine => ({
      engine,
      interval: { ratio: 2, lower95: 2, upper95: 2 },
      clusters: { single: clusters(10), doubled: clusters(20) },
    })),
  },
  aa: { lower95: 1, upper95: 1 },
  deliberate2x: { workMultiplier: 2, lower95: 2 },
  candidateSamples: 0,
  status: 'PASS',
});

const poweredDesign = () => ({
  schemaVersion: 1,
  profileId: PROFILE_PREREGISTRATION.profileId,
  baselineRevision: PROFILE_PREREGISTRATION.baseline.revision,
  designId: 'fixture-powered-design-1',
  generatedAt: '2026-09-15T03:31:00.000Z',
  candidateSamples: 0,
  pilotArtifactSha256: hash,
  methodologyBlob: PROFILE_PREREGISTRATION.baseline.methodologyBlob,
  cells: ['desktop-chromium', 'desktop-firefox', 'desktop-webkit'].map(id => ({
    id,
    chosenIndependentBlocks: 20,
    practicalRelativeThreshold: 0.05,
    estimatedPower: 0.9,
    pilotKind: 'null-control',
  })),
});

function setAaRatio(receipt: ReturnType<typeof calibration>, left: number, right: number): void {
  const ratio = left / right;
  for (const entry of receipt.raw.aa) {
    entry.interval = { ratio, lower95: ratio, upper95: ratio };
    entry.clusters = { a: clusters(left), b: clusters(right) };
  }
  receipt.aa = { lower95: ratio, upper95: ratio };
}

function setDeliberateRatio(receipt: ReturnType<typeof calibration>, doubled: number, single: number): void {
  const ratio = doubled / single;
  for (const entry of receipt.raw.deliberate2x) {
    entry.interval = { ratio, lower95: ratio, upper95: ratio };
    entry.clusters = { single: clusters(single), doubled: clusters(doubled) };
  }
  receipt.deliberate2x.lower95 = ratio;
}

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

  it('rejects substitution of every frozen baseline blob', () => {
    for (const key of ['compareManifestBlob', 'compareLockBlob', 'methodologyBlob', 'benchmarkRunnerBlob'] as const) {
      const profile = copy(PROFILE_PREREGISTRATION) as any;
      profile.baseline[key] = '0'.repeat(40);
      expect(() => validatePreregistration(profile)).toThrow(new RegExp(`${key} drifted`));
    }
  });

  it('keeps missing physical mobile cells explicit instead of accepting emulation', () => {
    const profile = copy(PROFILE_PREREGISTRATION) as any;
    const android = profile.roster.find((cell: any) => cell.id === 'android-60');
    android.availability = 'available';
    android.binding = { source: 'desktop-throttle' };
    android.candidateEligible = true;
    expect(() => validatePreregistration(profile)).toThrow(/cannot pre-authorize|explicitly unavailable/);
  });

  it('freezes a two-stage selector whose holdout meets its declared coverage/confidence bound', () => {
    const selector = PROFILE_PREREGISTRATION.scenarioSelector;
    expect(selector.selectionFloorMs).toBe(2 * selector.formalFloorMs);
    expect(1 - selector.holdoutCoverage ** selector.holdoutProbeCount).toBeGreaterThanOrEqual(selector.holdoutConfidence);
    expect(() => validatePreregistration()).not.toThrow();

    const weakened = copy(PROFILE_PREREGISTRATION) as any;
    weakened.scenarioSelector.holdoutProbeCount = 20;
    expect(() => validatePreregistration(weakened)).toThrow(/probe counts|confidence target/);
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

  it('rejects host-OS and Playwright provenance drift', () => {
    const wrongHost = inventory() as any;
    wrongHost.host.platform = 'darwin';
    expect(() => validateDesktopInventory(wrongHost)).toThrow(/host\.platform drifted/);

    const wrongPlaywright = inventory() as any;
    wrongPlaywright.browsers[0].playwrightVersion = '1.62.0';
    expect(() => validateDesktopInventory(wrongPlaywright)).toThrow(/Playwright provenance drifted/);
  });

  it('derives calibration intervals from raw clusters instead of trusting summaries', () => {
    const receipt = calibration() as any;
    for (const cluster of receipt.raw.aa[0].clusters.a) cluster.samples = [20, 20, 20];
    expect(() => validateCalibrationReceipt(receipt)).toThrow(/drifted from raw evidence/);
  });

  it('fails closed when raw-backed A/A escapes the preregistered band', () => {
    const receipt = calibration();
    setAaRatio(receipt, 17, 16);
    expect(() => validateCalibrationReceipt(receipt)).toThrow(/A\/A escaped/);
  });

  it('fails closed when raw-backed deliberate work is not statistically visible', () => {
    const receipt = calibration();
    setDeliberateRatio(receipt, 23, 16);
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

  it('requires a powered design bound to the frozen methodology', () => {
    expect(validatePoweredDesignReceipt(poweredDesign()).cells).toHaveLength(3);
    const wrongMethod = poweredDesign() as any;
    wrongMethod.methodologyBlob = '0'.repeat(40);
    expect(() => validatePoweredDesignReceipt(wrongMethod)).toThrow(/methodology drifted/);

    const contaminated = poweredDesign() as any;
    contaminated.candidateSamples = 1;
    expect(() => validatePoweredDesignReceipt(contaminated)).toThrow(/observed candidate data/);
  });

  it('fails closed when power is self-declared without a recomputable null/control pilot', () => {
    const design = poweredDesign();
    for (const cell of design.cells) cell.estimatedPower = 1;
    expect(() => eligibleDesktopCells(inventory(), calibration(), design)).toThrow(/recomputable null\/control pilot/);
  });

  it('does not open any candidate cell without a powered design receipt', () => {
    expect(() => eligibleDesktopCells(inventory(), calibration(), undefined as any)).toThrow(/powered design/);
  });
});
