/**
 * animate/channels.ts — доменная модель каналов фасада ./animate.
 *
 * Канал — независимая ось движения одного элемента: transform-шортхенд
 * (x/y/scale/rotate/…, сливаются в ОДНУ transform-строку), opacity или
 * произвольное CSS-свойство (интерполяция через ./value). Здесь живут:
 * разбор props → спецификации каналов (валидация ДО любых побочных эффектов),
 * реестр состояния по элементам (подхват скорости/значения при повторном
 * animate — канон MotionValue smooth-pickup) и форматирование записи в стиль.
 *
 * Инварианты (наследуют ядро): SSR-safe (чтение DOM только в момент вызова),
 * финитность (не-конечный вход → ранний MotionParamError; выходы стерилизуют
 * buildTransform/interpolate), детерминизм (никаких глобальных часов).
 */

import { MotionParamError } from '../errors.js';
import { interpolateColor } from '../value/color.js';
import type { ValueAST } from '../value/parse.js';
import { tryParseValue } from '../value/parse.js';
import {
  interpolateUnit,
  type ParsedRelative,
  type ParsedUnit,
  type ParsedVar,
} from '../value/units.js';

// ─── Ключи transform-шортхендов (словарь = TransformState ядра ./value) ──────

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

/**
 * Является ли ключ props transform-шортхендом. Проверка `typeof ...==='number'`
 * (а не `key in`) отсекает УНАСЛЕДОВАННЫЕ constructor/toString/__proto__: они
 * функции/объект, не число — иначе классифицировались бы как transform-канал.
 */
export function isTransformKey(key: string): boolean {
  return typeof TRANSFORM_IDENTITY[key] === 'number';
}

// ─── Спецификации каналов (до привязки к элементу) ───────────────────────────

/** Группа записи: одна CSS-декларация на кадр. */
export type GroupKey = string; // 'transform' | 'opacity' | kebab-case CSS-имя

/** Числовой канал (transform-шортхенд или opacity): физика в пространстве значения. */
export interface NumericChannelSpec {
  readonly _kind: 'num';
  readonly _key: string;
  readonly _group: GroupKey;
  /** Явный from из пары [from, to]; undefined — резолв из реестра/стиля. */
  readonly _explicitFrom: number | undefined;
  readonly _to: number;
}

/** CSS-канал (цвет/юниты через ./value): физика в прогресс-пространстве [0..1]. */
export interface CssChannelSpec {
  readonly _kind: 'css';
  readonly _key: string;
  readonly _group: GroupKey;
  readonly _explicitFrom: ValueAST | undefined;
  readonly _to: ValueAST;
}

export type ChannelSpec = NumericChannelSpec | CssChannelSpec;

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function requireFinite(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MotionParamError('LM142');
  }
  return v;
}

function parseCssValue(v: unknown): ValueAST {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new MotionParamError('LM142');
  }
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new MotionParamError('LM143');
  }
  const parsed = tryParseValue(v);
  if (parsed === undefined) throw new MotionParamError('LM144');
  return parsed;
}

/**
 * Разбирает props в спецификации каналов. Бросает MotionParamError рано —
 * ДО каких-либо записей в стиль (не-конечные числа, целиком 'transform',
 * нераспознанные CSS-значения). Пара [from, to] задаёт явный from.
 */
export function parseProps(props: Record<string, unknown>): ChannelSpec[] {
  const specs: ChannelSpec[] = [];
  const keys = Object.keys(props);
  for (const key of keys) {
    const raw = props[key];
    if (key === 'transform') {
      throw new MotionParamError('LM140');
    }
    const pair = Array.isArray(raw) ? raw : undefined;
    if (pair && pair.length !== 2) {
      throw new MotionParamError('LM141');
    }
    if (isTransformKey(key) || key === 'opacity') {
      const group: GroupKey = key === 'opacity' ? 'opacity' : 'transform';
      const explicitFrom = pair ? requireFinite(pair[0]) : undefined;
      const to = requireFinite(pair ? pair[1] : raw);
      // Full-движок хранит scale как две независимые физические оси. Равные
      // значения всё равно сериализуются в компактный scale(N), зато переход
      // uniform↔axial не меняет представление: обе позиции и pickup-скорость
      // перехватываемого канала остаются явными.
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
        _explicitFrom: pair ? parseCssValue(pair[0]) : undefined,
        _to: parseCssValue(pair ? pair[1] : raw),
      });
    }
  }
  return specs;
}

