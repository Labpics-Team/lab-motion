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
 *   - синтаксическая граница LM144 держится грамматикой юнитов (matchesUnitGrammar,
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
import { matchesUnitGrammar } from '../value/units.js';
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
  readonly _targets: readonly PlanTarget[];
  readonly _props: Record<string, unknown>;
  /**
   * Пред-разобранные спецификации (parsePlanProps). Фасад валидирует props ДО
   * резолва целей (канон fail-fast порядка) и передаёт результат сюда — props
   * тогда не читается повторно (hostile getters остаются read-once).
   */
  readonly _specs?: readonly PlanSpec[] | undefined;
  readonly _mode: PlanMode;
  /** Базовая задержка (мс) всем целям; scheduleStagger остаётся у фасада. */
  readonly _delayMs?: number | undefined;
  /** Готовые пер-целевые задержки (уже сложенные с base фасадом). */
  readonly _targetDelays?: readonly number[] | undefined;
  readonly _seams: CompositorUnitSeams;
  readonly _capability: CompositorUnitCapability;
  /** Политика доступности — канон фасада (prefersReduced). */
  readonly _matchMedia?: ((query: string) => { matches: boolean }) | undefined;
  /** Явное перекрытие политики (детеминизм тестов/фасадный snapshot). */
  readonly _reducedMotion?: boolean | undefined;
  readonly _formatCssAt?: FormatCssAt | undefined;
  readonly _signal?: AbortSignalLike | undefined;
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
  readonly _kind: 'unit';
  readonly _el: PlanTarget;
  readonly _group: string;
  readonly _plan: CompositorUnitPlan;
  /** Commit-резерв записи: LM157 при реентри той же (el, group). */
  _begin(): void;
  /**
   * Прерывает прежнего владельца (с терминальной записью его снимка в реестр)
   * и публикует successor. Канон дубликатов: successor уже создан вызывающим.
   * Бросок supersede откатывает successor (_rollback) и снимает резерв.
   */
  _publish(owner: PlanGroupOwner): void;
  /** Сбой создания successor до publish: прежний владелец жив. */
  _rollback(): void;
  /** Терминальная запись реестра владельцем (natural / прерывание со снимком). */
  _settle(owner: PlanGroupOwner, natural: boolean, snapshot?: ProgressSnapshot): void;
}

/** Reduced/финал: писатель финала — отдельная запись плана, юнит не создаётся. */
export interface PlannedSnapGroup {
  readonly _kind: 'snap';
  readonly _el: PlanTarget;
  readonly _group: string;
  /**
   * Снап-семантика фасада: резерв → supersede прежнего владельца с writer
   * в роли replacement (или прямой writer) → терминальная запись реестра.
   */
  _commit(): void;
}

/**
 * Группа, не представимая синхронной WAAPI-кривой. Судьбу решает фасад:
 * зарегистрированный композируемый движок исполняет её живьём (ownership-хуки
 * идентичны юнит-пути: живой ран — полноправный владелец с C¹-снимком),
 * без движка — валидированный снап к финалу (snap(), контракт базы R3b).
 */
export interface PlannedLiveGroup {
  readonly _kind: 'live';
  readonly _el: PlanTarget;
  readonly _group: string;
  readonly _delayMs: number;
  readonly _reason:
    | 'no-waapi'
    | 'v0-mismatch'
    | 'curve-budget'
    | 'explicit-non-numeric';
  /** Подхваченные каналы для живого движка (абсолютные величины, units/s). */
  readonly _numeric: readonly {
    readonly _key: string;
    readonly _from: number;
    readonly _to: number;
    readonly _velocity: number;
  }[];
  readonly _css: { readonly _from: string | number; readonly _to: string | number } | undefined;
  /** Замороженные transform-каналы вне прогона: живой писатель их сохраняет. */
  readonly _residuals: ReadonlyMap<string, number>;
  _begin(): void;
  _publish(owner: PlanGroupOwner): void;
  _rollback(): void;
  _settle(owner: PlanGroupOwner, natural: boolean, snapshot?: ProgressSnapshot): void;
  /** Деградация базового фасада: валидированный снап к финалу (канон reduced). */
  _snap(): void;
}

export type PlannedGroup = PlannedUnitGroup | PlannedSnapGroup | PlannedLiveGroup;

export interface CompositorPlanResult {
  readonly _plans: PlannedUnitGroup[];
  readonly _snaps: PlannedSnapGroup[];
  readonly _live: PlannedLiveGroup[];
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

/** Спецификация канала: результат parsePlanProps (валидированный вход). */
export interface PlanSpec {
  readonly _kind: 'num' | 'css';
  readonly _key: string;
  readonly _group: string;
  readonly _explicitFrom: number | string | undefined;
  readonly _to: number | string;
}

function requireFinite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) failPlan('LM142');
  return value;
}

