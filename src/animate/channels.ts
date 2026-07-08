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
import {
  buildTransform,
  interpolate,
  parse,
  type TransformState,
  type ValueAST,
} from '../value/index.js';

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

/** Является ли ключ props transform-шортхендом. */
export function isTransformKey(key: string): boolean {
  return key in TRANSFORM_IDENTITY;
}

/** Identity-значение transform-канала (0, для scale-семейства 1). */
export function transformIdentity(key: string): number {
  return TRANSFORM_IDENTITY[key] ?? 0;
}

// ─── Спецификации каналов (до привязки к элементу) ───────────────────────────

/** Группа записи: одна CSS-декларация на кадр. */
export type GroupKey = string; // 'transform' | 'opacity' | kebab-case CSS-имя

/** Числовой канал (transform-шортхенд или opacity): физика в пространстве значения. */
export interface NumericChannelSpec {
  readonly kind: 'num';
  readonly key: string;
  readonly group: GroupKey;
  /** Явный from из пары [from, to]; undefined — резолв из реестра/стиля. */
  readonly explicitFrom: number | undefined;
  readonly to: number;
}

/** CSS-канал (цвет/юниты через ./value): физика в прогресс-пространстве [0..1]. */
export interface CssChannelSpec {
  readonly kind: 'css';
  readonly key: string;
  readonly group: GroupKey;
  readonly explicitFrom: ValueAST | undefined;
  readonly to: ValueAST;
}

export type ChannelSpec = NumericChannelSpec | CssChannelSpec;

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function requireFinite(key: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MotionParamError(
      `animate: значение '${key}' должно быть конечным числом, получено ${String(v)}`,
    );
  }
  return v;
}

function parseCssValue(key: string, v: unknown): ValueAST {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new MotionParamError(
      `animate: значение '${key}' должно быть конечным числом, получено ${String(v)}`,
    );
  }
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new MotionParamError(
      `animate: значение '${key}' должно быть строкой или числом, получено ${typeof v}`,
    );
  }
  try {
    return parse(v);
  } catch (e) {
    throw new MotionParamError(`animate: '${key}': ${(e as Error).message}`);
  }
}

/**
 * Разбирает props в спецификации каналов. Бросает MotionParamError рано —
 * ДО каких-либо записей в стиль (не-конечные числа, целиком 'transform',
 * нераспознанные CSS-значения). Пара [from, to] задаёт явный from.
 */
export function parseProps(props: Record<string, unknown>): ChannelSpec[] {
  const specs: ChannelSpec[] = [];
  for (const key of Object.keys(props)) {
    const raw = props[key];
    if (key === 'transform') {
      throw new MotionParamError(
        `animate: свойство 'transform' целиком не поддерживается — используйте шортхенды (x, y, scale, rotate, …), они сливаются в одну transform-строку`,
      );
    }
    const pair = Array.isArray(raw) ? raw : undefined;
    if (pair !== undefined && pair.length !== 2) {
      throw new MotionParamError(
        `animate: пара '${key}' должна быть [from, to], получено ${pair.length} элемент(ов)`,
      );
    }
    if (isTransformKey(key) || key === 'opacity') {
      const group: GroupKey = key === 'opacity' ? 'opacity' : 'transform';
      specs.push({
        kind: 'num',
        key,
        group,
        explicitFrom: pair !== undefined ? requireFinite(key, pair[0]) : undefined,
        to: requireFinite(key, pair !== undefined ? pair[1] : raw),
      });
    } else {
      specs.push({
        kind: 'css',
        key,
        group: camelToKebab(key),
        explicitFrom: pair !== undefined ? parseCssValue(key, pair[0]) : undefined,
        to: parseCssValue(key, pair !== undefined ? pair[1] : raw),
      });
    }
  }
  return specs;
}

// ─── Привязанные каналы (живое состояние прогона) ────────────────────────────

/** Числовой канал в полёте: from/to/v0 + последнее эмитнутое состояние. */
export interface NumericChannel {
  readonly kind: 'num';
  readonly key: string;
  readonly from: number;
  readonly to: number;
  /** Нормализованная стартовая скорость (канон солвера: v0 / range). */
  readonly v0: number;
  value: number;
  velocity: number;
}

/** CSS-канал в полёте: прогресс-пространство + последняя эмитнутая строка. */
export interface CssChannel {
  readonly kind: 'css';
  readonly key: string;
  readonly fromAst: ValueAST;
  readonly toAst: ValueAST;
  /** Стартовая скорость прогресса (подхват C⁰: всегда 0 — см. карту решений). */
  readonly v0: number;
  p: number;
  css: string | number;
}

/** Порог вырожденного диапазона (зеркалит RANGE_EPSILON compositor-пути). */
export const RANGE_EPSILON = 1e-10;

/** Нормализация скорости подхвата: v0 = velocity / range (канон MotionValue). */
export function normalizeV0(velocity: number, range: number): number {
  if (!(Math.abs(range) > RANGE_EPSILON)) return 0;
  const v0 = velocity / range;
  return Number.isFinite(v0) ? v0 : 0;
}

// ─── Реестр состояния по элементам ───────────────────────────────────────────

