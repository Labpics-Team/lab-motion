import { describe, expect, it } from 'vitest';
import {
  summarizeBusyPoints,
  validateWebkitFreezeEvidence,
} from '../bench/compare/webkit-contract.mjs';

const points = (red: number[]) => red.map((value, index) => ({ red: value, blue: index * 10 }));
const SHA = (digit: string) => digit.repeat(64);

function report() {
  const customPoints = points(Array.from({ length: 10 }, () => 5));
  const productionPoints = points(Array.from({ length: 10 }, (_, index) => index * 10));
  return {
    schema: 1,
    generatedAt: '2026-07-13T00:00:00.000Z',
    provenance: {
      revision: 'a'.repeat(40),
      dirty: false,
      worktreeSha256: SHA('1'),
      distRuntime: { sha256: SHA('2') },
      inputs: {
        'bench/webkit-freeze.mjs': SHA('3'),
        'bench/webkit-contract.mjs': SHA('4'),
        'bench/entries/lab-native.entry.mjs': SHA('5'),
      },
      environment: {
        node: 'v24.0.0',
        pnpm: '11.11.0',
        nodeExecutableSha256: SHA('6'),
        packages: {
          esbuild: { version: '1.0.0', files: 1, sha256: SHA('7') },
          playwright: { version: '1.0.0', files: 1, sha256: SHA('8') },
          pngjs: { version: '1.0.0', files: 1, sha256: SHA('9') },
        },
      },
    },
    toolchain: {
      browser: {
        version: '26.5',
        revision: '2311',
        files: 10,
        executableSha256: SHA('a'),
        treeSha256: SHA('1'),
      },
      ffmpeg: { revision: '1011', executableSha256: SHA('b') },
      playwrightRegistry: { bundleSha256: SHA('c'), browsersManifestSha256: SHA('d') },
      adapterRuntimeSha256: SHA('e'),
    },
    customLinear: {
      browserVersion: '26.5',
      busyPoints: customPoints,
      summary: summarizeBusyPoints(customPoints),
      video: { file: 'custom-linear.webm', sha256: SHA('f') },
    },
    production: {
      browserVersion: '26.5',
      busyPoints: productionPoints,
      summary: summarizeBusyPoints(productionPoints),
      video: { file: 'production.webm', sha256: SHA('0') },
    },
  };
}

describe('WebKit freeze raw evidence', () => {
  it('recomputes control, counterfactual and production movement from frame points', () => {
    expect(() => validateWebkitFreezeEvidence(report())).not.toThrow();
  });

  it.each([
    ['derived summary', (value: any) => { value.production.summary.red.rangePx = 0; }],
    ['frozen control', (value: any) => {
      value.production.busyPoints.forEach((point: any) => { point.blue = 1; });
      value.production.summary = summarizeBusyPoints(value.production.busyPoints);
    }],
    ['moving counterfactual', (value: any) => {
      value.customLinear.busyPoints.forEach((point: any, index: number) => { point.red = index * 10; });
      value.customLinear.summary = summarizeBusyPoints(value.customLinear.busyPoints);
    }],
    ['frozen production', (value: any) => {
      value.production.busyPoints.forEach((point: any) => { point.red = 1; });
      value.production.summary = summarizeBusyPoints(value.production.busyPoints);
    }],
    ['invalid raw point', (value: any) => { value.production.busyPoints[0].red = 1.5; }],
    ['missing ffmpeg hash', (value: any) => { delete value.toolchain.ffmpeg.executableSha256; }],
    ['missing browser hash', (value: any) => { delete value.toolchain.browser.executableSha256; }],
    ['missing browser tree hash', (value: any) => { delete value.toolchain.browser.treeSha256; }],
    ['missing adapter hash', (value: any) => { delete value.toolchain.adapterRuntimeSha256; }],
    ['missing video hash', (value: any) => { delete value.production.video.sha256; }],
    ['browser version drift', (value: any) => { value.production.browserVersion = 'other'; }],
  ])('rejects %s', (_label, mutate) => {
    const value = report();
    mutate(value);
    expect(() => validateWebkitFreezeEvidence(value)).toThrow();
  });
});