/**
 * Синтаксическая граница css-значения БЕЗ цветового движка: число (конечное),
 * грамматика юнитов/var()/relative (matchesUnitGrammar — та же огибающая,
 * что tryParseUnit value-движка: единый источник регексов, ноль дубля
 * грамматики и ноль AST-строителей в базовом графе) либо head цвета (канон голов
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
    !matchesUnitGrammar(source) &&
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
          specs.push({ _kind: 'num', _key: 'scaleX', _group: group, _explicitFrom: explicitFrom, _to: to });
        }
        if (!keys.includes('scaleY')) {
          specs.push({ _kind: 'num', _key: 'scaleY', _group: group, _explicitFrom: explicitFrom, _to: to });
        }
      } else {
        specs.push({ _kind: 'num', _key: key, _group: group, _explicitFrom: explicitFrom, _to: to });
      }
    } else {
      specs.push({
        _kind: 'css',
        _key: key,
        _group: camelToKebab(key),
        _explicitFrom: pair ? requireCssValue(pair[0]) : undefined,
        _to: requireCssValue(pair ? pair[1] : raw),
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
  readonly _key: string;
  readonly _from: number;
  readonly _to: number;
  readonly _velocity: number;
  /** Представимая солвером цель (канон LM150: вырожденный диапазон с импульсом). */
  readonly _solverTo: number;
  readonly _v0: number;
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
  return { _key: key, _from: from, _to: to, _velocity: velocity, _solverTo: solverTo, _v0: normalizeV0(velocity, solverTo - from) };
}

/**
 * Единый v0 группы (канон sharedV0): статичные каналы без импульса прозрачны;
 * подменённая solver-амплитуда либо разошедшиеся v0 → undefined (живой путь:
 * WAAPI-кривая одна на группу и обязана кодировать общий прогресс).
 */
function sharedGroupV0(channels: readonly BoundChannel[]): number | undefined {
  let shared: number | undefined;
  for (const channel of channels) {
    if (channel._to === channel._from && channel._velocity === 0) continue;
    if (
      channel._solverTo !== channel._to ||
      (shared !== undefined && channel._v0 !== shared)
    ) return undefined;
    shared = channel._v0;
  }
  return shared ?? 0;
}

// ─── Реестр планировщика ─────────────────────────────────────────────────────

interface PlanRunState {
  readonly _channels: ReadonlyMap<string, { readonly _from: number; readonly _to: number }>;
  readonly _css: { readonly _from: string | number; readonly _to: string | number } | undefined;
  /** IR прогона; у живого владельца кривой нет — undefined (информационное). */
  readonly _ir: ProgressCurveIR | undefined;
  readonly _startedAt: number;
}

interface PlanGroupRecord {
  _owner: PlanGroupOwner | undefined;
  /** Commit-reservation: закрывает реентри до публикации владельца (LM157). */
  _transition: boolean;
  /** Последние известные числовые значения (после завершения/фиксации). */
  readonly _numeric: Map<string, { _value: number; _velocity: number }>;
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
  const p = snapshot._value;
  run._channels.forEach((span, key) => {
    const range = span._to - span._from;
    const value = span._from + range * p;
    rec._numeric.set(key, {
      _value: Number.isFinite(value) ? value : span._to,
      _velocity: range * snapshot._velocity,
    });
  });
  if (run._css !== undefined) {
    // Без шва честная C⁰-деградация: последняя правда — цель прогона.
    rec._cssValue = formatCssAt?.(run._css._from, run._css._to, p) ?? run._css._to;
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
    const moving = ch._from !== ch._to;
    fromState[ch._key] = moving ? forceEmission(ch._key, ch._from) : ch._from;
    toState[ch._key] = moving ? forceEmission(ch._key, ch._to) : ch._to;
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
  readonly _channels: BoundChannel[];
  readonly _cssFrom: string | number | undefined;
  readonly _cssTo: string | number | undefined;
  readonly _residuals: Map<string, number>;
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
    if (spec._kind === 'num') {
      let from: number;
      let velocity = 0;
      const span = run?._channels.get(spec._key);
      if (spec._explicitFrom !== undefined) {
        // Явная пара отключает подхват (канон: рестарт из покоя).
        from = spec._explicitFrom as number;
      } else if (span !== undefined && snap !== undefined) {
        const range = span._to - span._from;
        const value = span._from + range * snap._value;
        from = Number.isFinite(value) ? value : span._to;
        velocity = range * snap._velocity;
        if (!Number.isFinite(velocity)) velocity = 0;
      } else {
        const stored = rec._numeric.get(spec._key);
        if (stored !== undefined) {
          from = stored._value;
        } else if (group === 'transform') {
          from = TRANSFORM_IDENTITY[spec._key]!;
        } else {
          const read = parseFloat(readStyle(el, group));
          from = Number.isFinite(read) ? read : 1; // opacity: дефолт браузера
        }
      }
      channels.push(bindChannel(spec._key, from, spec._to as number, velocity));
    } else {
      cssTo = spec._to;
      if (spec._explicitFrom !== undefined) {
        cssFrom = spec._explicitFrom;
      } else if (run?._css !== undefined && snap !== undefined) {
        // C¹-значение середины полёта — только через инжектированный шов;
        // без него честный C⁰-рестарт с from = текущий to (директива).
        cssFrom = formatCssAt?.(run._css._from, run._css._to, snap._value) ?? run._css._to;
      } else if (rec._cssValue !== undefined) {
        cssFrom = rec._cssValue;
      } else {
        const read = readStyle(el, group);
        // Нечитаемый источник → дискретный старт с цели (канон bindGroup).
        cssFrom = read === '' ? spec._to : read;
      }
    }
  }

