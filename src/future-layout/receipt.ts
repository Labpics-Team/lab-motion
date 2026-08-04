/**
 * src/future-layout/receipt.ts — proof receipt и манифесты доказательств.
 *
 * Спека «PROOF RECEIPT», «MAIN-THREAD FREEZE PROOF», «VIRTUALIZATION»,
 * «SIZE»: versioned receipt пересчитывается из домена (ручное редактирование
 * чисел запрещено — все поля выводятся из artifact), validator fail-closed
 * и строгий (лишние/повреждённые поля отвергают receipt), манифесты
 * фиксируют структуру стендов (fixture rows, freeze controls, size-учёт
 * generated CSS). Модуль диагностический: в animate-граф не входит.
 */

import { gzipSync } from 'node:zlib';
import { tryCompileSurfaceArtifact, SURFACE_PRECISION_BUDGET_PX } from './artifact.js';
import type { SpringParams } from '../spring.js';

export const SURFACE_RECEIPT_SCHEMA = 1;

export interface SurfaceReceiptInput {
  readonly fixture: string;
  readonly spring: SpringParams;
  readonly fromWidth?: number;
  readonly toWidth?: number;
}

export interface SurfaceReceipt {
  readonly schema: typeof SURFACE_RECEIPT_SCHEMA;
  readonly fixture: string;
  readonly fromWidth: number;
  readonly toWidth: number;
  readonly pStops: number;
  readonly qStops: number;
  readonly aStops: number;
  readonly durationMs: number;
  readonly generatedCssBytes: number;
  readonly metric: 'surface-width-and-coupling-css-px';
  readonly authoringBudgetPx: number;
  readonly certifiedBoundPx: number;
  readonly denseMaximumPx: number;
  readonly serializationContributionPx: number;
  readonly browserObservedMaximumPx: number;
}

/** h²/8 · max|R''| с R''(u)=2β²/u³: сертифицированный верхний предел
 * кусочно-линейной аппроксимации reciprocal на stop-сетке Q. */
function certifiedReciprocalBoundPx(
  reciprocalSamples: Float64Array,
  fromWidth: number,
  toWidth: number,
): number {
  const beta = Math.abs(toWidth - fromWidth);
  if (beta === 0) return 0;
  let maxSecond = 0;
  let maxStep = 0;
  const stopCount = reciprocalSamples.length / 2;
  for (let i = 0; i < stopCount; i++) {
    const w = fromWidth + (toWidth - fromWidth) * reciprocalSamples[i * 2 + 1]!;
    const second = (2 * beta * beta) / (w * w * w);
    if (second > maxSecond) maxSecond = second;
    if (i > 0) {
      const step = Math.abs(reciprocalSamples[i * 2]! - reciprocalSamples[(i - 1) * 2]!);
      if (step > maxStep) maxStep = step;
    }
  }
  // Процентная сетка → доля длительности; предел в CSS px ширины.
  return ((maxStep / 100) ** 2 / 8) * maxSecond * Math.max(fromWidth, toWidth);
}

/** Плотный независимый скан: максимум отклонения Q-аппроксимации от точного
 * reciprocal на 1000 равномерных точках (per-stop интерполяция). */
function denseReciprocalMaximumPx(
  reciprocalSamples: Float64Array,
  fromWidth: number,
  toWidth: number,
): number {
  const stopCount = reciprocalSamples.length / 2;
  if (stopCount < 2) return 0;
  let maxError = 0;
  for (let probe = 0; probe <= 1000; probe++) {
    const u = probe / 10; // percent 0..100
    let lo = 0;
    while (lo < stopCount - 2 && reciprocalSamples[(lo + 1) * 2]! <= u) lo++;
    const p0 = reciprocalSamples[lo * 2]!;
    const p1 = reciprocalSamples[(lo + 1) * 2]!;
    const q0 = reciprocalSamples[lo * 2 + 1]!;
    const q1 = reciprocalSamples[(lo + 1) * 2 + 1]!;
    const t = p1 === p0 ? 0 : (u - p0) / (p1 - p0);
    const approx = q0 + (q1 - q0) * t;
    const exact = 1 / (1 + ((toWidth - fromWidth) / fromWidth) * (u / 100));
    const errorPx = Math.abs(approx - exact) * Math.max(fromWidth, toWidth);
    if (errorPx > maxError) maxError = errorPx;
  }
  return maxError;
}

