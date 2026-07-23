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
  /**
   * Отказы БЕЗ маркера `@motion-runtime` (блочный комментарий вплотную перед вызовом) — кандидаты
   * на ошибку сборки в strict-режиме (#237). Помеченные вызовы легитимно
   * рантаймовые: считаются в runtimeCalls, но сюда не попадают.
   */
  readonly refusals: readonly NanoLoweringRefusal[];
}

const NANO_SOURCE = '@labpics/motion/nano';
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
  let doubt = false;
  let localNameCollision = false;

  walk(program, (node, parent) => {
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

  if (!importedPlain || doubt || localNameCollision) return undefined;

  const edits: NanoLoweringEdit[] = [];
  const refusals: NanoLoweringRefusal[] = [];
  let runtimeCalls = 0;
  /**
   * Отказ с причиной (#237): вызов с маркером `@motion-runtime` (блочный комментарий вплотную перед ним) —
   * легитимно рантаймовый (в runtimeCalls, не в refusals). Маркер ищется
   * вплотную перед вызовом (допускается только пробельный хвост).
   */
  const refuse = (node: AstNode, reason: string): void => {
    runtimeCalls++;
    if (!/\/\*\s*@motion-runtime\s*\*\/\s*$/.test(code.slice(0, node.start))) {
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

/** Конечный числовой литерал (unary minus — UnaryExpression, отказ). */
function staticFinite(node: AstNode): number | undefined {
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