  // Остаточное transform-состояние: известные каналы вне нового прогона
  // замораживаются — строка остаётся полной проекцией состояния.
  const residuals = new Map<string, number>();
  if (group === 'transform') {
    const animated = new Set(specs.map((s) => s._key));
    const known = new Set<string>(rec._numeric.keys());
    run?._channels.forEach((_span, key) => known.add(key));
    for (const key of known) {
      if (animated.has(key)) continue;
      const span = run?._channels.get(key);
      if (span !== undefined && snap !== undefined) {
        const value = span._from + (span._to - span._from) * snap._value;
        residuals.set(key, Number.isFinite(value) ? value : span._to);
      } else {
        const stored = rec._numeric.get(key);
        if (stored !== undefined) residuals.set(key, stored._value);
      }
    }
  }
  return { _channels: channels, _cssFrom: cssFrom, _cssTo: cssTo, _residuals: residuals };
}

/** Финальная строка группы для снапа/реестра (без нуджей — статичная запись). */
function finalGroupValue(group: string, binding: GroupBinding): string {
  if (group === 'transform') {
    const state: Record<string, number> = {};
    binding._residuals.forEach((value, key) => {
      state[key] = value;
    });
    for (const ch of binding._channels) state[ch._key] = ch._to;
    return buildTransform(state);
  }
  if (binding._cssTo !== undefined) return String(binding._cssTo);
  return String(binding._channels[0]!._to);
}

/** Терминальная запись реестра: снап/натуральный финиш (значения = цели). */
function commitFinal(rec: PlanGroupRecord, binding: GroupBinding): void {
  for (const ch of binding._channels) {
    rec._numeric.set(ch._key, { _value: ch._to, _velocity: 0 });
  }
  if (binding._cssTo !== undefined) rec._cssValue = binding._cssTo;
}

