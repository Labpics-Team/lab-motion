/**
 * compiler/vite.ts — Vite/Rollup-адаптер build-time lowering (#208).
 *
 * `motionCompiler()` — build-tool entry (не runtime-tier): transform-hook
 * парсит модуль штатным `this.parse` (acorn Rollup), передаёт ESTree ядру
 * (§13.5: ядро parse-независимо) и применяет байтовые правки.
 *
 * Sourcemap строится двухуказательным проходом по отсортированным правкам:
 * сохранённые байты исходника идут сегмент-в-сегмент (включая многострочные
 * вызовы, чьи правки СХЛОПЫВАЮТ строки), замена целиком отображается в начало
 * своей правки, а дописанный в конец hoisted-импорт executor остаётся
 * неотображённым (это не пользовательский код). `sources` обязан нести id
 * модуля: пустой источник Vite нормализует в null, и композиция карт теряла
 * бы все маппинги последующих трансформов.
 */

import {
  COMPILED_IMPORT_NAME,
  nanoArtifactLiteral,
  planNanoLowering,
  type AstNode,
  type NanoLoweringEdit,
} from '../core.js';

interface TransformResult {
  readonly code: string;
  readonly map: {
    readonly version: 3;
    readonly mappings: string;
    readonly sources: readonly string[];
    readonly sourcesContent: readonly string[];
    readonly names: readonly string[];
  };
}

interface RollupTransformContext {
  parse(code: string): unknown;
}

/** Квитанция build-репорта (#237): факты понижения одного билда. */
export interface MotionBudgetReport {
  /** Понижено вызовов (по всем модулям билда). */
  readonly lowered: number;
  /** Осталось рантаймовых вызовов nano-animate (включая @motion-runtime). */
  readonly runtimeCalls: number;
  /** Суммарная длина инъецированных артефакт-литералов, символы исходника. */
  readonly artifactChars: number;
}

/** Опции плагина (#237). */
export interface MotionCompilerOptions {
  /**
   * Любой непониженный nano-вызов — ошибка сборки с файлом, позицией и
   * причиной. Гарантия «./nano физически не в бандле». Легитимно-динамический
   * вызов помечается блочным комментарием `@motion-runtime` вплотную перед ним.
   */
  readonly strict?: boolean | undefined;
  /** Колбэк квитанции по завершении билда (buildEnd). */
  readonly onBudget?: ((report: MotionBudgetReport) => void) | undefined;
}

/** Минимальный структурный контракт плагина: не тянем типы vite в d.ts. */
export interface MotionCompilerPlugin {
  readonly name: string;
  readonly enforce: 'pre';
  transform(
    this: RollupTransformContext,
    code: string,
    id: string,
  ): TransformResult | undefined;
  buildEnd(): void;
}

const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value: number): string {
  let signed = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = signed & 31;
    signed >>>= 5;
    if (signed > 0) digit |= 32;
    out += VLQ[digit]!;
  } while (signed > 0);
  return out;
}

/**
 * Точная карта версии 3 для applyEdits того же списка правок: генерируемый и
 * исходный курсоры идут парой; правка продвигает исходный курсор (возможно,
 * через строки — многострочный вызов), а генерируемый — на длину замены.
 * Замены не содержат '\n' по построению (артефакт-литерал одной строкой) —
 * нарушение равно ошибке сборки, не тихой порче карты.
 */
function buildMap(
  code: string,
  edits: readonly NanoLoweringEdit[],
  id: string,
): TransformResult['map'] {
  for (const edit of edits) {
    if (edit.replacement.includes('\n')) {
      throw new Error('lab-motion compiler: замена не может содержать перевод строки');
    }
  }
  const groups: string[][] = [[]];
  let genColumn = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let previousGenColumn = 0;
  let previousLine = 0;
  let previousColumn = 0;
  const segment = (): void => {
    groups.at(-1)!.push(
      vlq(genColumn - previousGenColumn) + vlq(0) +
      vlq(originalLine - previousLine) + vlq(originalColumn - previousColumn),
    );
    previousGenColumn = genColumn;
    previousLine = originalLine;
    previousColumn = originalColumn;
  };
  /** Пройти сохранённый диапазон исходника: оба курсора синхронно. */
  const keep = (from: number, to: number): void => {
    if (from < to) segment();
    for (let index = from; index < to; index++) {
      if (code.charCodeAt(index) === 10) {
        groups.push([]);
        genColumn = 0;
        previousGenColumn = 0;
        originalLine++;
        originalColumn = 0;
        if (index + 1 < to) segment();
      } else {
        genColumn++;
        originalColumn++;
      }
    }
  };
  /** Пройти правку: исходный курсор до edit.end, замена — в генерируемый. */
  const splice = (edit: NanoLoweringEdit): void => {
    segment();
    genColumn += edit.replacement.length;
    for (let index = edit.start; index < edit.end; index++) {
      if (code.charCodeAt(index) === 10) {
        originalLine++;
        originalColumn = 0;
      } else originalColumn++;
    }
  };
  let cursor = 0;
  for (const edit of edits) {
    keep(cursor, edit.start);
    splice(edit);
    cursor = edit.end;
  }
  keep(cursor, code.length);
  // Хвостовой перевод строки + строка импорта + финальный перевод строки:
  // hoisted-импорт executor не мапится в пользовательский исходник.
  groups.push([], []);
  return {
    version: 3,
    mappings: groups.map((group) => group.join(',')).join(';'),
    sources: [id],
    sourcesContent: [code],
    names: [],
  };
}

function applyEdits(code: string, edits: readonly NanoLoweringEdit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += code.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return out + code.slice(cursor);
}

/** Быстрый отсев до парсинга: модуль вообще не упоминает nano-субпуть. */
const QUICK_FILTER = '@labpics/motion/nano';

/** 0-базные line:col по байтовому offset (для strict-диагностики). */
function positionAt(code: string, offset: number): string {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (code.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return `${line}:${offset - lineStart + 1}`;
}

export function motionCompiler(options: MotionCompilerOptions = {}): MotionCompilerPlugin {
  let lowered = 0;
  let runtimeCalls = 0;
  let artifactChars = 0;
  return {
    name: 'lab-motion:nano-lowering',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('\0') || !code.includes(QUICK_FILTER)) return undefined;
      let program: unknown;
      try {
        program = this.parse(code);
      } catch {
        return undefined; // не наш синтаксис — пусть падает штатный пайплайн
      }
      const plan = planNanoLowering(program as AstNode, code, nanoArtifactLiteral);
      if (plan === undefined) return undefined;
      if (options.strict === true && plan.refusals.length > 0) {
        const [first] = plan.refusals;
        throw new Error(
          `lab-motion compiler strict: непониженный nano-вызов ${id}:${positionAt(code, first!.start)} — ` +
          `${first!.reason}. Сознательно рантаймовый вызов пометьте /* @motion-runtime */ вплотную перед ним.`,
        );
      }
      runtimeCalls += plan.runtimeCalls;
      if (plan.edits.length === 0) return undefined; // только отказы — без трансформа
      lowered += plan.edits.length / 2;
      for (const edit of plan.edits) artifactChars += edit.replacement.length;
      const transformed = applyEdits(code, plan.edits) +
        `\nimport { ${COMPILED_IMPORT_NAME} as ${plan.importLocal} } from ${JSON.stringify(plan.importSource)};\n`;
      return { code: transformed, map: buildMap(code, plan.edits, id) };
    },
    buildEnd() {
      options.onBudget?.({ lowered, runtimeCalls, artifactChars });
    },
  };
}
