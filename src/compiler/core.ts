/**
 * compiler/core.ts — parse-независимое ядро build-time lowering (#208, #221).
 *
 * Скоуп (#221, первый implementation-child эпика #220): статический вызов
 * `animate(target, props, options?)` из direct named import
 * '@labpics/motion/nano', где props — plain object literal из конечных
 * числовых/строковых литералов (scale/rotate — числа, как типы NanoProps),
 * а options отсутствует ЛИБО statically доказанный
 * `{ spring?, delay?, stagger?, reducedMotion? }` (spring-режим).
 * Tween-режим `{ duration, ease }` НЕ понижается в этом срезе: нативная CSS
 * easing-строка не выражается кусочно-линейными кривыми MotionProgram V1 без
 * потери — расширение versioned-контракта строкой изинга — отдельное решение.
 * Всё остальное — консервативный отказ: source остаётся семантически исходным.
 *
 * Пайплайн артефакта: nano SSOT (кадр по семантике nano/index.ts байт-в-байт +
 * springLinear) → кандидат MotionProgram V1 (opacity — standard-канал scalar;
 * прочие каналы — escaped [255, string] с scalar для чисел и webCssOpaque для
 * строк: те же native-longhand семантики, что у nano) → parseMotionProgramV1
 * (единственный оракул доверия) → проекция обратно с обязательным bit-exact
 * сверением кадра, длительности и linear()-строки. Любое расхождение после
 * доказанного match — ошибка сборки, не silent fallback. delay/stagger/reduced
 * не входят в программу одного элемента (delay зависит от index цели) и живут
 * полями артефакта; их паритет с nano запечатан differential-сьютом executor.
 *
 * Ядро не знает о Vite/Rollup: адаптеры передают ESTree-совместимый Program
 * (узлы со start/end) и применяют возвращённые байтовые правки сами.
 */

import {
  MOTION_PROGRAM_CODEC_V1,
  MOTION_PROGRAM_COMPOSITE_V1,
  MOTION_PROGRAM_DIRECTION_V1,
  MOTION_PROGRAM_FEATURE_V1,
  MOTION_PROGRAM_STANDARD_CHANNEL_V1,
  parseMotionProgramV1,
  type MotionProgramCurveV1,
  type MotionProgramV1,
} from '../internal/motion-program.js';
import { springLinear } from '../nano/spring-linear.js';
import { compileRestingSpringExecutionArtifactTupleUnchecked, DEFAULT_TOLERANCE } from '../compositor/curve.js';
import { DEFAULT_SPRING } from '../internal/motion-defaults.js';
import { validateSpringParams, type SpringParams } from '../spring.js';

// ─── Артефакт ────────────────────────────────────────────────────────────────

/** Статически доказанная пружина (частичная — как принимает nano runtime). */
export interface StaticNanoSpring {
  readonly mass?: number | undefined;
  readonly stiffness?: number | undefined;
  readonly damping?: number | undefined;
}

/** Статически доказанные options nano (spring-режим среза #221). */
export interface StaticNanoOptions {
  readonly spring?: StaticNanoSpring | undefined;
  readonly delay?: number | undefined;
  readonly stagger?: number | undefined;
  readonly reducedMotion?: boolean | undefined;
}

export interface CompiledNanoArtifact {
  readonly frame: Readonly<Record<string, number | string>>;
  readonly durationMs: number;
  readonly cssLinear: string;
  readonly delay: number | undefined;
  readonly stagger: number | undefined;
  readonly reducedMotion: boolean | undefined;
}

/** Разбор канонической linear()-строки nano обратно в узлы (точный round-trip). */
function linearPoints(cssLinear: string): number[] {
  if (!cssLinear.startsWith('linear(') || !cssLinear.endsWith(')')) {
    throw new Error('lab-motion compiler: неканоническая linear()-строка nano');
  }
  return cssLinear.slice(7, -1).split(',').map(Number);
}

/**
 * Кадр + кривая + длительность обязаны пройти канонический V1-парсер и
 * спроецироваться обратно бит-в-бит. Кандидат строится ТОЛЬКО из артефакта:
 * opacity-число — standard-канал (scalar), прочие каналы — escaped
 * [255, stringIndex] со scalar (числа) или webCssOpaque (строки; native
 * longhand интерполирует host — та же семантика, что у nano/WAAPI).
 */
