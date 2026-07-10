/**
 * animate/mini-codecs.ts — МИНИМАЛЬНЫЙ набор кодеков/адаптеров поставки mini.
 *
 * Регистрируется в mini-реестре (mini/index.ts). Покрывает ровно контракт mini:
 *   - transform-компоненты (x/y/scale/scaleX/scaleY/rotate/skewX/skewY) — число,
 *     compositor-eligible, сливаются DOM-адаптером в ОДНУ transform-строку;
 *   - opacity — число, compositor-eligible;
 *   - CSS-переменные (--foo) — число+юнит (passthrough), main-thread.
 *
 * НЕ тянет ../value/index.js (движок цветов/юнитов ~2.6 KB) — только
 * buildTransform из ../value/transform.js (компоновка transform, дёшево).
 * Расширенные виды (цвет/SVG-атрибут/plain-object) живут в full-наборе и mini
 * их НЕ импортирует (граф mini не тянет full — проверяемо import-cost тестом).
 *
 * Инварианты: SSR-safe (DOM трогается только в apply/read В МОМЕНТ вызова);
 * fail-fast (parse на не-конечном/некорректном входе → MotionParamError ДО
 * записи); финитность (serialize/compose никогда не эмитят NaN/∞ — buildTransform
 * стерилизует, числовой serialize гейтит parse).
 */

import { MotionParamError } from '../errors.js';
import type { PropertyCodec, TargetAdapter } from './registry.js';

// ─── Ключи transform-шортхендов (словарь TransformState ядра) ────────────────

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

/** transform-шортхенд ли ключ. */
export function isTransformKey(key: string): boolean {
  return key in TRANSFORM_IDENTITY;
}

/** Identity transform-канала (0, для scale-семейства 1). */
export function transformIdentity(key: string): number {
  return TRANSFORM_IDENTITY[key] ?? 0;
}

// ─── Числовой кодек (transform-компоненты + opacity) ─────────────────────────

/** Проверяет и возвращает конечное число (fail-fast). */
function _finite(property: string, v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new MotionParamError(`animate: '${property}' — не конечное число: ${String(v)}`);
  }
  return n;
}

/**
 * Кодек числовых каналов: parse → число, linear-интерполяция, serialize → число.
 * canComposite=true — transform/opacity уходят на compositor-путь, когда tier
 * это позволяет. range=to−from питает C¹-подхват скорости в пространстве значения.
 */
export const numberCodec: PropertyCodec<number> = {
  parse: (value, property) => _finite(property, value),
  interpolate: (from, to) => (p) => from + (to - from) * p,
  // Финитность-страж (враждебный p / переполнение): non-finite → 0 (+0 схлопывает −0).
  serialize: (value) => (Number.isFinite(value) ? value + 0 : 0),
  canComposite: () => true,
  range: (from, to) => to - from,
};

// ─── Кодек CSS-переменной (число + юнит, passthrough) ────────────────────────

/** Разобранное значение переменной: число + суффикс-юнит ('px'|'%'|''|…). */
interface VarValue {
  readonly n: number;
  readonly unit: string;
}

const _UNIT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-z%]*)$/;

/**
 * Кодек CSS-переменной: '10px'→{10,'px'}, 0.5→{0.5,''}, '50%'→{50,'%'}.
 * Интерполирует число, юнит несёт цель (несовпадение юнитов — цель побеждает,
 * C⁰). canComposite=false — переменные не идут на compositor-путь (linear()-
 * кейфрейм по custom-property ненадёжен кроссбраузерно; mini держит их на main).
 * range=undefined → C⁰-подхват (velocity 0), канон css-каналов фасада.
 */
export const cssVarCodec: PropertyCodec<VarValue> = {
  parse: (value, property) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new MotionParamError(`animate: '${property}' — не конечное число: ${String(value)}`);
      }
      return { n: value, unit: '' };
    }
    if (typeof value !== 'string') {
      throw new MotionParamError(`animate: '${property}' — строка/число, получено ${typeof value}`);
    }
    const m = _UNIT_RE.exec(value.trim());
    if (m === null) {
      throw new MotionParamError(`animate: '${property}' — не разобрано: '${value}'`);
    }
    return { n: parseFloat(m[1]!), unit: m[2]! };
  },
  interpolate: (from, to) => (p) => ({ n: from.n + (to.n - from.n) * p, unit: to.unit || from.unit }),
  // Финитность-страж: non-finite n → 0 (враждебный p не течёт в CSS-значение).
  serialize: (value) => {
    const n = Number.isFinite(value.n) ? value.n + 0 : 0;
    return value.unit === '' ? n : `${n}${value.unit}`;
  },
  canComposite: () => false,
};

