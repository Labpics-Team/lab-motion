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
import { createSurfaceCoordinator } from './coordinator.js';
import type { SpringParams } from '../spring.js';

export const SURFACE_RECEIPT_SCHEMA = 1;

export interface SurfaceReceiptInput {
  readonly fixture: string;
  readonly spring: SpringParams;
  readonly fromWidth?: number;
  readonly toWidth?: number;
  /** Реальное браузерное измерение стенда; без измерения поле отсутствует
   * (hardcode 0 был бы фальшивой точностью). */
  readonly browserObservedMaximumPx?: number;
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
  readonly browserObservedMaximumPx?: number;
}

/** Reciprocal-метрика receipts обязана совпадать с доказательством артефакта
 * (src/future-layout/artifact.ts): производственная ошибка сопряжения на
 * контенте шириной W_j — W(t)·W_j·|Δ|·|Q̂−Q|, Δ = 1/W1 − 1/W0; сертифицированный
 * предел сегмента — W_max·W_content·(h²/8)·2β²/W_min³, β = |ΔW|/h (ширина
 * линейна внутри сегмента serialized P). Ширина в stop-точке Q восстанавливается
 * из самого Q: W = 1/(1/W0 + Q·Δ) — receipt читает ТОЛЬКО serialized Q. */

function widthFromQ(q: number, fromWidth: number, delta: number): number {
  return 1 / (1 / fromWidth + q * delta);
}

/** Сертифицированный верхний предел кусочно-линейной аппроксимации reciprocal
 * на stop-сетке Q: максимум per-segment предела по всему Q-ряду. */
function certifiedReciprocalBoundPx(
  reciprocalSamples: Float64Array,
  fromWidth: number,
  toWidth: number,
): number {
  const delta = 1 / toWidth - 1 / fromWidth;
  if (delta === 0) return 0;
  const contentW = Math.max(fromWidth, toWidth);
  const stopCount = reciprocalSamples.length / 2;
  let maxBound = 0;
  for (let i = 1; i < stopCount; i++) {
    const h = Math.abs(reciprocalSamples[i * 2]! - reciprocalSamples[(i - 1) * 2]!);
    if (h === 0) continue;
    const wA = widthFromQ(reciprocalSamples[(i - 1) * 2 + 1]!, fromWidth, delta);
    const wB = widthFromQ(reciprocalSamples[i * 2 + 1]!, fromWidth, delta);
    const wMin = Math.min(wA, wB);
    if (wMin <= 0) return Number.POSITIVE_INFINITY;
    const maxW = Math.max(wA, wB);
    const beta = Math.abs(wB - wA) / h;
    const bound = maxW * contentW * (h * h / 8) * (2 * beta * beta) / (wMin * wMin * wMin);
    if (bound > maxBound) maxBound = bound;
  }
  return maxBound;
}

/** Плотный независимый скан: максимум отклонения Q̂ (интерполяция stop-сетки)
 * от точного Q = (1/W(u) − 1/W0)/Δ, где W(u) — serialized P (линейная
 * интерполяция progress между stops пружины), в 1001 равномерной точке.
 * Ошибка переводится в CSS px производственной формулой maxW·contentW·|Δ|. */