function verifyThroughMotionProgram(
  frame: Readonly<Record<string, number | string>>,
  durationMs: number,
  cssLinear: string,
): void {
  const points = linearPoints(cssLinear);
  const count = points.length - 1;
  // Кусочно-линейная кривая V1 из тех же узлов, что CSS linear()-строка:
  // последовательные пары (offset, value), offset₀=0, offsetN=1.
  const samples: number[] = [1];
  for (let index = 0; index <= count; index++) {
    samples.push(index / count, points[index]!);
  }
  const curve = samples as unknown as MotionProgramCurveV1;

  const strings: string[] = [];
  const stringIndex = (value: string): number => {
    const existing = strings.indexOf(value);
    if (existing !== -1) return existing;
    strings.push(value);
    return strings.length - 1;
  };
  const keys = Object.keys(frame);
  if (keys.length === 0) {
    throw new Error('lab-motion compiler: пустой кадр не понижается');
  }
  const bindings: unknown[] = [];
  const tracks: unknown[] = [];
  let usesHostExtensions = false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    const value = frame[key]!;
    const numeric = typeof value === 'number';
    let channel: unknown;
    if (key === 'opacity' && numeric) {
      channel = MOTION_PROGRAM_STANDARD_CHANNEL_V1.opacity;
    } else {
      channel = [255, stringIndex(key)];
      usesHostExtensions = true;
    }
    bindings.push([0, channel, index]);
    tracks.push([
      index,
      0,
      durationMs,
      0,
      MOTION_PROGRAM_DIRECTION_V1.normal,
      0,
      MOTION_PROGRAM_COMPOSITE_V1.replace,
      [[
        0,
        1,
        [0],
        [1, numeric ? [0, value] : [2, stringIndex(value)]],
        1,
        numeric ? MOTION_PROGRAM_CODEC_V1.scalar : MOTION_PROGRAM_CODEC_V1.webCssOpaque,
      ]],
    ]);
  }
  const candidate = [
    1,
    MOTION_PROGRAM_FEATURE_V1.currentValues |
      (usesHostExtensions ? MOTION_PROGRAM_FEATURE_V1.hostExtensions : 0),
    strings,
    // Индекс 0 канонически зарезервирован линейной кривой.
    [0, curve],
    bindings,
    tracks,
  ];
  // Единственный оракул доверия — канонический V1-парсер пакета.
  const program: MotionProgramV1 = parseMotionProgramV1(candidate);

  // Проекция обратно: кадр, длительность и кривая бит-в-бит.
  const parsedStrings = program[2];
  const rebuiltKeys: string[] = [];
  for (const track of program[5]) {
    const binding = program[4][track[0]]!;
    const channel = binding[1];
    const key = typeof channel === 'number' ? 'opacity' : parsedStrings[channel[1]]!;
    rebuiltKeys.push(key);
    const segment = track[7][0]!;
    const to = segment[3];
    if (to[0] !== 1) throw new Error('lab-motion compiler: проекция V1 разошлась с nano SSOT');
    const encoded = to[1]!;
    const rebuilt = encoded[0] === 0 ? encoded[1] : parsedStrings[encoded[1] as number]!;
    if (!Object.is(rebuilt, frame[key])) {
      throw new Error('lab-motion compiler: проекция V1 разошлась с nano SSOT');
    }
    const parsedCurve = program[3][segment[4]];
    const projected: number[] = [];
    if (parsedCurve !== 0 && parsedCurve !== undefined) {
      for (let index = 2; index < parsedCurve.length; index += 2) {
        projected.push(parsedCurve[index] as number);
      }
    }
    if (track[2] !== durationMs || `linear(${projected})` !== cssLinear) {
      throw new Error('lab-motion compiler: проекция V1 разошлась с nano SSOT');
    }
  }
  if (rebuiltKeys.length !== keys.length || rebuiltKeys.some((key, i) => key !== keys[i])) {
    throw new Error('lab-motion compiler: проекция V1 разошлась с nano SSOT');
  }
}

/**
 * Строит доверенный артефакт compiled-nano статического вызова (spring-режим).
 * Кадр воспроизводит семантику nano/index.ts БАЙТ-В-БАЙТ (единый цикл:
 * авторский порядок ключей, rotate→`${N}deg`); тайминг
 * — тот же springLinear SSOT (частичная пружина получает те же дефолты, что в
 * runtime). Бросает (ошибка сборки) при непредставимой пружине, пустом кадре
 * или расхождении V1-проекции.
 */
export function compileNanoCallArtifact(
  props: Readonly<Record<string, number | string>>,
  options: StaticNanoOptions = {},
): CompiledNanoArtifact {
  for (const value of Object.values(props)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('lab-motion compiler: значение канала обязано быть конечным');
    }
  }
  const frame: Record<string, number | string> = {};
  // Зеркало nano/index.ts (единый цикл, авторский порядок ключей, rotate с
  // deg-суффиксом) — байт-паритет кадра включая порядок.
  for (const property of Object.keys(props)) {
    const value = props[property]!;
    frame[property] = property === 'rotate' ? `${value}deg` : value;
  }
  const spring = options.spring;
  const [durationMs, cssLinear] = springLinear(spring === undefined ? undefined : {
    mass: spring.mass ?? 1,
    stiffness: spring.stiffness ?? 170,
    damping: spring.damping ?? 26,
  });
  verifyThroughMotionProgram(frame, durationMs, cssLinear);
  return {
    frame,
    durationMs,
    cssLinear,
    delay: options.delay,
    stagger: options.stagger,
    reducedMotion: options.reducedMotion,
  };
}

// ─── Нормализованный AST-контракт (§13.5) ────────────────────────────────────