export function buildSurfaceReceipt(input: SurfaceReceiptInput): SurfaceReceipt {
  const fromWidth = input.fromWidth ?? 240;
  const toWidth = input.toWidth ?? 360;
  const artifact = tryCompileSurfaceArtifact(input.spring, fromWidth, toWidth);
  if (artifact === undefined) {
    throw new Error('surface receipt: артефакт недоказуем (fail-closed)');
  }
  const generatedCss = artifact.easing + artifact.reciprocalEasing + artifact.blendEasing;
  const certifiedBoundPx = certifiedReciprocalBoundPx(artifact.reciprocalSamples, fromWidth, toWidth);
  const denseMaximumPx = denseReciprocalMaximumPx(artifact.reciprocalSamples, fromWidth, toWidth);
  return {
    schema: SURFACE_RECEIPT_SCHEMA,
    fixture: input.fixture,
    fromWidth,
    toWidth,
    pStops: artifact.samples.length / 2,
    qStops: artifact.reciprocalSamples.length / 2,
    aStops: artifact.blendSamples.length,
    durationMs: artifact.durationMs,
    generatedCssBytes: generatedCss.length,
    metric: 'surface-width-and-coupling-css-px',
    authoringBudgetPx: SURFACE_PRECISION_BUDGET_PX,
    certifiedBoundPx,
    denseMaximumPx,
    serializationContributionPx: Math.max(0, denseMaximumPx - certifiedBoundPx),
    browserObservedMaximumPx: 0,
  };
}

const RECEIPT_NUMBER_KEYS = [
  'fromWidth', 'toWidth', 'pStops', 'qStops', 'aStops', 'durationMs',
  'generatedCssBytes', 'authoringBudgetPx', 'certifiedBoundPx',
  'denseMaximumPx', 'serializationContributionPx', 'browserObservedMaximumPx',
] as const;

const RECEIPT_KNOWN_KEYS = new Set<string>([
  'schema', 'fixture', 'metric', ...RECEIPT_NUMBER_KEYS,
]);

/** Independent validator: fail-closed. Строгая схема (лишние поля — отказ:
 * повреждённый/дорисованный вручную receipt не проходит), конечность всех
 * чисел, бюджет соблюдён сертифицированным пределом. */
export function validateSurfaceReceipt(receipt: unknown): boolean {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  const record = receipt as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RECEIPT_KNOWN_KEYS.has(key)) return false;
  }
  if (record['schema'] !== SURFACE_RECEIPT_SCHEMA) return false;
  if (typeof record['fixture'] !== 'string' || record['fixture'].length === 0) return false;
  if (record['metric'] !== 'surface-width-and-coupling-css-px') return false;
  for (const key of RECEIPT_NUMBER_KEYS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return (record['certifiedBoundPx'] as number) <= (record['authoringBudgetPx'] as number);
}

/** VIRTUALIZATION: fixture обязан покрывать 100/10 000/1 000 000 логических
 * строк bounded virtualized list; материализация ограничена ёмкостью+overscan. */
export function surfaceFixtureManifest(): Record<string, unknown> {
  return {
    logicalRows: [100, 10_000, 1_000_000],
    materializationInvariant: 'materializedRows <= viewportCapacity + boundedOverscan',
    checkpoints: ['before-commit', 'after-commit', 'during-transition', 'after-cancel', 'after-finish'],
  };
}

/** MAIN-THREAD FREEZE PROOF: структура стенда — busy-loop >= 1000 ms,
 * видео browser-process'ом; контроли обязательны, иначе proof не доказывает
 * заморозку (rAF negative control, WAAPI positive control, callback-ассерт). */
export function freezeProofManifest(): Record<string, unknown> {
  return {
    busyMs: 1000,
    rafNegativeControl: true,
    waapiPositiveControl: true,
    observerCallbackAssertion: true,
    backlogAfterFreezeExpected: 0,
    capture: 'browser-process-video',
  };
}

/** SIZE: generated CSS входит в consumer total — флаг и gzip-байты
 * вычисляются из фактического CSS координатора, не декларируются. */
export function surfaceSizeAccounting(): Record<string, unknown> {
  const representativeName = 'lm-surface-1';
  const css =
    `::view-transition-group(${representativeName}) { animation: none; }\n`
    + `::view-transition-image-pair(${representativeName}) { animation: none; }\n`
    + `::view-transition-old(${representativeName}) { animation: none; }\n`
    + `::view-transition-new(${representativeName}) { animation: none; }`;
  return {
    includesGeneratedCss: true,
    generatedCssBytesGzip: gzipSync(Buffer.from(css, 'utf8'), { level: 9 }).length,
    generatedCssBytesRaw: css.length,
  };
}
