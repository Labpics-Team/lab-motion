/**
 * animate/compositor-plan.ts — планировщик compositor-плана (срез R3a rebuild).
 *
 * Сердце перестройки ./animate: превращает вход фасада (props + options +
 * состояние элементов) в исполнимые планы юнита R2 (compositor-unit) и решает
 * владение группами. Заменяет модель channels.ts post-rebuild: per-frame
 * форматирование умерло — кадры собираются РОВНО ОДИН РАЗ здесь, интерполяцию
 * значений ведёт браузер, физика прогресса — в IR-кривой linear-compile.
 *
 * Семантический канон унаследован от channels.ts (справочник, НЕ импорт):
 * валидация parseProps (LM140–LM144), transform-шортхенды и residuals,
 * normalizeV0/sharedV0 (C¹-подхват в прогресс-пространстве), реестр
 * (element, group) с supersede-протоколом и LM157 anti-reentry.
 *
 * Отличия новой модели:
 *   - снимок середины полёта — ОДИН owner._snapshot() юнита R2 на группу
 *     (p, ṗ), поканальные значения деривируются из per-run {from,to} реестра —
 *     вместо поканального _captureNum старой модели;
 *   - css-значения хранятся и эмитятся КАК ЕСТЬ (строки/числа), цветовой
 *     движок в базовый граф не входит: C¹-подхват css идёт через
 *     инжектируемый шов formatCssAt(from,to,p); без шва планировщик честно
 *     деградирует до C⁰-рестарта с from = текущий to (директива владельца);
 *   - синтаксическая граница LM144 держится грамматикой юнитов (tryParseUnit,
 *     лёгкий) + head-проверкой цвета: глубокий разбор ТЕЛ цветов — вес
 *     value-движка, планировщик принимает форму и отдаёт значение браузеру.
 *
 * Фазовая дисциплина: buildCompositorPlan — ТОЛЬКО чтения (реестр, снимки
 * владельцев, style-read холодного from). Ни одной записи/прерывания до
 * commit-хуков (entry.publish / snap.commit), которые вызывает потребитель.
 *
 * Не публичный entry: модуль внутренний, exports в package.json не участвует.
 */

import { prefersReduced } from '../compositor/detect.js';
import { MotionParamError, type MotionParamErrorCode } from '../errors.js';
import { type SpringParams } from '../spring.js';
import { buildTransform } from '../value/transform.js';
import { tryParseUnit } from '../value/units.js';
import type {
  AbortSignalLike,
  CompositorUnitCapability,
  CompositorUnitPlan,
  CompositorUnitSeams,
  CompositorUnitTarget,
  ProgressSnapshot,
} from './compositor-unit.js';
import {
  easeProgressCurve,
  springProgressCurve,
  type ProgressCurveIR,
} from './linear-compile.js';

/** @motionErrorFactory */
function failPlan(code: MotionParamErrorCode): never {
  throw new MotionParamError(code);
}

// ─── Вход ────────────────────────────────────────────────────────────────────

/** Duck-цель планировщика: style-чтение холодного from + запись финала. */
export interface PlanTarget {
  readonly style: {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
  };
  animate?: CompositorUnitTarget['animate'];
}

/** Режим движения — резолв и коды LM136–LM138 остаются у фасада (R3b). */
export type PlanMode =
  | { readonly kind: 'spring'; readonly spring: SpringParams }
  | {
      readonly kind: 'tween';
      readonly durationMs: number;
      readonly ease: (t: number) => number;
    };

/** C¹-шов css: значение между from и to при прогрессе p; undefined = C⁰. */
export type FormatCssAt = (
  from: string | number,
  to: string | number,
  p: number,
) => string | number | undefined;

export interface CompositorPlanOptions {
  readonly targets: readonly PlanTarget[];
  readonly props: Record<string, unknown>;
  readonly mode: PlanMode;
  /** Базовая задержка (мс) всем целям; scheduleStagger остаётся у фасада. */
  readonly delayMs?: number | undefined;
  /** Готовые пер-целевые задержки (уже сложенные с base фасадом). */
  readonly targetDelays?: readonly number[] | undefined;
  readonly seams: CompositorUnitSeams;
  readonly capability: CompositorUnitCapability;
  /** Политика доступности — канон фасада (prefersReduced). */
  readonly matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  /** Явное перекрытие политики (детеминизм тестов/фасадный snapshot). */
  readonly reducedMotion?: boolean | undefined;
  readonly formatCssAt?: FormatCssAt | undefined;
  readonly signal?: AbortSignalLike | undefined;
}

