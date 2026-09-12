import { beforeEach, describe, expect, it, vi } from 'vitest';

const parserControl = vi.hoisted(() => ({
  reciprocalEasing: 'linear(0 0%, 1 100%)',
}));

vi.mock('../src/future-layout/artifact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/future-layout/artifact.js')>();
  return {
    ...actual,
    tryCompileSurfaceArtifact: (...args: Parameters<typeof actual.tryCompileSurfaceArtifact>) => {
      const artifact = actual.tryCompileSurfaceArtifact(...args);
      if (artifact === undefined) return undefined;
      return { ...artifact, reciprocalEasing: parserControl.reciprocalEasing };
    },
  };
});

import { buildSurfaceReceipt } from '../src/future-layout/receipt.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function buildWithReciprocal(reciprocalEasing: string): () => unknown {
  parserControl.reciprocalEasing = reciprocalEasing;
  return () => buildSurfaceReceipt({ fixture: 'receipt-parser-positive-control', spring: SPRING });
}

describe('surface receipt parser fail-closed positive controls', () => {
  beforeEach(() => {
    parserControl.reciprocalEasing = 'linear(0 0%, 1 100%)';
  });

  it('отвергает единственный stop', () => {
    expect(buildWithReciprocal('linear(0 0%)')).toThrow('недостаточно linear()-stops');
  });

  it('отвергает нечисловое значение', () => {
    expect(buildWithReciprocal('linear(nope 0%, 1 100%)')).toThrow('нечисловой linear()-stop');
  });

  it('отвергает нечисловую позицию', () => {
    expect(buildWithReciprocal('linear(0 nope%, 1 100%)')).toThrow('нечисловой linear()-stop');
  });

  it('отвергает позицию вне 0..100', () => {
    expect(buildWithReciprocal('linear(0 -1%, 1 100%)')).toThrow('позиции linear()-stops не возрастают');
  });

  it('отвергает повторяющиеся позиции', () => {
    expect(buildWithReciprocal('linear(0 0%, 0.5 50%, 0.6 50%, 1 100%)'))
      .toThrow('позиции linear()-stops не возрастают');
  });

  it('отвергает убывающие позиции', () => {
    expect(buildWithReciprocal('linear(0 0%, 0.6 60%, 0.5 50%, 1 100%)'))
      .toThrow('позиции linear()-stops не возрастают');
  });

  it('отвергает отсутствующий начальный endpoint', () => {
    expect(buildWithReciprocal('linear(0 1%, 1 100%)')).toThrow('linear()-endpoints не 0/100');
  });

  it('отвергает отсутствующий конечный endpoint', () => {
    expect(buildWithReciprocal('linear(0 0%, 1 99%)')).toThrow('linear()-endpoints не 0/100');
  });
});