export function buildCompositorPlan(
  options: CompositorPlanOptions,
): CompositorPlanResult {
  // Каждое поле опций читается один раз (hostile getters — read-once граница).
  const targets = options._targets;
  const props = options._props;
  const preParsed = options._specs;
  const mode = options._mode;
  const baseDelay = options._delayMs;
  const targetDelays = options._targetDelays;
  const seams = options._seams;
  const capability = options._capability;
  const matchMedia = options._matchMedia;
  const reducedInput = options._reducedMotion;
  const formatCssAt = options._formatCssAt;
  const signal = options._signal;

  // Валидация ДО чтений состояния: props (LM140–144), задержки (LM139).
  // Пред-разобранные specs фасада исключают повторное чтение hostile props.
  const specs = preParsed ?? parsePlanProps(props);
  const groups = new Map<string, PlanSpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec._group);
    if (list) list.push(spec);
    else groups.set(spec._group, [spec]);
  }
  const base = resolveDelay(baseDelay);
  const delays: number[] = [];
  for (let i = 0; i < targets.length; i++) {
    delays.push(resolveDelay(targetDelays?.[i] ?? base));
  }

  // Политика доступности — один snapshot на план (канон фасада).
  const reduced =
    targets.length > 0 && (reducedInput ?? prefersReduced(matchMedia));
  const linear = capability?._linearSupported === true;

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
    // Capability не читается при reduced: политика доступности снимается один
    // раз на план и не трогает hostile WAAPI-поля целей (канон фасада).
    const waapi = reduced ? false : typeof el.animate === 'function';
    for (const [group, list] of groups) {
      const rec = groupRecordOf(el, group);
      // Фаза чтения: подхват состояния БЕЗ прерывания владельца.
      const binding = bindGroupState(el, group, list, rec, formatCssAt);

      if (reduced) {
        snaps.push(makeSnapEntry(el, group, rec, binding));
        continue;
      }

      const toLive = (reason: PlannedLiveGroup['_reason']): void => {
        live.push({
          _kind: 'live',
          _el: el,
          _group: group,
          _delayMs: delayMs,
          _reason: reason,
          _numeric: binding._channels.map((ch) => ({
            _key: ch._key,
            _from: ch._from,
            _to: ch._to,
            _velocity: ch._velocity,
          })),
          _css:
            binding._cssTo === undefined
              ? undefined
              : { _from: binding._cssFrom!, _to: binding._cssTo },
          _residuals: binding._residuals,
          ...makeOwnershipHooks(rec, binding, formatCssAt, seams, undefined),
          _snap(): void {
            snapCommit(el, group, rec, binding);
          },
        });
      };

      if (!waapi) {
        toLive('no-waapi');
        continue;
      }
      // v0 группы: у tween подхват C⁰ по построению (кривая без импульса).
      const v0 = mode.kind === 'spring' ? sharedGroupV0(binding._channels) : 0;
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
        keyframes = buildTransformFrames(binding._channels, binding._residuals);
      } else if (binding._cssTo !== undefined) {
        keyframes = [binding._cssFrom!, binding._cssTo];
      } else {
        const ch = binding._channels[0]!;
        keyframes = [ch._from, ch._to];
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
          _el: el as CompositorUnitTarget,
          _group: group,
          _keyframes: keyframes,
          _ir: ir,
          _delayMs: delayMs,
          _seams: seams,
          _capability: capability,
          _signal: signal,
        },
        formatCssAt,
        seams,
      ));
    }
  }
  return { _plans: plans, _snaps: snaps, _live: live };
}

// ─── Commit-хуки (единственные писатели реестра/DOM) ─────────────────────────

/** Снап-запись как функция: писатель финала + supersede-канон + реестр. */
function snapCommit(
  el: PlanTarget,
  group: string,
  rec: PlanGroupRecord,
  binding: GroupBinding,
): void {
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
}

function makeSnapEntry(
  el: PlanTarget,
  group: string,
  rec: PlanGroupRecord,
  binding: GroupBinding,
): PlannedSnapGroup {
  return {
    _kind: 'snap',
    _el: el,
    _group: group,
    _commit(): void {
      snapCommit(el, group, rec, binding);
    },
  };
}

/** Ownership-протокол, общий для юнит- и живых групп (владелец = любой ран). */
interface OwnershipHooks {
  _begin(): void;
  _publish(owner: PlanGroupOwner): void;
  _rollback(): void;
  _settle(owner: PlanGroupOwner, natural: boolean, snapshot?: ProgressSnapshot): void;
}

function makeOwnershipHooks(
  rec: PlanGroupRecord,
  binding: GroupBinding,
  formatCssAt: FormatCssAt | undefined,
  seams: CompositorUnitSeams,
  ir: ProgressCurveIR | undefined,
): OwnershipHooks {
  const runState = (): PlanRunState => {
    const channels = new Map<string, { _from: number; _to: number }>();
    for (const ch of binding._channels) {
      channels.set(ch._key, { _from: ch._from, _to: ch._to });
    }
    let startedAt = 0;
    try {
      startedAt = seams._now();
    } catch {
      /* отказ часов не рвёт публикацию — поле информационное */
    }
    return {
      _channels: channels,
      _css:
        binding._cssTo === undefined
          ? undefined
          : { _from: binding._cssFrom!, _to: binding._cssTo },
      _ir: ir,
      _startedAt: startedAt,
    };
  };
  return {
    _begin(): void {
      // Канон LM157: commit-reservation закрывает реентри до публикации.
      if (rec._transition) failPlan('LM157');
      rec._transition = true;
    },
    _publish(owner: PlanGroupOwner): void {
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
    _rollback(): void {
      rec._transition = false;
    },
    _settle(owner: PlanGroupOwner, natural: boolean, snapshot?: ProgressSnapshot): void {
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

function makeUnitEntry(
  el: PlanTarget,
  group: string,
  rec: PlanGroupRecord,
  binding: GroupBinding,
  plan: CompositorUnitPlan,
  formatCssAt: FormatCssAt | undefined,
  seams: CompositorUnitSeams,
): PlannedUnitGroup {
  return {
    _kind: 'unit',
    _el: el,
    _group: group,
    _plan: plan,
    ...makeOwnershipHooks(rec, binding, formatCssAt, seams, plan._ir),
  };
}