// ─── Выход ───────────────────────────────────────────────────────────────────

/** Владелец группы в терминах юнита R2 (CompositorUnit совместим структурно). */
export interface PlanGroupOwner {
  _supersede(replacement?: () => void): void;
  _rollback(): void;
  /** Аналитический снимок прогресса; отсутствие = владелец без середины. */
  _snapshot?(): ProgressSnapshot;
}

/** Группа, исполнимая юнитом R2 без дообработки. */
export interface PlannedUnitGroup {
  readonly kind: 'unit';
  readonly el: PlanTarget;
  readonly group: string;
  readonly plan: CompositorUnitPlan;
  /** Commit-резерв записи: LM157 при реентри той же (el, group). */
  begin(): void;
  /**
   * Прерывает прежнего владельца (с терминальной записью его снимка в реестр)
   * и публикует successor. Канон дубликатов: successor уже создан вызывающим.
   * Бросок supersede откатывает successor (_rollback) и снимает резерв.
   */
  publish(owner: PlanGroupOwner): void;
  /** Сбой создания successor до publish: прежний владелец жив. */
  rollback(): void;
  /** Терминальная запись реестра владельцем (natural / прерывание со снимком). */
  settle(owner: PlanGroupOwner, natural: boolean, snapshot?: ProgressSnapshot): void;
}

/** Reduced/финал: писатель финала — отдельная запись плана, юнит не создаётся. */
export interface PlannedSnapGroup {
  readonly kind: 'snap';
  readonly el: PlanTarget;
  readonly group: string;
  /**
   * Снап-семантика фасада: резерв → supersede прежнего владельца с writer
   * в роли replacement (или прямой writer) → терминальная запись реестра.
   */
  commit(): void;
}

/** Группа, не представимая синхронной WAAPI-кривой — живой путь фасада. */
export interface PlannedLiveGroup {
  readonly kind: 'live';
  readonly el: PlanTarget;
  readonly group: string;
  readonly delayMs: number;
  readonly reason:
    | 'no-waapi'
    | 'v0-mismatch'
    | 'curve-budget'
    | 'explicit-non-numeric';
  /** Подхваченные каналы для живого движка (абсолютные величины, units/s). */
  readonly numeric: readonly {
    readonly key: string;
    readonly from: number;
    readonly to: number;
    readonly velocity: number;
  }[];
  readonly css: { readonly from: string | number; readonly to: string | number } | undefined;
}

export type PlannedGroup = PlannedUnitGroup | PlannedSnapGroup | PlannedLiveGroup;

export interface CompositorPlanResult {
  readonly plans: PlannedUnitGroup[];
  readonly snaps: PlannedSnapGroup[];
  readonly live: PlannedLiveGroup[];
}

// ─── Спецификации каналов (канон parseProps channels.ts) ─────────────────────

const TRANSFORM_IDENTITY: Readonly<Record<string, number>> = {
  x: 0,
  y: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  skewX: 0,
  skewY: 0,
};

/** typeof-проверка отсекает унаследованные constructor/toString/__proto__. */
function isTransformKey(key: string): boolean {
  return typeof TRANSFORM_IDENTITY[key] === 'number';
}

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

interface PlanSpec {
  readonly kind: 'num' | 'css';
  readonly key: string;
  readonly group: string;
  readonly explicitFrom: number | string | undefined;
  readonly to: number | string;
}

function requireFinite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) failPlan('LM142');
  return value;
}

/**
 * Синтаксическая граница css-значения БЕЗ цветового движка: число (конечное),
 * грамматика юнитов/var()/relative (тот же tryParseUnit, что у value-движка —
 * ноль дубля грамматики) либо head цвета (#/rgb(a)/hsl(a) — канон голов
 * tryParseValue). Глубокий разбор тела цвета — вес value/color; планировщик
 * принимает форму, значение исполняет браузер. Это единственное осознанное
 * ослабление LM144 против старой модели (документировано срезом).
 */
function requireCssValue(value: unknown): string | number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failPlan('LM142');
    return value;
  }
  if (typeof value !== 'string') failPlan('LM143');
  const source = value.trim();
  if (
    tryParseUnit(source) === undefined &&
    !source.startsWith('#') &&
    !/^rgba?/i.test(source) &&
    !/^hsla?/i.test(source)
  ) failPlan('LM144');
  return value;
}