// ─── Привязанные каналы (живое состояние прогона) ────────────────────────────

/** Числовой канал в полёте: from/to/v0 + последнее эмитнутое состояние. */
export interface NumericChannel {
  readonly _key: string;
  readonly _from: number;
  readonly _to: number;
  /** Численно представимая цель солвера; финальный snap всё равно идёт в to. */
  readonly _solverTo: number;
  /** Нормализованная стартовая скорость (канон солвера: v0 / range). */
  readonly _v0: number;
  _value: number;
  _velocity: number;
  /** Последнее состояние, которое успешно прошло host write. */
  _renderedValue: number;
  _renderedVelocity: number;
}

/** CSS-канал в полёте: прогресс-пространство + последняя эмитнутая строка. */
export interface CssChannel {
  readonly _key: string;
  readonly _fromAst: ValueAST;
  readonly _toAst: ValueAST;
  /**
   * Стартовая скорость прогресса (прогресс/с). Явная пара [from, to] — 0
   * (покой, канон числовых каналов); перехват живого рана — проекция ṗ̂
   * источника между прогресс-пространствами (projectCssV0, C¹-контракт #93).
   */
  readonly _v0: number;
  /** Текущая производная прогресса ṗ (прогресс/с) — сырьё C¹-подхвата. */
  _dpdt: number;
  _css: string | number;
  _renderedDpdt: number;
  _renderedCss: string | number;
}

/** Порог вырожденного диапазона (зеркалит RANGE_EPSILON compositor-пути). */
export const RANGE_EPSILON = 1e-10;

/**
 * Нормализация скорости подхвата: v0 = velocity / range (канон MotionValue).
 * `+ 0` схлопывает −0 (velocity 0 при range<0 и наоборот) для всех вызовов.
 */
export function normalizeV0(velocity: number, range: number): number {
  if (!(Math.abs(range) > RANGE_EPSILON)) return 0;
  const v0 = velocity / range;
  return Number.isFinite(v0) ? v0 + 0 : 0;
}

/**
 * Строит числовой канал из абсолютного снимка. Вырожденный целевой диапазон
 * получает минимальную представимую solver-амплитуду: произведение этой
 * амплитуды на нормализованный v0 сохраняет исходный абсолютный импульс, а
 * публичный `to` остаётся точной финальной целью для snap.
 */
function numericChannel(
  key: string,
  from: number,
  to: number,
  velocity: number,
): NumericChannel {
  const range = to - from;
  const representableRange = Math.max(
    RANGE_EPSILON,
    Math.abs(from) * Number.EPSILON,
  );
  let solverTo = to;
  if (!(Math.abs(range) > RANGE_EPSILON) && velocity !== 0) {
    solverTo = from + (velocity < 0 ? -representableRange : representableRange);
    if (!Number.isFinite(solverTo) || solverTo === from) {
      throw new MotionParamError('LM150');
    }
  }
  return {
    _key: key,
    _from: from,
    _to: to,
    _solverTo: solverTo,
    _v0: normalizeV0(velocity, solverTo - from),
    _value: from,
    _velocity: velocity,
    _renderedValue: from,
    _renderedVelocity: velocity,
  };
}

/** Устойчивая позиция канала: взвешенная форма не переполняет MAX ↔ -MAX. */
export function channelAt(channel: NumericChannel, progress: number): number {
  if (progress === 0) return channel._from;
  if (progress === 1) return channel._to;
  const value = (1 - progress) * channel._from + progress * channel._to;
  return Number.isFinite(value) ? value : channel._to;
}

/**
 * Пересевает каналы из их текущего абсолютного снимка для live-движка.
 * Единственный конструктор выше не даёт initial bind и WAAPI→live handoff
 * разойтись в политике нулевого диапазона.
 */