// ─── DOM-адаптер элемента (surface-композиция transform) ─────────────────────

interface StyleTarget {
  readonly style: {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
  };
}

/** Duck-проверка DOM-подобной цели (style.setProperty/getPropertyValue). */
export function isStyleTarget(t: unknown): t is StyleTarget {
  const style = (t as { style?: unknown } | null)?.style as
    | { setProperty?: unknown; getPropertyValue?: unknown }
    | undefined;
  return (
    style != null &&
    typeof style.setProperty === 'function' &&
    typeof style.getPropertyValue === 'function'
  );
}

function _camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** Конечное число или 0 (значения уже валидны finite — страж переполнения). */
function _fin(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/**
 * Лёгкая компоновка transform-строки из каналов (порядок Motion/GSAP:
 * translate→scale→rotate→skew; identity-компоненты опущены; пусто → 'none').
 * Инлайн (НЕ тянем ../value/transform.js ~0.55 KB gz) — под потолок mini 5 KB;
 * формат байт-в-байт совпадает с ядровым buildTransform (запинено contract-тестом).
 */
function _buildTransform(s: Record<string, number>): string {
  const parts: string[] = [];
  const x = _fin(s.x ?? 0);
  const y = _fin(s.y ?? 0);
  if (x !== 0 && y === 0) parts.push(`translateX(${x}px)`);
  else if (x === 0 && y !== 0) parts.push(`translateY(${y}px)`);
  else if (x !== 0 || y !== 0) parts.push(`translate(${x}px, ${y}px)`);
  if (s.scale !== undefined) {
    const sv = _fin(s.scale);
    if (sv !== 1) parts.push(`scale(${sv})`);
  } else {
    const sx = _fin(s.scaleX ?? 1);
    const sy = _fin(s.scaleY ?? 1);
    if (sx === sy) {
      if (sx !== 1) parts.push(`scale(${sx})`);
    } else {
      parts.push(`scaleX(${sx})`);
      if (sy !== 1) parts.push(`scaleY(${sy})`);
    }
  }
  const rot = _fin(s.rotate ?? 0);
  if (rot !== 0) parts.push(`rotate(${rot}deg)`);
  const skewX = _fin(s.skewX ?? 0);
  const skewY = _fin(s.skewY ?? 0);
  if (skewX !== 0 && skewY !== 0) parts.push(`skew(${skewX}deg, ${skewY}deg)`);
  else if (skewX !== 0) parts.push(`skewX(${skewX}deg)`);
  else if (skewY !== 0) parts.push(`skewY(${skewY}deg)`);
  return parts.length === 0 ? 'none' : parts.join(' ');
}

/**
 * Адаптер DOM-элемента. Поверхность (surfaceOf): transform-компоненты → одна
 * 'transform'-строка, 'opacity' → 'opacity', переменная/прочее → kebab-имя.
 * compose('transform', …) сливает каналы через buildTransform (единственная
 * реализация компоновки — её же дергает compositor-путь для WAAPI-кейфрейма).
 * read резолвит from: transform-компонент → identity (матрицу не парсим),
 * прочее → inline/computed стиль. SSR-safe: DOM трогается лишь в read/apply.
 */
export const domAdapter: TargetAdapter = {
  read: (target, property) => {
    if (isTransformKey(property)) return transformIdentity(property);
    const el = target as StyleTarget;
    const name = property === 'opacity' ? 'opacity' : _camelToKebab(property);
    try {
      const inline = el.style.getPropertyValue(name);
      if (inline !== '') return inline;
    } catch {
      /* duck-цель без полного контракта */
    }
    const gcs = (globalThis as {
      getComputedStyle?: (e: unknown) => { getPropertyValue(n: string): string };
    }).getComputedStyle;
    if (typeof gcs === 'function') {
      try {
        return gcs(el).getPropertyValue(name);
      } catch {
        /* не-Element цель в DOM-среде */
      }
    }
    return '';
  },
  surfaceOf: (property) =>
    isTransformKey(property) ? 'transform' : property === 'opacity' ? 'opacity' : _camelToKebab(property),
  compose: (surface, channels) => {
    if (surface === 'transform') {
      const state: Record<string, number> = {};
      channels.forEach((v, k) => {
        state[k] = typeof v === 'number' ? v : parseFloat(String(v));
      });
      return _buildTransform(state);
    }
    // Одноканальная поверхность (opacity/переменная): значение канала как есть.
    for (const v of channels.values()) return v;
    return '';
  },
  apply: (target, surface, value) => {
    (target as StyleTarget).style.setProperty(surface, String(value));
  },
};