/** Минимальный структурный узел: адаптер обязан дать type + байтовые границы. */
export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export interface NanoLoweringEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Непониженный вызов с причиной (#237): сырьё для strict-режима и леджера. */
export interface NanoLoweringRefusal {
  /** Байтовый offset начала вызова в исходнике (адаптер считает line:col). */
  readonly start: number;
  /** Человекочитаемая причина отказа. */
  readonly reason: string;
}

export interface NanoLoweringPlan {
  /**
   * Непересекающиеся правки в порядке возрастания start. МОЖЕТ быть пустым:
   * модуль без единого понижения, но с отказами (#237) — адаптер не
   * трансформирует, но strict-режим обязан видеть отказы.
   */
  readonly edits: readonly NanoLoweringEdit[];
  /** Локальное имя executor-биндинга; адаптер добавляет hoisted-импорт. */
  readonly importLocal: string;
  /** Субпуть executor-импорта. */
  readonly importSource: string;
  /** Число НЕтрансформированных вызовов nano-animate (для manifest). */
  readonly runtimeCalls: number;
  /** Сумма длин ИНЪЕЦИРОВАННЫХ артефакт-литералов, символы (для onBudget). */
  readonly literalChars: number;
  /**
   * Отказы БЕЗ маркера `@motion-runtime` (блочный комментарий вплотную перед вызовом) — кандидаты
   * на ошибку сборки в strict-режиме (#237). Помеченные вызовы легитимно
   * рантаймовые: считаются в runtimeCalls, но сюда не попадают.
   */
  readonly refusals: readonly NanoLoweringRefusal[];
}

const NANO_SOURCE = '@labpics/motion/nano';

/** Блочный маркер `@motion-runtime` вплотную перед узлом: легитимный runtime. */
function hasRuntimeMarker(code: string, start: number): boolean {
  return /\/\*\s*@motion-runtime\s*\*\/\s*$/.test(code.slice(0, start));
}
export const COMPILED_IMPORT_SOURCE = '@labpics/motion/compiler/runtime';
export const COMPILED_IMPORT_NAME = 'animateCompiled';
const IMPORT_LOCAL = '__labMotionNanoCompiled';

function walk(node: unknown, visit: (node: AstNode, parent: AstNode | undefined) => void, parent?: AstNode): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, parent);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as AstNode;
  if (typeof record.type !== 'string') return;
  visit(record, parent);
  for (const key of Object.keys(record)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    walk(record[key], visit, record);
  }
}

/** Identifier занимает binding-позицию (объявляет имя), а не читает его. */
function bindsName(node: AstNode, parent: AstNode | undefined, name: string): boolean {
  if (node.type !== 'Identifier' || node.name !== name || parent === undefined) return false;
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id === node;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.id === node || (parent.params as unknown[] | undefined)?.includes(node) === true;
    case 'ArrowFunctionExpression':
      return (parent.params as unknown[]).includes(node);
    case 'CatchClause':
      return parent.param === node;
    // Деструктуризация: любое появление в паттернах — binding.
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
    case 'AssignmentPattern':
      return true;
    case 'Property':
      // Property внутри ObjectPattern неотличим от объектного литерала без
      // scope-анализа: любое value-совпадение — сомнение → консервативный отказ.
      return parent.value === node;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return parent.local === node;
    default:
      return false;
  }
}

/**
 * Планирует lowering модуля. undefined — трансформировать нечего либо
 * консервативный отказ целиком (shadowing/коллизия локального имени).
 *
 * `code` — байты модуля: ядро остаётся parse-независимым, но верифицирует
 * тривиа-зоны вызова ПОБАЙТНО. Acorn (preserveParens: false) схлопывает
 * скобки вокруг callee/target в сам узел, поэтому только байтовая проверка
 * отличает `animate(el, …)` от `(animate)(el, …)` и `animate((x, y), …)` —
 * первые правки без неё производили битый или тихо неверный вывод.
 */