export function rebaseNumericChannels(
  channels: readonly NumericChannel[],
): NumericChannel[] {
  return channels.map((channel) =>
    numericChannel(channel._key, channel._value, channel._to, channel._velocity),
  );
}

/**
 * Единый прогресс WAAPI существует только при строго общем нормализованном v0.
 * Даже малая разница означает разные физические кривые; tolerance здесь скрыл
 * бы разрыв скорости одного из каналов. Пустая группа канонически покоится.
 */
export function sharedV0(channels: readonly NumericChannel[]): number | undefined {
  const shared = channels[0]?._v0 ?? 0;
  for (let i = 1; i < channels.length; i++) {
    if (channels[i]!._v0 !== shared) return undefined;
  }
  return shared;
}

/**
 * Покомпонентный вектор спана from→to; undefined — скорость не определена:
 * var()/relative/смешанные виды остаются C⁰ (дискретная или базо-зависимая
 * интерполяция). Цвет — r/g/b; альфа не участвует в выборе доминанты (её спан
 * ≤ 1 против 255 — недоминантна), её подхват C⁰.
 */
function spanVec(from: ValueAST, to: ValueAST): number[] | undefined {
  if (from.kind === 'color' && to.kind === 'color') {
    return [to.r - from.r, to.g - from.g, to.b - from.b];
  }
  if (from.kind === 'unit' && to.kind === 'unit') return [to.value - from.value];
  return undefined;
}

/**
 * Проекция скорости css-канала между прогресс-пространствами при перехвате
 * (C¹-контракт #93): скорость значения по компоненту i равна ṗ̂·Δold_i, новая
 * скорость прогресса — её нормировка на новый спан. i — ДОМИНАНТНЫЙ компонент
 * НОВОГО спана (канон projection/driver: доминанта всегда по целевому
 * диапазону — иначе малый b[i] при большом a[i] взрывает
 * усиление на неколлинеарном цветовом ретаргете). Для юнитных значений (1
 * компонент) и коллинеарных ретаргетов проекция точна. Несовместимые виды AST
 * (var(), unit×color) → 0; длины определённых спанов совпадают по построению:
 * fromAst нового спана bindGroup реконструирует из live.css (оба цветовые либо
 * оба юнитные — иначе undefined выше); −0 схлопывает normalizeV0.
 */
function projectCssV0(live: CssChannel, fromAst: ValueAST, toAst: ValueAST): number {
  const a = spanVec(live._fromAst, live._toAst);
  const b = spanVec(fromAst, toAst);
  if (!a || !b) return 0; // undefined-гейт: определённый спан — непустой массив (truthy)
  let i = 0;
  for (let k = 1; k < b.length; k++) {
    if (Math.abs(b[k]!) > Math.abs(b[i]!)) i = k;
  }
  return normalizeV0(live._dpdt * a[i]!, b[i]!);
}

// ─── Реестр состояния по элементам ───────────────────────────────────────────

/** Снимок числового канала (значение + скорость units/s). */
export interface ChannelSnapshot {
  readonly _value: number;
  readonly _velocity: number;
}

/**
 * Живой владелец группы — юнит, чей прогон можно прервать с подхватом
 * (capture → supersede). Оба движка (rAF и WAAPI) реализуют этот контракт.
 */
export interface GroupOwner {
  /** Снимает резерв при rollback до supersede. */
  _release?(): void;
  /** Фиксирует общий снимок до поканального чтения stateful host-часов. */
  _capture?(): void;
  /** Аналитический снимок числового канала в момент прерывания. */
  _captureNum(key: string): ChannelSnapshot | undefined;
  /** Живой CSS-канал в момент прерывания (значение + ṗ для C¹-проекции). */
  _captureCss(key: string): CssChannel | undefined;
  /** Ключи числовых каналов прогона (для остаточного transform-состояния). */
  _numericKeys(): readonly string[];
  /**
   * Прервать прогон. Опциональный replacement пишется до destructive cleanup:
   * его отказ оставляет старого владельца живым и повторяемым.
   */
  _supersede(replacement?: () => void): void;
}