/** Разбор props → спецификации. Бросает ДО любых записей (канон фасада). */
export function parsePlanProps(props: Record<string, unknown>): PlanSpec[] {
  const specs: PlanSpec[] = [];
  const keys = Object.keys(props);
  for (const key of keys) {
    const raw = props[key];
    if (key === 'transform') failPlan('LM140');
    const pair = Array.isArray(raw) ? raw : undefined;
    if (pair && pair.length !== 2) failPlan('LM141');
    if (isTransformKey(key) || key === 'opacity') {
      const group = key === 'opacity' ? 'opacity' : 'transform';
      const explicitFrom = pair ? requireFinite(pair[0]) : undefined;
      const to = requireFinite(pair ? pair[1] : raw);
      // Канон осей: uniform scale хранится двумя осями — переход
      // uniform↔axial не меняет представление и подхват.
      if (key === 'scale') {
        if (!keys.includes('scaleX')) {
          specs.push({ kind: 'num', key: 'scaleX', group, explicitFrom, to });
        }
        if (!keys.includes('scaleY')) {
          specs.push({ kind: 'num', key: 'scaleY', group, explicitFrom, to });
        }
      } else {
        specs.push({ kind: 'num', key, group, explicitFrom, to });
      }
    } else {
      specs.push({
        kind: 'css',
        key,
        group: camelToKebab(key),
        explicitFrom: pair ? requireCssValue(pair[0]) : undefined,
        to: requireCssValue(pair ? pair[1] : raw),
      });
    }
  }
  return specs;
}

// ─── Нормализация скорости (канон normalizeV0/sharedV0 channels.ts) ──────────

/** Порог вырожденного диапазона — зеркалит RANGE_EPSILON compositor-пути. */
const RANGE_EPSILON = 1e-10;

function normalizeV0(velocity: number, range: number): number {
  if (!(Math.abs(range) > RANGE_EPSILON)) return 0;
  const v0 = velocity / range;
  // `+ 0` схлопывает −0 (канон MotionValue).
  return Number.isFinite(v0) ? v0 + 0 : 0;
}

interface BoundChannel {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  readonly velocity: number;
  /** Представимая солвером цель (канон LM150: вырожденный диапазон с импульсом). */
  readonly solverTo: number;
  readonly v0: number;
}

function bindChannel(
  key: string,
  from: number,
  to: number,
  velocity: number,
): BoundChannel {
  const range = to - from;
  let solverTo = to;
  if (!(Math.abs(range) > RANGE_EPSILON) && velocity !== 0) {
    const representable = Math.max(RANGE_EPSILON, Math.abs(from) * Number.EPSILON);
    solverTo = from + (velocity < 0 ? -representable : representable);
    // Импульс у числовой границы непредставим даже минимальной амплитудой.
    if (!Number.isFinite(solverTo) || solverTo === from) failPlan('LM150');
  }
  return { key, from, to, velocity, solverTo, v0: normalizeV0(velocity, solverTo - from) };
}

/**
 * Единый v0 группы (канон sharedV0): статичные каналы без импульса прозрачны;
 * подменённая solver-амплитуда либо разошедшиеся v0 → undefined (живой путь:
 * WAAPI-кривая одна на группу и обязана кодировать общий прогресс).
 */
function sharedGroupV0(channels: readonly BoundChannel[]): number | undefined {
  let shared: number | undefined;
  for (const channel of channels) {
    if (channel.to === channel.from && channel.velocity === 0) continue;
    if (
      channel.solverTo !== channel.to ||
      (shared !== undefined && channel.v0 !== shared)
    ) return undefined;
    shared = channel.v0;
  }
  return shared ?? 0;
}

// ─── Реестр планировщика ─────────────────────────────────────────────────────

interface PlanRunState {
  readonly channels: ReadonlyMap<string, { readonly from: number; readonly to: number }>;
  readonly css: { readonly from: string | number; readonly to: string | number } | undefined;
  readonly ir: ProgressCurveIR;
  readonly startedAt: number;
}