/** Снимок числового канала (значение + скорость units/s). */
export interface ChannelSnapshot {
  readonly value: number;
  readonly velocity: number;
}

/**
 * Живой владелец группы — юнит, чей прогон можно прервать с подхватом
 * (capture → supersede). Оба движка (rAF и WAAPI) реализуют этот контракт.
 */
export interface GroupOwner {
  /** Аналитический снимок числового канала в момент прерывания. */
  captureNum(key: string): ChannelSnapshot | undefined;
  /** Последняя эмитнутая строка CSS-канала (C⁰-подхват). */
  captureCss(key: string): string | number | undefined;
  /** Ключи числовых каналов прогона (для остаточного transform-состояния). */
  numericKeys(): readonly string[];
  /** Прервать прогон: стоп без записи, finished резолвится (не natural). */
  supersede(): void;
}

/** Запись группы: живой владелец + последнее известное состояние каналов. */
export interface GroupRecord {
  owner: GroupOwner | undefined;
  /** Последние известные числовые значения по субканалам (после settle/cancel). */
  readonly numeric: Map<string, ChannelSnapshot>;
  /** Последнее известное значение CSS-канала. */
  cssValue: string | number | undefined;
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
  if (groups === undefined) {
    groups = new Map();
    registry.set(el, groups);
  }
  let rec = groups.get(group);
  if (rec === undefined) {
    rec = { owner: undefined, numeric: new Map(), cssValue: undefined };
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

/**
 * Собирает transform-строку из остаточного состояния (замороженные каналы
 * прежних прогонов) и живых значений — полная проекция известного состояния,
 * чтобы новый прогон одного канала не сбрасывал остальные в identity.
 */
export function formatTransform(
  residuals: ReadonlyMap<string, number>,
  live?: ReadonlyMap<string, number>,
): string {
  const state: Record<string, number> = {};
  residuals.forEach((v, k) => {
    state[k] = v;
  });
  if (live !== undefined) {
    live.forEach((v, k) => {
      state[k] = v;
    });
  }
  return buildTransform(state as TransformState);
}

/** Значение CSS-канала при прогрессе p (финитные стражи — в ./value). */
export function cssAt(ch: CssChannel, p: number): string | number {
  return interpolate(ch.fromAst, ch.toAst, p);
}

// ─── Привязка группы к элементу (from-резолв + подхват прерывания) ───────────

/** Каналы группы, привязанные к элементу, + остаточное transform-состояние. */
export interface BoundGroup {
  readonly numeric: NumericChannel[];
  readonly css: CssChannel | undefined;
  readonly residuals: Map<string, number>;
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
  const owner = rec.owner;
  const numeric: NumericChannel[] = [];
  let css: CssChannel | undefined;

  for (const spec of specs) {
    if (spec.kind === 'num') {
      let from: number;
      let velocity = 0;
      if (spec.explicitFrom !== undefined) {
        from = spec.explicitFrom;
      } else {
        const live = owner?.captureNum(spec.key);
        const stored = rec.numeric.get(spec.key);
        if (live !== undefined) {
          from = live.value;
          velocity = live.velocity;
        } else if (stored !== undefined) {
          from = stored.value;
        } else if (group === 'transform') {
          from = transformIdentity(spec.key);
        } else {
          const read = parseFloat(readStyleValue(el, group));
          from = Number.isFinite(read) ? read : 1; // opacity: дефолт браузера
        }
      }
      numeric.push({
        kind: 'num',
        key: spec.key,
        from,
        to: spec.to,
        v0: normalizeV0(velocity, spec.to - from),
        value: from,
        velocity,
      });
    } else {
      let fromAst: ValueAST;
      if (spec.explicitFrom !== undefined) {
        fromAst = spec.explicitFrom;
      } else {
        const source = owner?.captureCss(spec.key) ?? rec.cssValue ?? readStyleValue(el, group);
        fromAst = tryParse(source) ?? spec.to; // нечитаемо → дискретный старт с цели
      }
      css = {
        kind: 'css',
        key: spec.key,
        fromAst,
        toAst: spec.to,
        v0: 0, // C⁰-подхват css-каналов: скорость между пространствами не проецируется
        p: 0,
        css: interpolate(fromAst, spec.to, 0),
      };
    }
  }

  // Остаточное transform-состояние: известные каналы вне нового прогона
  // замораживаются на текущем значении — transform-строка остаётся полной
  // проекцией состояния (новый прогон x не сбрасывает прежний rotate).
  const residuals = new Map<string, number>();
  if (group === 'transform') {
    const animated = new Set(specs.map((s) => s.key));
    const known = new Set<string>(rec.numeric.keys());
    if (owner !== undefined) for (const k of owner.numericKeys()) known.add(k);
    for (const key of known) {
      if (animated.has(key)) continue;
      const snap = owner?.captureNum(key) ?? rec.numeric.get(key);
      if (snap !== undefined) residuals.set(key, snap.value);
    }
  }

  return { numeric, css, residuals };
}

/** parse() без броска: нераспознанное значение → undefined. */
function tryParse(value: string | number): ValueAST | undefined {
  if (value === '') return undefined;
  try {
    return parse(value);
  } catch {
    return undefined;
  }
}
