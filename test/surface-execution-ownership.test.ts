import { describe, expect, it } from 'vitest';
import { buildSurfaceReceipt, tryCompileSurfaceArtifact } from '../src/future-layout/index.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

describe('SurfaceExecutionArtifact владеет только исполняемым представлением', () => {
  it('не удерживает Q/A как вторые numeric-копии canonical CSS', () => {
    const artifact = tryCompileSurfaceArtifact(SPRING, 240, 360);
    expect(artifact).toBeDefined();
    const record = artifact as unknown as Record<string, unknown>;

    expect(Object.hasOwn(record, 'reciprocalSamples')).toBe(false);
    expect(Object.hasOwn(record, 'blendSamples')).toBe(false);
    expect(record['reciprocalEasing']).toMatch(/^linear\(.+\)$/);
    expect(record['blendEasing']).toMatch(/^linear\(.+\)$/);
  });

  it('diagnostics receipt восстанавливает Q/A stop-count из execution CSS', () => {
    const artifact = tryCompileSurfaceArtifact(SPRING, 240, 360)!;
    const qStops = artifact.reciprocalEasing.slice(7, -1).split(',').length;
    const aStops = artifact.blendEasing.slice(7, -1).split(',').length;
    const receipt = buildSurfaceReceipt({ fixture: 'execution-only-owner', spring: SPRING });

    expect(receipt.qStops).toBe(qStops);
    expect(receipt.aStops).toBe(aStops);
    expect(receipt.qStops).toBe(receipt.aStops);
    expect(receipt.certifiedBoundPx).toBeLessThanOrEqual(receipt.authoringBudgetPx);
    expect(receipt.denseMaximumPx).toBeLessThanOrEqual(receipt.authoringBudgetPx);
  });
});