interface PlanGroupRecord {
  _owner: PlanGroupOwner | undefined;
  /** Commit-reservation: закрывает реентри до публикации владельца (LM157). */
  _transition: boolean;
  /** Последние известные числовые значения (после завершения/фиксации). */
  readonly _numeric: Map<string, { value: number; velocity: number }>;
  _cssValue: string | number | undefined;
  /** Форма ЖИВОГО прогона: снимок владельца деривирует поканальные значения. */
  _run: PlanRunState | undefined;
}

// WeakMap: уход элемента из DOM не удерживает состояние (канон реестра).
const registry = new WeakMap<object, Map<string, PlanGroupRecord>>();

function groupRecordOf(el: object, group: string): PlanGroupRecord {
  let groups = registry.get(el);
  if (!groups) {
    groups = new Map();
    registry.set(el, groups);
  }
  let rec = groups.get(group);
  if (!rec) {
    rec = {
      _owner: undefined,
      _transition: false,
      _numeric: new Map(),
      _cssValue: undefined,
      _run: undefined,
    };
    groups.set(group, rec);
  }
  return rec;
}

/** Терминальная запись прерванного прогона по его снимку (или без — stale). */
function writeInterrupted(
  rec: PlanGroupRecord,
  run: PlanRunState | undefined,
  snapshot: ProgressSnapshot | undefined,
  formatCssAt: FormatCssAt | undefined,
): void {
  if (!run || !snapshot) return;
  const p = snapshot.value;
  run.channels.forEach((span, key) => {
    const range = span.to - span.from;
    const value = span.from + range * p;
    rec._numeric.set(key, {
      value: Number.isFinite(value) ? value : span.to,
      velocity: range * snapshot.velocity,
    });
  });
  if (run.css !== undefined) {
    // Без шва честная C⁰-деградация: последняя правда — цель прогона.
    rec._cssValue = formatCssAt?.(run.css.from, run.css.to, p) ?? run.css.to;
  }
}

// ─── Чтение холодного from (канон readStyleValue, локальная копия модели) ────

function readStyle(el: PlanTarget, cssName: string): string {
  try {
    const inline = el.style.getPropertyValue(cssName);
    if (inline !== '') return inline;
  } catch {
    /* duck-цель без полного контракта — падаем на computed/дефолт */
  }
  const gcs = (globalThis as {
    getComputedStyle?: (e: unknown) => { getPropertyValue(n: string): string };
  }).getComputedStyle;
  if (typeof gcs === 'function') {
    try {
      return gcs(el).getPropertyValue(cssName);
    } catch {
      /* не-Element цель в DOM-среде */
    }
  }
  return '';
}

// ─── Сборка transform-кадров ─────────────────────────────────────────────────

/**
 * Субнормальный сдвиг identity-края ДВИЖУЩЕГОСЯ канала: buildTransform
 * опускает identity-функции, и несимметричное опускание (x: 0→10 при живом
 * rotate) роняло бы браузер в matrix-интерполяцию вместо per-function.
 * 5e-324px / 1+2⁻⁵² визуально точные identity (CSS-парсер схлопывает в 0/1),
 * но форсируют эмиссию функции — списки совпадают по построению.
 */
function forceEmission(key: string, value: number): number {
  const identity = TRANSFORM_IDENTITY[key]!;
  if (value !== identity) return value;
  return identity === 0 ? 5e-324 : identity + Number.EPSILON;
}