export function planNanoLowering(
  program: AstNode,
  code: string,
  artifactLiteral: (
    props: Readonly<Record<string, number | string>>,
    options: StaticNanoOptions,
  ) => string,
): NanoLoweringPlan | undefined {
  let importedPlain = false;
  const importNodes = new Set<AstNode>();
  /** Узлы, удерживающие ./nano в графе (import/re-export форм всех видов). */
  const nanoRetainers: AstNode[] = [];
  let doubt = false;
  let localNameCollision = false;

  walk(program, (node, parent) => {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      const retainSource = node.source as AstNode | undefined;
      if (retainSource?.value === NANO_SOURCE) nanoRetainers.push(node);
    }
    if (node.type === 'ImportDeclaration') {
      const source = node.source as AstNode | undefined;
      if (source?.value === NANO_SOURCE) {
        for (const spec of (node.specifiers as AstNode[] | undefined) ?? []) {
          importNodes.add(spec);
          if (
            spec.type === 'ImportSpecifier' &&
            (spec.imported as AstNode).type === 'Identifier' &&
            (spec.imported as AstNode).name === 'animate' &&
            (spec.local as AstNode).name === 'animate'
          ) {
            importedPlain = true;
          }
        }
      }
    }
    if (node.type === 'Identifier' && node.name === IMPORT_LOCAL) localNameCollision = true;
    if (
      node.name === 'animate' &&
      !importNodes.has(parent as AstNode) &&
      parent?.type !== 'ImportSpecifier' &&
      bindsName(node, parent, 'animate')
    ) {
      doubt = true; // локальное объявление затеняет импорт где-то в модуле
    }
  });

  if (!importedPlain || doubt || localNameCollision) {
    // #237: ./nano удерживается в графе формой, которую ядро не анализирует
    // (alias/namespace/side-effect импорт, re-export, затенение, коллизия) —
    // это МОДУЛЬНЫЙ refusal: strict обязан его видеть, иначе гарантия
    // «./nano физически не в бандле» дырява. Упоминание строки без
    // import/export-формы (комментарий) — не при делах.
    const anchor = nanoRetainers[0];
    if (anchor === undefined) return undefined;
    if (hasRuntimeMarker(code, anchor.start)) return undefined;
    return {
      edits: [],
      importLocal: IMPORT_LOCAL,
      importSource: COMPILED_IMPORT_SOURCE,
      runtimeCalls: 0,
      literalChars: 0,
      refusals: [{
        start: anchor.start,
        reason: 'присутствие ./nano в неанализируемой форме (alias/namespace/re-export/затенение) — элиминация недоказуема',
      }],
    };
  }

  const edits: NanoLoweringEdit[] = [];
  const refusals: NanoLoweringRefusal[] = [];
  let runtimeCalls = 0;
  let literalChars = 0;
  /**
   * Отказ с причиной (#237): вызов с маркером `@motion-runtime` —
   * легитимно рантаймовый (в runtimeCalls, не в refusals).
   */
  const refuse = (node: AstNode, reason: string): void => {
    runtimeCalls++;
    if (!hasRuntimeMarker(code, node.start)) {
      refusals.push({ start: node.start, reason });
    }
  };

  walk(program, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AstNode;
    if (callee.type !== 'Identifier' || callee.name !== 'animate') return;
    if (node.optional === true) { refuse(node, 'optional-вызов `animate?.()`'); return; }
    const args = node.arguments as AstNode[];
    if (args.length !== 2 && args.length !== 3) { refuse(node, 'не 2–3 аргумента'); return; }
    const [targetArg, propsArg, optionsArg] = args as [AstNode, AstNode, AstNode?];
    if (targetArg.type === 'SpreadElement') { refuse(node, 'spread в target'); return; }
    const props = staticNanoProps(propsArg);
    if (props === undefined) { refuse(node, 'props не доказаны статическими'); return; }
    const options = staticNanoOptions(optionsArg);
    if (options === undefined) { refuse(node, 'options не доказаны статическими'); return; }
    // Побайтная верификация тривиа-зон: ровно `(`, `,`, `)` с пробелами.
    // Скобки вокруг callee/target, комментарии и прочая экзотика — отказ.
    const lastArg = optionsArg ?? propsArg;
    if (
      !/^\s*\(\s*$/.test(code.slice(callee.end, targetArg.start)) ||
      !/^\s*,\s*$/.test(code.slice(targetArg.end, propsArg.start)) ||
      (optionsArg !== undefined &&
        !/^\s*,\s*$/.test(code.slice(propsArg.end, optionsArg.start))) ||
      !/^\s*,?\s*\)$/.test(code.slice(lastArg.end, node.end))
    ) { refuse(node, 'нестандартные разделители/комментарии внутри вызова'); return; }
    // Невалидный ДОКАЗАННО-статический вход (например незатухающая пружина) —
    // ошибка сборки с причиной, не silent fallback (#221).
    let literal: string;
    try {
      literal = artifactLiteral(props, options);
    } catch (error) {
      throw new Error(
        `lab-motion compiler: статический nano-вызов невалиден — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    literalChars += literal.length;
    edits.push(
      { start: callee.start, end: targetArg.start, replacement: `${IMPORT_LOCAL}(` },
      { start: targetArg.end, end: node.end, replacement: `, ${literal})` },
    );
  });

  // Пустой план (ни правок, ни отказов) — модуль не при делах.
  // План с отказами без правок нужен strict-режиму/леджеру (#237).
  if (edits.length === 0 && refusals.length === 0) return undefined;
  // Walk идёт в pre-order (внешний вызов раньше вложенного в target):
  // сортировка восстанавливает документированный инвариант возрастания start.
  // Пары правок вложенных вызовов лежат целиком МЕЖДУ правками внешнего и
  // после сортировки корректно понижаются вместе с ним.
  edits.sort((a, b) => a.start - b.start);
  return {
    edits,
    importLocal: IMPORT_LOCAL,
    importSource: COMPILED_IMPORT_SOURCE,
    runtimeCalls,
    literalChars,
    refusals,
  };
}

/** Plain non-computed init-property с Identifier-ключом; иначе undefined. */
function plainProperty(node: AstNode): { key: string; value: AstNode } | undefined {
  if (
    node.type !== 'Property' ||
    node.kind !== 'init' ||
    node.method === true ||
    node.computed === true ||
    node.shorthand === true
  ) return undefined;
  const key = node.key as AstNode;
  if (key.type !== 'Identifier') return undefined;
  return { key: key.name as string, value: node.value as AstNode };
}

/**
 * Конечный числовой литерал, включая унарный минус (#240: `-100` — это
 * UnaryExpression('-', Literal), прежний отказ терял типовые вызовы вида
 * `x: [-100, 100]`). Значение вычисляется точно (JS-семантика унарного
 * минуса над литералом); прочие операторы (`+`, `~`, `!`) — по-прежнему
 * сомнение → runtime.
 */
function staticFinite(node: AstNode): number | undefined {
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument !== undefined) {
    const inner = staticFinite(node.argument as AstNode);
    return inner === undefined ? undefined : -inner;
  }
  return node.type === 'Literal' && typeof node.value === 'number' && Number.isFinite(node.value)
    ? node.value
    : undefined;
}

/**
 * Статически доказанные props: plain object literal, все ключи — Identifier
 * без дубликатов, значения — конечные числовые ЛИБО строковые литералы;
 * scale/rotate — только числа (типовой контракт NanoProps). Пустой кадр и
 * любая сомнительная форма — undefined (вызов остаётся runtime).
 */
function staticNanoProps(props: AstNode): Record<string, number | string> | undefined {
  if (props.type !== 'ObjectExpression') return undefined;
  const out: Record<string, number | string> = {};
  const seen = new Set<string>();
  for (const property of props.properties as AstNode[]) {
    const plain = plainProperty(property);
    if (plain === undefined) return undefined;
    if (seen.has(plain.key)) return undefined; // дубликат ключа — сомнение
    seen.add(plain.key);
    const numeric = staticFinite(plain.value);
    if (numeric !== undefined) {
      out[plain.key] = numeric;
      continue;
    }
    if (plain.key === 'scale' || plain.key === 'rotate') return undefined;
    const value = plain.value;
    if (value.type !== 'Literal' || typeof value.value !== 'string') return undefined;
    out[plain.key] = value.value;
  }
  if (seen.size === 0) return undefined;
  return out;
}

/** Статически доказанная частичная пружина: подмножество {mass, stiffness, damping}. */
function staticSpring(node: AstNode): StaticNanoSpring | undefined {
  if (node.type !== 'ObjectExpression') return undefined;
  const out: { mass?: number; stiffness?: number; damping?: number } = {};
  const seen = new Set<string>();
  for (const property of node.properties as AstNode[]) {
    const plain = plainProperty(property);
    if (plain === undefined) return undefined;
    if (
      seen.has(plain.key) ||
      (plain.key !== 'mass' && plain.key !== 'stiffness' && plain.key !== 'damping')
    ) return undefined;
    seen.add(plain.key);
    const value = staticFinite(plain.value);
    if (value === undefined) return undefined;
    out[plain.key as 'mass' | 'stiffness' | 'damping'] = value;
  }
  return out;
}

/**
 * Статически доказанные options: отсутствуют (→ дефолтная пружина) либо plain
 * object literal из {spring?, delay?, stagger?, reducedMotion?}. Ключи
 * duration/ease (нативная easing-строка не выражается V1 без потери) и любые
 * неизвестные — undefined (вызов остаётся runtime).
 */
function staticNanoOptions(node: AstNode | undefined): StaticNanoOptions | undefined {
  if (node === undefined) return {};
  if (node.type !== 'ObjectExpression') return undefined;
  const out: {
    spring?: StaticNanoSpring;
    delay?: number;
    stagger?: number;
    reducedMotion?: boolean;
  } = {};
  const seen = new Set<string>();
  for (const property of node.properties as AstNode[]) {
    const plain = plainProperty(property);
    if (plain === undefined) return undefined;
    if (seen.has(plain.key)) return undefined;
    seen.add(plain.key);
    if (plain.key === 'spring') {
      const spring = staticSpring(plain.value);
      if (spring === undefined) return undefined;
      out.spring = spring;
    } else if (plain.key === 'delay' || plain.key === 'stagger') {
      const value = staticFinite(plain.value);
      if (value === undefined) return undefined;
      out[plain.key] = value;
    } else if (plain.key === 'reducedMotion') {
      const value = plain.value;
      if (value.type !== 'Literal' || typeof value.value !== 'boolean') return undefined;
      out.reducedMotion = value.value;
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * Компактный литерал артефакта для инъекции в код (детерминированный,
 * однострочный — закон sourcemap-композиции адаптера). Поля: f — кадр,
 * d/e — тайминг, y/g — delay/stagger, r — явный reducedMotion (1/0).
 */
export function nanoArtifactLiteral(
  props: Readonly<Record<string, number | string>>,
  options: StaticNanoOptions = {},
): string {
  const artifact = compileNanoCallArtifact(props, options);
  let frame = '';
  for (const [key, value] of Object.entries(artifact.frame)) {
    frame += `${frame === '' ? '' : ','}${key}:${
      typeof value === 'number' ? String(value) : JSON.stringify(value)
    }`;
  }
  let out = `{f:{${frame}},d:${artifact.durationMs},e:${JSON.stringify(artifact.cssLinear)}`;
  if (artifact.delay !== undefined) out += `,y:${artifact.delay}`;
  if (artifact.stagger !== undefined) out += `,g:${artifact.stagger}`;
  if (artifact.reducedMotion !== undefined) out += `,r:${artifact.reducedMotion ? 1 : 0}`;
  return out + '}';
}

// ─── #240 facade-erasure: понижение полного `./animate` ──────────────────────
//
// Отдельная грамматика рядом с nano: те же дисциплины (direct named import,
// доказанная статика, побайтная верификация тривиа-зон, консервативный отказ),
// но ДРУГАЯ семантика — фасад несёт реестр владения, C¹-подхват скорости,
// residual-transform и rAF-фоллбек. Понижение отбрасывает всё это, поэтому оно
// НЕ автоматическое: вызов обязан быть помечен прагмой `@lm-oneshot` вплотную
// перед ним. Прагма — согласие автора на nano-семантику: «одноразовый прогон
// из identity, без подхвата и без реестра». Результат обязан отбрасываться
// (statement-позиция): понижённый вызов не публикует owner, поэтому любой
// доступ к контролам был бы ложью о поведении.
//
// Кривая берётся из compositor/curve.ts (тот же артефакт, что строит фасадный
// tier-0 при v0=0) — НЕ из nano/spring-linear.ts: у тиров разные эмиттеры и
// разные длительности, и паритет требуется именно с фасадом (C4-дифференциал).

const FACADE_SOURCE = '@labpics/motion/animate';
export const COMPILED_FACADE_IMPORT_NAME = 'animateFacadeCompiled';
const FACADE_IMPORT_LOCAL = '__labMotionFacadeCompiled';

/** Прагма `@lm-oneshot` вплотную перед узлом: согласие на nano-семантику. */
function hasOneshotMarker(code: string, start: number): boolean {
  return /\/\*\s*@lm-oneshot\s*\*\/\s*$/.test(code.slice(0, start));
}

/**
 * Identity transform-шортхендов — зеркало TRANSFORM_IDENTITY фасада
 * (animate/channels.ts). Компилятор обязан выводить from ровно так же:
 * фасад для transform-каналов НЕ читает computed-стиль, а берёт identity.
 */
const FACADE_TRANSFORM_IDENTITY: Readonly<Record<string, number>> = {
  x: 0,
  y: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  skewX: 0,
  skewY: 0,
};

/** Канал понижённого вызова: [ключ, from, to]. */
export type StaticFacadeChannel = readonly [key: string, from: number, to: number];
/** Группа записи: [CSS-группа, каналы] — одна Animation на группу. */
export type StaticFacadeGroup = readonly [group: string, channels: readonly StaticFacadeChannel[]];

/** Статически доказанные options фасада (spring-режим). */
export interface StaticFacadeOptions {
  readonly spring?: StaticNanoSpring | undefined;
  readonly delay?: number | undefined;
  readonly stagger?: number | undefined;
}

/**
 * Статически доказанные props фасада: ObjectExpression, ключи — Identifier без
 * дубликатов ТОЛЬКО из словаря transform-шортхендов и `opacity`; значения —
 * конечный числовой литерал (from = identity/1) либо пара `[from, to]` из двух
 * таких литералов. Всё прочее (CSS-каналы, var, цвета, треки ≥3) — undefined:
 * их from фасад читает из живого стиля, что build доказать не может.
 */
function staticFacadeProps(props: AstNode): StaticFacadeGroup[] | undefined {
  if (props.type !== 'ObjectExpression') return undefined;
  const seen = new Set<string>();
  // Группы в порядке ПЕРВОГО появления ключа — как parseProps фасада.
  const groups = new Map<string, StaticFacadeChannel[]>();
  for (const property of props.properties as AstNode[]) {
    const plain = plainProperty(property);
    if (plain === undefined) return undefined;
    if (seen.has(plain.key)) return undefined;
    seen.add(plain.key);
    const isTransform = typeof FACADE_TRANSFORM_IDENTITY[plain.key] === 'number';
    if (!isTransform && plain.key !== 'opacity') return undefined;
    const group = isTransform ? 'transform' : 'opacity';
    let from: number | undefined;
    let to: number | undefined;
    const single = staticFinite(plain.value);
    if (single !== undefined) {
      // Явной пары нет: фасад берёт from из identity (transform) либо из
      // браузерного дефолта 1 (opacity) — прагма санкционирует это допущение.
      from = isTransform ? FACADE_TRANSFORM_IDENTITY[plain.key]! : 1;
      to = single;
    } else if (plain.value.type === 'ArrayExpression') {
      const items = plain.value.elements as (AstNode | null)[];
      if (items.length !== 2) return undefined; // трек ≥3 — tween-режим фасада
      const a = items[0] === null ? undefined : staticFinite(items[0]!);
      const b = items[1] === null ? undefined : staticFinite(items[1]!);
      if (a === undefined || b === undefined) return undefined;
      from = a;
      to = b;
    } else return undefined;
    const channels = groups.get(group);
    if (channels === undefined) groups.set(group, [[plain.key, from, to]]);
    else channels.push([plain.key, from, to]);
  }
  if (seen.size === 0) return undefined;
  return [...groups].map(([group, channels]): StaticFacadeGroup => [group, channels]);
}

/**
 * Статически доказанные options фасада: отсутствуют либо plain object из
 * {spring?, delay?, stagger?}. duration/ease (tween), times/ease[] (треки),
 * onComplete и прочие швы — undefined (вызов остаётся рантаймовым).
 */
function staticFacadeOptions(node: AstNode | undefined): StaticFacadeOptions | undefined {
  if (node === undefined) return {};
  if (node.type !== 'ObjectExpression') return undefined;
  const out: { spring?: StaticNanoSpring; delay?: number; stagger?: number } = {};
  const seen = new Set<string>();
  for (const property of node.properties as AstNode[]) {
    const plain = plainProperty(property);
    if (plain === undefined) return undefined;
    if (seen.has(plain.key)) return undefined;
    seen.add(plain.key);
    if (plain.key === 'spring') {
      const spring = staticSpring(plain.value);
      if (spring === undefined) return undefined;
      out.spring = spring;
    } else if (plain.key === 'delay' || plain.key === 'stagger') {
      const value = staticFinite(plain.value);
      if (value === undefined) return undefined;
      out[plain.key] = value;
    } else return undefined;
  }
  return out;
}

/** Готовый артефакт понижённого фасадного вызова. */
export interface CompiledFacadeArtifact {
  readonly groups: readonly StaticFacadeGroup[];
  readonly durationMs: number;
  readonly cssLinear: string;
  readonly delay: number | undefined;
  readonly stagger: number | undefined;
}

/**
 * Собирает артефакт фасадного вызова. Кривая — тот же
 * compileRestingSpringExecutionArtifactTupleUnchecked, который исполняет
 * фасадный tier-0 при v0=0 (resting ≡ generic(v0=0) бит-в-бит), поэтому
 * easing/duration совпадают с рантаймовым путём по построению; невалидная
 * доказанно-статическая пружина — ошибка сборки (канон #221), не тихий
 * фоллбек. Эндпоинты сетки (0% и 100%) проверяются явно: executor опирается
 * на них, и молчаливый дрейф контракта сегментера должен ронять сборку.
 */
export function compileFacadeCallArtifact(
  groups: readonly StaticFacadeGroup[],
  options: StaticFacadeOptions = {},
): CompiledFacadeArtifact {
  const partial = options.spring;
  const spring: SpringParams = {
    mass: partial?.mass ?? DEFAULT_SPRING.mass,
    stiffness: partial?.stiffness ?? DEFAULT_SPRING.stiffness,
    damping: partial?.damping ?? DEFAULT_SPRING.damping,
  };
  validateSpringParams(spring);
  const artifact = compileRestingSpringExecutionArtifactTupleUnchecked(spring, DEFAULT_TOLERANCE);
  const samples = artifact[1];
  if (samples[0] !== 0 || samples[samples.length - 2] !== 100) {
    throw new Error('lab-motion compiler: сетка кривой не начинается в 0% / не кончается в 100%');
  }
  return {
    groups,
    durationMs: artifact[2],
    cssLinear: artifact[0],
    delay: options.delay,
    stagger: options.stagger,
  };
}

/** Компактный однострочный литерал фасадного артефакта (закон sourcemap). */
export function facadeArtifactLiteral(
  groups: readonly StaticFacadeGroup[],
  options: StaticFacadeOptions = {},
): string {
  const artifact = compileFacadeCallArtifact(groups, options);
  const channels = artifact.groups.map(([group, list]) =>
    `[${JSON.stringify(group)},[${
      list.map(([key, from, to]) => `[${JSON.stringify(key)},${from},${to}]`).join(',')
    }]]`).join(',');
  let out = `{c:[${channels}],d:${artifact.durationMs},e:${JSON.stringify(artifact.cssLinear)}`;
  if (artifact.delay !== undefined) out += `,y:${artifact.delay}`;
  if (artifact.stagger !== undefined) out += `,g:${artifact.stagger}`;
  return out + '}';
}

/**
 * Понизился бы вызов, будь он помечен? Ровно те же проверки, что в плане, но
 * без построения артефакта — предикат для квитанции кандидатов (#240).
 */
function isLowerableFacadeCall(
  node: AstNode,
  parent: AstNode | undefined,
  code: string,
): boolean {
  if (node.optional === true) return false;
  if (parent?.type !== 'ExpressionStatement') return false;
  const args = node.arguments as AstNode[];
  if (args.length !== 2 && args.length !== 3) return false;
  const [targetArg, propsArg, optionsArg] = args as [AstNode, AstNode, AstNode?];
  if (targetArg.type === 'SpreadElement') return false;
  if (staticFacadeProps(propsArg) === undefined) return false;
  if (staticFacadeOptions(optionsArg) === undefined) return false;
  const callee = node.callee as AstNode;
  const lastArg = optionsArg ?? propsArg;
  return /^\s*\(\s*$/.test(code.slice(callee.end, targetArg.start))
    && /^\s*,\s*$/.test(code.slice(targetArg.end, propsArg.start))
    && (optionsArg === undefined
      || /^\s*,\s*$/.test(code.slice(propsArg.end, optionsArg.start)))
    && /^\s*,?\s*\)$/.test(code.slice(lastArg.end, node.end));
}

/**
 * Планирует понижение фасадных вызовов модуля. Отличия от nano-плана:
 * — источник `./animate`, а не `./nano`;
 * — вызов обязан нести прагму `@lm-oneshot` (иначе — рантаймовый, БЕЗ отказа:
 *   отсутствие прагмы не дефект, а осознанный выбор полного фасада);
 * — вызов обязан стоять в statement-позиции (результат отбрасывается).
 * Модульный отказ (alias/namespace/re-export/затенение) НЕ выносится: фасад
 * остаётся легальным рантаймовым тиром, его присутствие в графе — норма, а не
 * дырка в гарантии (в отличие от `./nano`, где действует закон #237).
 */
export interface FacadeLoweringPlan extends NanoLoweringPlan {
  /**
   * Вызовы, которые понизились бы чисто, но не помечены прагмой (#240).
   * Стирание — opt-in на вызов, поэтому без этой цифры автор просто не узнает,
   * что 12 из его 40 вызовов уже готовы уехать из бандла.
   */
  readonly erasable: number;
}

export function planFacadeLowering(
  program: AstNode,
  code: string,
  artifactLiteral: (
    groups: readonly StaticFacadeGroup[],
    options: StaticFacadeOptions,
  ) => string,
): FacadeLoweringPlan | undefined {
  let importedPlain = false;
  const importNodes = new Set<AstNode>();
  let doubt = false;
  let localNameCollision = false;

  walk(program, (node, parent) => {
    if (node.type === 'ImportDeclaration') {
      const source = node.source as AstNode | undefined;
      if (source?.value === FACADE_SOURCE) {
        for (const spec of (node.specifiers as AstNode[] | undefined) ?? []) {
          importNodes.add(spec);
          if (
            spec.type === 'ImportSpecifier' &&
            (spec.imported as AstNode).type === 'Identifier' &&
            (spec.imported as AstNode).name === 'animate' &&
            (spec.local as AstNode).name === 'animate'
          ) {
            importedPlain = true;
          }
        }
      }
    }
    if (node.type === 'Identifier' && node.name === FACADE_IMPORT_LOCAL) localNameCollision = true;
    if (
      node.name === 'animate' &&
      !importNodes.has(parent as AstNode) &&
      parent?.type !== 'ImportSpecifier' &&
      bindsName(node, parent, 'animate')
    ) {
      doubt = true;
    }
  });

  if (!importedPlain || doubt || localNameCollision) return undefined;

  const edits: NanoLoweringEdit[] = [];
  const refusals: NanoLoweringRefusal[] = [];
  let runtimeCalls = 0;
  let literalChars = 0;
  let erasable = 0;
  /**
   * Помеченный прагмой вызов, который понизить не вышло, — ОТКАЗ с причиной
   * (автор запросил стирание и обязан узнать, почему его не случилось).
   * Непомеченный — просто рантаймовый фасад, без записи в refusals.
   */
  const refuse = (node: AstNode, reason: string): void => {
    runtimeCalls++;
    if (hasOneshotMarker(code, node.start)) refusals.push({ start: node.start, reason });
  };

  walk(program, (node, parent) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AstNode;
    if (callee.type !== 'Identifier' || callee.name !== 'animate') return;
    if (!hasOneshotMarker(code, node.start)) {
      runtimeCalls++;
      // Непомеченный вызов остаётся фасадом молча — но если он ПОНИЗИЛСЯ БЫ,
      // автор должен об этом узнать из квитанции, иначе выигрыш парадигмы
      // остаётся невидимым. Проверяется только грамматика: артефакт (кривая,
      // верификация) не строится — кандидат стоит ноль build-времени.
      if (isLowerableFacadeCall(node, parent, code)) erasable++;
      return;
    }
    if (node.optional === true) { refuse(node, 'optional-вызов `animate?.()`'); return; }
    if (parent?.type !== 'ExpressionStatement') {
      refuse(node, 'результат вызова используется — понижённый вызов не публикует owner и не отдаёт контролы');
      return;
    }
    const args = node.arguments as AstNode[];
    if (args.length !== 2 && args.length !== 3) { refuse(node, 'не 2–3 аргумента'); return; }
    const [targetArg, propsArg, optionsArg] = args as [AstNode, AstNode, AstNode?];
    if (targetArg.type === 'SpreadElement') { refuse(node, 'spread в target'); return; }
    const groups = staticFacadeProps(propsArg);
    if (groups === undefined) {
      refuse(node, 'props не доказаны статическими (поддержаны transform-шортхенды и opacity: число либо пара [from, to])');
      return;
    }
    const options = staticFacadeOptions(optionsArg);
    if (options === undefined) {
      refuse(node, 'options не доказаны статическими (поддержаны spring/delay/stagger; duration/ease — tween-режим фасада)');
      return;
    }
    const lastArg = optionsArg ?? propsArg;
    if (
      !/^\s*\(\s*$/.test(code.slice(callee.end, targetArg.start)) ||
      !/^\s*,\s*$/.test(code.slice(targetArg.end, propsArg.start)) ||
      (optionsArg !== undefined &&
        !/^\s*,\s*$/.test(code.slice(propsArg.end, optionsArg.start))) ||
      !/^\s*,?\s*\)$/.test(code.slice(lastArg.end, node.end))
    ) { refuse(node, 'нестандартные разделители/комментарии внутри вызова'); return; }
    let literal: string;
    try {
      literal = artifactLiteral(groups, options);
    } catch (error) {
      throw new Error(
        `lab-motion compiler: статический фасадный вызов невалиден — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    literalChars += literal.length;
    edits.push(
      { start: callee.start, end: targetArg.start, replacement: `${FACADE_IMPORT_LOCAL}(` },
      { start: targetArg.end, end: node.end, replacement: `, ${literal})` },
    );
  });

  if (edits.length === 0 && refusals.length === 0 && erasable === 0) return undefined;
  edits.sort((a, b) => a.start - b.start);
  return {
    edits,
    importLocal: FACADE_IMPORT_LOCAL,
    importSource: COMPILED_IMPORT_SOURCE,
    runtimeCalls,
    literalChars,
    refusals,
    erasable,
  };
}
