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
  nanoCallArtifactLiteral,
  planNanoLowering,
  planSurfaceLowering,
  type AstNode,
  type NanoLoweringEdit,
  type NanoLoweringPlan,
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
  warn(message: string): void;
}

/** Минимальный структурный контракт плагина: не тянем типы vite в d.ts. */
export interface MotionCompilerPlugin {
  readonly name: string;
  transform(
    this: RollupTransformContext,
    code: string,
    id: string,
  ): TransformResult | undefined;
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
  importCount: number,
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
  // Хвост: '\n' + N строк hoisted-импортов + '\n'. Каждый перевод строки
  // открывает новую группу; импорты executor'ов не маппятся в исходник.
  for (let i = 0; i <= importCount; i++) groups.push([]);
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

/** Быстрый отсев до парсинга: модуль вообще не упоминает целевые субпути. */
const QUICK_FILTERS = ['@labpics/motion/nano', '@labpics/motion/animate'];

export function motionCompiler(): MotionCompilerPlugin {
  return {
    name: 'lab-motion:lowering',
    // Дефолтная фаза, а не enforce:'pre': до транспиляции хук получал сырой
    // TypeScript, this.parse падал, и TS/TSX-модули молча оставались без
    // lowering. После vite:oxc сюда приходит уже JavaScript.
    transform(code, id) {
      if (id.includes('\0') || !QUICK_FILTERS.some((f) => code.includes(f))) return undefined;
      let program: unknown;
      try {
        program = this.parse(code);
      } catch (error) {
        // Модуль упоминает наши субпути, но не парсится на фазе, где обязан
        // быть JavaScript, — сломанный вход, а не «чужой синтаксис».
        // Диагностика не глотается; имя плагина и позицию Rollup допишет сам.
        this.warn(`lowering пропущен: ${error}`);
        return undefined;
      }
      const ast = program as AstNode;
      // Два независимых плана: nano (мультиканальный frame + spring-опции) и surface (3-арг
      // layout:'project'). Правки не пересекаются: surface-вызов нижится
      // только полностью статическим, а вложенный вызов в аргументе делает
      // его динамическим (консервативный отказ).
      const plans = [
        planNanoLowering(ast, code, nanoCallArtifactLiteral),
        planSurfaceLowering(ast, code),
      ].filter((plan): plan is NanoLoweringPlan => plan !== undefined);
      if (plans.length === 0) return undefined;
      const edits = plans
        .flatMap((plan) => plan.edits)
        .sort((a, b) => a.start - b.start);
      const transformed = applyEdits(code, edits)
        + plans.map((plan) =>
          `\nimport { ${plan.importName} as ${plan.importLocal} } from ${JSON.stringify(plan.importSource)};`).join('')
        + '\n';
      return { code: transformed, map: buildMap(code, edits, id, plans.length) };
    },
  };
}