/** Последовательность функций transform-строки ('none' — пустая). */
function functionSequence(transform: string): string {
  const matches = transform.match(/[a-zA-Z]+\(/g);
  return matches ? matches.join('') : '';
}

function buildTransformFrames(
  channels: readonly BoundChannel[],
  residuals: ReadonlyMap<string, number>,
): [from: string, to: string] | undefined {
  const fromState: Record<string, number> = {};
  const toState: Record<string, number> = {};
  residuals.forEach((value, key) => {
    fromState[key] = value;
    toState[key] = value;
  });
  for (const ch of channels) {
    const moving = ch.from !== ch.to;
    fromState[ch.key] = moving ? forceEmission(ch.key, ch.from) : ch.from;
    toState[ch.key] = moving ? forceEmission(ch.key, ch.to) : ch.to;
  }
  let from = buildTransform(fromState);
  let to = buildTransform(toState);
  let fromSeq = functionSequence(from);
  let toSeq = functionSequence(to);
  if (fromSeq !== toSeq && fromSeq !== '' && toSeq !== '') {
    // Второй заход: несимметричное схлопывание scale(N)↔scaleX/scaleY —
    // разводим оси эпсилоном на обоих концах и пересобираем.
    for (const state of [fromState, toState]) {
      const sy = state['scaleY'];
      if (sy !== undefined && sy === state['scaleX']) {
        state['scaleY'] = sy === 0 ? 5e-324 : sy * (1 + Number.EPSILON);
      }
    }
    from = buildTransform(fromState);
    to = buildTransform(toState);
    fromSeq = functionSequence(from);
    toSeq = functionSequence(to);
  }
  // 'none' ↔ список интерполируется per-function по спеке (identity-заполнение).
  if (fromSeq !== toSeq && fromSeq !== '' && toSeq !== '') return undefined;
  return [from, to];
}

// ─── Планировщик ─────────────────────────────────────────────────────────────

function resolveDelay(input: number | undefined): number {
  const delay = input ?? 0;
  if (!Number.isFinite(delay) || delay < 0) failPlan('LM139');
  return delay;
}

interface GroupBinding {
  readonly channels: BoundChannel[];
  readonly cssFrom: string | number | undefined;
  readonly cssTo: string | number | undefined;
  readonly residuals: Map<string, number>;
}

/** Фаза чтения одной группы: подхват C¹ из снимка владельца + residuals. */
function bindGroupState(
  el: PlanTarget,
  group: string,
  specs: readonly PlanSpec[],
  rec: PlanGroupRecord,
  formatCssAt: FormatCssAt | undefined,
): GroupBinding {
  // Один аналитический снимок на группу — вся середина полёта (канон R2).
  const owner = rec._owner;
  const run = owner !== undefined ? rec._run : undefined;
  const snap = run !== undefined ? owner!._snapshot?.() : undefined;
  const channels: BoundChannel[] = [];
  let cssFrom: string | number | undefined;
  let cssTo: string | number | undefined;

  for (const spec of specs) {
    if (spec.kind === 'num') {
      let from: number;
      let velocity = 0;
      const span = run?.channels.get(spec.key);
      if (spec.explicitFrom !== undefined) {
        // Явная пара отключает подхват (канон: рестарт из покоя).
        from = spec.explicitFrom as number;
      } else if (span !== undefined && snap !== undefined) {
        const range = span.to - span.from;
        const value = span.from + range * snap.value;
        from = Number.isFinite(value) ? value : span.to;
        velocity = range * snap.velocity;
        if (!Number.isFinite(velocity)) velocity = 0;
      } else {
        const stored = rec._numeric.get(spec.key);
        if (stored !== undefined) {
          from = stored.value;
        } else if (group === 'transform') {
          from = TRANSFORM_IDENTITY[spec.key]!;
        } else {
          const read = parseFloat(readStyle(el, group));
          from = Number.isFinite(read) ? read : 1; // opacity: дефолт браузера
        }
      }
      channels.push(bindChannel(spec.key, from, spec.to as number, velocity));
    } else {
      cssTo = spec.to;
      if (spec.explicitFrom !== undefined) {
        cssFrom = spec.explicitFrom;
      } else if (run?.css !== undefined && snap !== undefined) {
        // C¹-значение середины полёта — только через инжектированный шов;
        // без него честный C⁰-рестарт с from = текущий to (директива).
        cssFrom = formatCssAt?.(run.css.from, run.css.to, snap.value) ?? run.css.to;
      } else if (rec._cssValue !== undefined) {
        cssFrom = rec._cssValue;
      } else {
        const read = readStyle(el, group);
        // Нечитаемый источник → дискретный старт с цели (канон bindGroup).
        cssFrom = read === '' ? spec.to : read;
      }
    }
  }

  // Остаточное transform-состояние: известные каналы вне нового прогона
  // замораживаются — строка остаётся полной проекцией состояния.
  const residuals = new Map<string, number>();
  if (group === 'transform') {
    const animated = new Set(specs.map((s) => s.key));
    const known = new Set<string>(rec._numeric.keys());
    run?.channels.forEach((_span, key) => known.add(key));
    for (const key of known) {
      if (animated.has(key)) continue;
      const span = run?.channels.get(key);
      if (span !== undefined && snap !== undefined) {
        const value = span.from + (span.to - span.from) * snap.value;
        residuals.set(key, Number.isFinite(value) ? value : span.to);
      } else {
        const stored = rec._numeric.get(key);
        if (stored !== undefined) residuals.set(key, stored.value);
      }
    }
  }
  return { channels, cssFrom, cssTo, residuals };
}

/** Финальная строка группы для снапа/реестра (без нуджей — статичная запись). */
function finalGroupValue(group: string, binding: GroupBinding): string {
  if (group === 'transform') {
    const state: Record<string, number> = {};
    binding.residuals.forEach((value, key) => {
      state[key] = value;
    });
    for (const ch of binding.channels) state[ch.key] = ch.to;
    return buildTransform(state);
  }
  if (binding.cssTo !== undefined) return String(binding.cssTo);
  return String(binding.channels[0]!.to);
}

/** Терминальная запись реестра: снап/натуральный финиш (значения = цели). */
function commitFinal(rec: PlanGroupRecord, binding: GroupBinding): void {
  for (const ch of binding.channels) {
    rec._numeric.set(ch.key, { value: ch.to, velocity: 0 });
  }
  if (binding.cssTo !== undefined) rec._cssValue = binding.cssTo;
}

export function buildCompositorPlan(
  options: CompositorPlanOptions,
): CompositorPlanResult {
  // Каждое поле опций читается один раз (hostile getters — read-once граница).
  const targets = options.targets;
  const props = options.props;
  const mode = options.mode;
  const baseDelay = options.delayMs;
  const targetDelays = options.targetDelays;
  const seams = options.seams;
  const capability = options.capability;
  const matchMedia = options.matchMedia;
  const reducedInput = options.reducedMotion;
  const formatCssAt = options.formatCssAt;
  const signal = options.signal;

  // Валидация ДО чтений состояния: props (LM140–144), задержки (LM139).
  const specs = parsePlanProps(props);
  const groups = new Map<string, PlanSpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec.group);
    if (list) list.push(spec);
    else groups.set(spec.group, [spec]);
  }
  const base = resolveDelay(baseDelay);
  const delays: number[] = [];
  for (let i = 0; i < targets.length; i++) {
    delays.push(resolveDelay(targetDelays?.[i] ?? base));
  }

  // Политика доступности — один snapshot на план (канон фасада).
  const reduced =
    targets.length > 0 && (reducedInput ?? prefersReduced(matchMedia));
  const linear = capability?.linearSupported === true;

  // Кривая компилируется один раз на различимый v0 (N целей = 1 компиляция
  // в холодном большинстве); tween-кривая одна на весь план.
  let tweenIr: ProgressCurveIR | undefined;
  const springIrByV0 = new Map<number, ProgressCurveIR | undefined>();
  const curveFor = (v0: number): ProgressCurveIR | undefined => {
    if (mode.kind === 'tween') {
      return (tweenIr ??= easeProgressCurve(mode.ease, mode.durationMs));
    }
    if (!springIrByV0.has(v0)) {
      springIrByV0.set(v0, springProgressCurve(mode.spring, v0));
    }
    return springIrByV0.get(v0);
  };

  const plans: PlannedUnitGroup[] = [];
  const snaps: PlannedSnapGroup[] = [];
  const live: PlannedLiveGroup[] = [];

  for (let i = 0; i < targets.length; i++) {
    const el = targets[i]!;
    const delayMs = delays[i]!;
    const waapi = typeof el.animate === 'function';
    for (const [group, list] of groups) {
      const rec = groupRecordOf(el, group);
      // Фаза чтения: подхват состояния БЕЗ прерывания владельца.
      const binding = bindGroupState(el, group, list, rec, formatCssAt);

      if (reduced) {
        snaps.push(makeSnapEntry(el, group, rec, binding));
        continue;
      }

      const toLive = (reason: PlannedLiveGroup['reason']): void => {
        live.push({
          kind: 'live',
          el,
          group,
          delayMs,
          reason,
          numeric: binding.channels.map((ch) => ({
            key: ch.key,
            from: ch.from,
            to: ch.to,
            velocity: ch.velocity,
          })),
          css:
            binding.cssTo === undefined
              ? undefined
              : { from: binding.cssFrom!, to: binding.cssTo },
        });
      };

      if (!waapi) {
        toLive('no-waapi');
        continue;
      }
      // v0 группы: у tween подхват C⁰ по построению (кривая без импульса).
      const v0 = mode.kind === 'spring' ? sharedGroupV0(binding.channels) : 0;
      if (v0 === undefined) {
        toLive('v0-mismatch');
        continue;
      }
      const ir = curveFor(v0);
      if (ir === undefined) {
        toLive('curve-budget');
        continue;
      }

      // Кадры собираются один раз; интерполяция значений — у браузера.
      let keyframes: readonly [string | number, string | number] | undefined;
      if (group === 'transform') {
        keyframes = buildTransformFrames(binding.channels, binding.residuals);
      } else if (binding.cssTo !== undefined) {
        keyframes = [binding.cssFrom!, binding.cssTo];
      } else {
        const ch = binding.channels[0]!;
        keyframes = [ch.from, ch.to];
      }
      const numericPair =
        keyframes !== undefined &&
        typeof keyframes[0] === 'number' &&
        typeof keyframes[1] === 'number';
      // Explicit-кадры представляют только числовые пары (контракт юнита R2);
      // непредставимая символьная пара уходит на живой путь ДО фабрики.
      if (keyframes === undefined || (!linear && !numericPair)) {
        toLive('explicit-non-numeric');
        continue;
      }

      plans.push(makeUnitEntry(
        el,
        group,
        rec,
        binding,
        {
          el: el as CompositorUnitTarget,
          group,
          keyframes,
          ir,
          delayMs,
          seams,
          capability,
          signal,
        },
        formatCssAt,
        seams,
      ));
    }
  }
  return { plans, snaps, live };
}