function denseReciprocalMaximumPx(
  reciprocalSamples: Float64Array,
  samples: Float64Array,
  fromWidth: number,
  toWidth: number,
): number {
  const delta = 1 / toWidth - 1 / fromWidth;
  const qStopCount = reciprocalSamples.length / 2;
  const pStopCount = samples.length / 2;
  if (qStopCount < 2 || pStopCount < 2 || delta === 0) return 0;
  const contentW = Math.max(fromWidth, toWidth);
  const progressAt = (u: number): number => {
    let lo = 0;
    while (lo < pStopCount - 2 && samples[(lo + 1) * 2]! <= u) lo++;
    const x0 = samples[lo * 2]!;
    const x1 = samples[(lo + 1) * 2]!;
    const p0 = samples[lo * 2 + 1]!;
    const p1 = samples[(lo + 1) * 2 + 1]!;
    const t = x1 === x0 ? 0 : (u - x0) / (x1 - x0);
    return p0 + (p1 - p0) * t;
  };
  let maxError = 0;
  let qLo = 0;
  for (let probe = 0; probe <= 1000; probe++) {
    const u = probe / 10; // percent 0..100
    while (qLo < qStopCount - 2 && reciprocalSamples[(qLo + 1) * 2]! <= u) qLo++;
    const p0 = reciprocalSamples[qLo * 2]!;
    const p1 = reciprocalSamples[(qLo + 1) * 2]!;
    const q0 = reciprocalSamples[qLo * 2 + 1]!;
    const q1 = reciprocalSamples[(qLo + 1) * 2 + 1]!;
    const t = p1 === p0 ? 0 : (u - p0) / (p1 - p0);
    const approx = q0 + (q1 - q0) * t;
    const w = fromWidth + (toWidth - fromWidth) * progressAt(u);
    if (!(w > 0)) return Number.POSITIVE_INFINITY;
    const exact = (1 / w - 1 / fromWidth) / delta;
    // Производственная ошибка: W(t)·W_content·|Δ|·|Q̂−Q| (W(t) — фактическая
    // ширина в точке, не глобальный максимум).
    const errorPx = w * contentW * Math.abs(delta) * Math.abs(approx - exact);
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
  const observed = input.browserObservedMaximumPx;
  if (observed !== undefined
    && (!Number.isFinite(observed) || observed < 0 || observed > SURFACE_PRECISION_BUDGET_PX)) {
    throw new Error('surface receipt: browserObservedMaximumPx вне бюджета/нефинитно (fail-closed)');
  }
  const generatedCss = artifact.easing + artifact.reciprocalEasing + artifact.blendEasing;
  const certifiedBoundPx = certifiedReciprocalBoundPx(artifact.reciprocalSamples, fromWidth, toWidth);
  const denseMaximumPx = denseReciprocalMaximumPx(
    artifact.reciprocalSamples,
    artifact.samples as Float64Array,
    fromWidth,
    toWidth,
  );
  const receipt: SurfaceReceipt = {
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
  };
  if (observed !== undefined) {
    return { ...receipt, browserObservedMaximumPx: observed };
  }
  return receipt;
}

const RECEIPT_NUMBER_KEYS = [
  'fromWidth', 'toWidth', 'pStops', 'qStops', 'aStops', 'durationMs',
  'generatedCssBytes', 'authoringBudgetPx', 'certifiedBoundPx',
  'denseMaximumPx', 'serializationContributionPx',
] as const;

const RECEIPT_KNOWN_KEYS = new Set<string>([
  'schema', 'fixture', 'metric', 'browserObservedMaximumPx', ...RECEIPT_NUMBER_KEYS,
]);

/** Independent validator: fail-closed. Строгая схема (лишние поля — отказ:
 * повреждённый/дорисованный вручную receipt не проходит), конечность всех
 * чисел, бюджет соблюдён сертифицированным пределом. browserObservedMaximumPx
 * опционален (отсутствие = стенд не измерял), но при наличии обязан быть
 * конечным неотрицательным числом внутри бюджета. Precision-метрики в CSS px
 * физически неотрицательны и не могут превышать бюджет: отрицательное или
 * сверхбюджетное значение — подделка, отказ. */
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
  const budget = record['authoringBudgetPx'] as number;
  if (budget < 0) return false;
  for (const key of ['certifiedBoundPx', 'denseMaximumPx', 'serializationContributionPx'] as const) {
    const value = record[key] as number;
    if (value < 0 || value > budget) return false;
  }
  const observed = record['browserObservedMaximumPx'];
  if (observed !== undefined
    && (typeof observed !== 'number' || !Number.isFinite(observed)
      || observed < 0 || observed > budget)) {
    return false;
  }
  return true;
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
 * вычисляются из фактического CSS координатора, не декларируются
 * (hardcoded-дубликат hostCss дрейфовал бы от production-кода). */
export function surfaceSizeAccounting(): Record<string, unknown> {
  const coordinator = createSurfaceCoordinator();
  const generation = coordinator.begin({ target: {}, fromWidth: 240, toWidth: 360 });
  const css = generation.generatedCss;
  return {
    includesGeneratedCss: true,
    generatedCssBytesGzip: gzipSync(Buffer.from(css, 'utf8'), { level: 9 }).length,
    generatedCssBytesRaw: css.length,
  };
}