/** Запись группы: живой владелец + последнее известное состояние каналов. */
export interface GroupRecord {
  _owner: GroupOwner | undefined;
  /** Commit-reservation закрывает reentry даже до публикации первого owner. */
  _transition: boolean;
  /** Последние известные числовые значения по субканалам (после settle/cancel). */
  readonly _numeric: Map<string, ChannelSnapshot>;
  /** Последнее известное значение CSS-канала. */
  _cssValue: string | number | undefined;
}

/**
 * Реестр фасада: элемент → группа → запись. WeakMap — уход элемента из DOM
 * не удерживает состояние (нет утечки). Модульный синглтон: повторный
 * animate из любого места видит один и тот же прогон.
 */
const registry = new WeakMap<object, Map<GroupKey, GroupRecord>>();

/** Запись группы элемента (создаётся лениво). */
export function groupRecord(el: object, group: GroupKey): GroupRecord {
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
    };
    groups.set(group, rec);
  }
  return rec;
}

// ─── Чтение текущего состояния из стиля (в момент вызова, SSR-safe) ──────────

/** Duck-контракт цели: стиль с getPropertyValue/setProperty (Element подходит). */
export interface AnimatableElement {
  readonly style: {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
  };
}

/** Читает текущее значение свойства: inline → computed (если среда умеет). */
export function readStyleValue(el: AnimatableElement, cssName: string): string {
  try {
    const inline = el.style.getPropertyValue(cssName);
    if (inline !== '') return inline;
  } catch {
    /* duck-цель без полного контракта — падаем на computed/дефолт */
  }
  const gcs = (globalThis as { getComputedStyle?: (e: unknown) => { getPropertyValue(n: string): string } })
    .getComputedStyle;
  if (typeof gcs === 'function') {
    try {
      return gcs(el).getPropertyValue(cssName);
    } catch {
      /* не-Element цель в DOM-среде — компьютед недоступен */
    }
  }
  return '';
}

// ─── Форматирование записи ───────────────────────────────────────────────────

/** Один mutable state на lifecycle группы заменяет Map+object на каждом кадре. */
function createTransformState(
  residuals: ReadonlyMap<string, number>,
  channels: readonly NumericChannel[],
): Record<string, number> {
  const state: Record<string, number> = {};
  residuals.forEach((v, k) => {
    state[k] = v;
  });
  for (const channel of channels) {
    state[channel._key] = channel._value;
  }
  return state;
}

/** Интерполяция AST, уже прошедшего parse-границу фасада. */
function interpolateParsed(from: ValueAST, to: ValueAST, p: number): string | number {
  if (from.kind === 'color' && to.kind === 'color') {
    return interpolateColor(from, to, p);
  }
  if (from.kind !== 'color' && to.kind !== 'color') {
    return interpolateUnit(
      from as ParsedUnit | ParsedRelative | ParsedVar,
      to as ParsedUnit | ParsedRelative | ParsedVar,
      p,
    );
  }
  const value = Number.isNaN(p) || p < 0.5 ? from : to;
  if (value.kind === 'unit') {
    return value.unit ? `${value.value}${value.unit}` : value.value;
  }
  if (value.kind === 'relative') return `${value.op}=${value.amount}${value.unit}`;
  if (value.kind === 'var') {
    return value.fallback !== undefined
      ? `var(${value.name}, ${value.fallback})`
      : `var(${value.name})`;
  }
  return `rgb(${Math.round(value.r)}, ${Math.round(value.g)}, ${Math.round(value.b)})`;
}

/** Значение CSS-канала при прогрессе p. */
export function cssAt(ch: CssChannel, p: number): string | number {
  return interpolateParsed(ch._fromAst, ch._toAst, p);
}

/**
 * SSOT сериализации узкой numeric-поверхности. Вызов допустим только после
 * доказанной topology: transform содержит ровно `x` без residual-каналов,
 * иначе нужен общий buildTransform.
 */
export function formatSingleNumericSurface(
  transformX: boolean,
  value: number,
): string {
  return transformX
    ? value === 0 ? 'none' : `translateX(${value}px)`
    : String(value);
}

// ─── Привязка группы к элементу (from-резолв + подхват прерывания) ───────────