// ─── Commit-хуки (единственные писатели реестра/DOM) ─────────────────────────

function makeSnapEntry(
  el: PlanTarget,
  group: string,
  rec: PlanGroupRecord,
  binding: GroupBinding,
): PlannedSnapGroup {
  return {
    kind: 'snap',
    el,
    group,
    commit(): void {
      if (rec._transition) failPlan('LM157');
      rec._transition = true;
      const previous = rec._owner;
      const write = (): void => el.style.setProperty(group, finalGroupValue(group, binding));
      try {
        if (previous) previous._supersede(write);
        else write();
      } catch (error) {
        rec._transition = false;
        throw error;
      }
      rec._owner = undefined;
      rec._run = undefined;
      commitFinal(rec, binding);
      rec._transition = false;
    },
  };
}

function makeUnitEntry(
  el: PlanTarget,
  group: string,
  rec: PlanGroupRecord,
  binding: GroupBinding,
  plan: CompositorUnitPlan,
  formatCssAt: FormatCssAt | undefined,
  seams: CompositorUnitSeams,
): PlannedUnitGroup {
  const runState = (): PlanRunState => {
    const channels = new Map<string, { from: number; to: number }>();
    for (const ch of binding.channels) {
      channels.set(ch.key, { from: ch.from, to: ch.to });
    }
    let startedAt = 0;
    try {
      startedAt = seams.now();
    } catch {
      /* отказ часов не рвёт публикацию — поле информационное */
    }
    return {
      channels,
      css:
        binding.cssTo === undefined
          ? undefined
          : { from: binding.cssFrom!, to: binding.cssTo },
      ir: plan.ir,
      startedAt,
    };
  };
  return {
    kind: 'unit',
    el,
    group,
    plan,
    begin(): void {
      // Канон LM157: commit-reservation закрывает реентри до публикации.
      if (rec._transition) failPlan('LM157');
      rec._transition = true;
    },
    publish(owner: PlanGroupOwner): void {
      const previous = rec._owner;
      try {
        if (previous) {
          // Снимок ДО прерывания — терминальная правда прерванного прогона.
          const snap = previous._snapshot?.();
          previous._supersede();
          writeInterrupted(rec, rec._run, snap, formatCssAt);
        }
      } catch (error) {
        // Сбой прерывания: successor откатывается, прежний владелец жив.
        try {
          owner._rollback();
        } catch {
          /* best-effort: приоритет — исходная причина */
        }
        rec._transition = false;
        throw error;
      }
      rec._owner = owner;
      rec._run = runState();
      rec._transition = false;
    },
    rollback(): void {
      rec._transition = false;
    },
    settle(owner: PlanGroupOwner, natural: boolean, snapshot?: ProgressSnapshot): void {
      if (rec._owner !== owner) return;
      rec._owner = undefined;
      const run = rec._run;
      rec._run = undefined;
      if (natural) {
        commitFinal(rec, binding);
        return;
      }
      writeInterrupted(rec, run, snapshot, formatCssAt);
    },
  };
}