/** Каналы группы, привязанные к элементу, + остаточное transform-состояние. */
export interface BoundGroup {
  readonly _numeric: NumericChannel[];
  readonly _css: CssChannel | undefined;
  readonly _residuals: Map<string, number>;
  /** Единственный transform-state группы; undefined для остальных поверхностей. */
  readonly _transform: Record<string, number> | undefined;
}

/**
 * Привязывает спецификации группы к элементу: резолвит from (пара → реестр/
 * живой прогон → inline/computed стиль → дефолт) и сеет скорость подхвата.
 * Порядок канона: явная пара отключает подхват (v0=0); живой прогон отдаёт
 * (value, velocity) — C¹; после settle реестр отдаёт value (покой).
 * НЕ прерывает живой прогон — supersede делает вызывающий ПОСЛЕ привязки.
 */
export function bindGroup(
  el: AnimatableElement,
  group: GroupKey,
  specs: readonly ChannelSpec[],
  rec: GroupRecord,
): BoundGroup {
  const owner = rec._owner;
  owner?._capture?.();
  const numeric: NumericChannel[] = [];
  let css: CssChannel | undefined;

  for (const spec of specs) {
    if (spec._kind === 'num') {
      let from: number;
      let velocity = 0;
      if (spec._explicitFrom !== undefined) {
        from = spec._explicitFrom;
      } else {
        const live = owner?._captureNum(spec._key);
        const stored = rec._numeric.get(spec._key);
        if (live) {
          from = live._value;
          velocity = live._velocity;
        } else if (stored) {
          from = stored._value;
        } else if (group === 'transform') {
          from = TRANSFORM_IDENTITY[spec._key]!;
        } else {
          const read = parseFloat(readStyleValue(el, group));
          from = Number.isFinite(read) ? read : 1; // opacity: дефолт браузера
        }
      }
      numeric.push(numericChannel(spec._key, from, spec._to, velocity));
    } else {
      let fromAst: ValueAST;
      let v0 = 0;
      if (spec._explicitFrom !== undefined) {
        fromAst = spec._explicitFrom;
      } else {
        const live = owner?._captureCss(spec._key);
        // live.css не бывает nullish (string | number) — ?? безопасно каскадит.
        const source = live?._css ?? rec._cssValue ?? readStyleValue(el, group);
        fromAst = tryParse(source) ?? spec._to; // нечитаемо → дискретный старт с цели
        // Живой прогон отдаёт ṗ̂ — проекция в новое прогресс-пространство (C¹);
        // live — объект канала (truthy) либо undefined.
        if (live) v0 = projectCssV0(live, fromAst, spec._to);
      }
      const initialCss = interpolateParsed(fromAst, spec._to, 0);
      css = {
        _key: spec._key,
        _fromAst: fromAst,
        _toAst: spec._to,
        _v0: v0,
        _dpdt: v0, // производная на старте = засеянная (перехват до кадров — C¹)
        _css: initialCss,
        _renderedDpdt: v0,
        _renderedCss: initialCss,
      };
    }
  }

  // Остаточное transform-состояние: известные каналы вне нового прогона
  // замораживаются на текущем значении — transform-строка остаётся полной
  // проекцией состояния (новый прогон x не сбрасывает прежний rotate).
  const residuals = new Map<string, number>();
  if (group === 'transform') {
    // Каждый остаточный канал уже принадлежит записи либо живому владельцу.
    // До публикации нового владельца `_supersede()` фиксирует его каналы,
    // поэтому отдельное копирование при завершении не нужно: это инвариант реестра.
    const animated = new Set(specs.map((s) => s._key));
    const known = new Set<string>(rec._numeric.keys());
    if (owner) for (const k of owner._numericKeys()) known.add(k);
    for (const key of known) {
      if (animated.has(key)) continue;
      const snap = owner?._captureNum(key) ?? rec._numeric.get(key);
      if (snap) residuals.set(key, snap._value);
    }
  }

  const transform = group === 'transform'
    ? createTransformState(residuals, numeric)
    : undefined;
  return { _numeric: numeric, _css: css, _residuals: residuals, _transform: transform };
}

/** parse() без броска: нераспознанное значение → undefined. */
function tryParse(value: string | number): ValueAST | undefined {
  if (value === '') return undefined;
  return tryParseValue(value);
}
