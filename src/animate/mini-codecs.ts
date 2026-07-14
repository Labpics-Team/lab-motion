/**
 * animate/mini-codecs.ts — МИНИМАЛЬНЫЙ набор кодеков/адаптеров поставки mini.
 *
 * Выбирается фиксированным O(1)-resolver из mini/index.ts. Покрывает ровно
 * контракт mini без массивов матчеров и init-аллокаций:
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
import { finiteOrZero } from '../internal/finite.js';
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

/**
 * transform-шортхенд ли ключ. `typeof ...==='number'` (не `key in`) отсекает
 * УНАСЛЕДОВАННЫЕ constructor/toString/__proto__ (они функции/объект, не число) —
 * иначе классифицировались бы как transform-канал (prototype-pollution).
 */
export function isTransformKey(key: string): boolean {
  return typeof TRANSFORM_IDENTITY[key] === 'number';
}

// ─── Числовой кодек (transform-компоненты + opacity) ─────────────────────────

/** Полно-строчный разбор «число[юнит]»: группа 1 — число, группа 2 — юнит. */
const _UNIT_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-z%]*)$/;

/**
 * Проверяет и возвращает конечное число (fail-fast). Строка проходит СТРОГУЮ
 * полно-строчную числовую валидацию (без юнита): '1rad'/'12oops' — бросок, а не
 * тихий parseFloat-обрез до 1/12 (иначе `rotate: "1rad"` → rotate(1deg)).
 */
function _finite(v: unknown): number {
  let n: number;
  if (typeof v === 'string') {
    // Строгий гейт: полная числовая строка БЕЗ юнита; иначе NaN → бросок ниже
    // ('1rad'/'12oops' не должны тихо усечься parseFloat'ом до 1/12).
    const m = _UNIT_RE.exec(v.trim());
    n = m?.[2] === '' ? parseFloat(m[1]!) : NaN;
  } else {
    n = v as number;
  }
  // Number.isFinite сам отвергает не-числа (boolean/object/NaN/±∞) — доп. typeof не нужен.
  if (!Number.isFinite(n)) {
    throw new MotionParamError('LM142');
  }
  return n;
}

/**
 * Кодек числовых каналов: parse → число, linear-интерполяция, serialize → число.
 * range=to−from питает C¹-подхват скорости в пространстве значения.
 */
export const numberCodec: PropertyCodec<number> = {
  _parse: _finite,
  _interpolate: (from, to) => (p) => from + (to - from) * p,
  // Финитность-страж (враждебный p / переполнение): non-finite → 0 (+0 схлопывает −0).
  _serialize: finiteOrZero,
  _range: (from, to) => to - from,
};

// ─── Кодек CSS-переменной (число + юнит, passthrough) ────────────────────────

/** Разобранное значение переменной: число + суффикс-юнит ('px'|'%'|''|…). */
interface VarValue {
  readonly n: number;
  readonly unit: string;
}

/**
 * Кодек CSS-переменной: '10px'→{10,'px'}, 0.5→{0.5,''}, '50%'→{50,'%'}.
 * Интерполирует число, юнит несёт ЦЕЛЬ (to.unit — включая явно-безюнитную цель
 * '' → результат-число; несовпадение юнитов — цель побеждает, C⁰.
 * range=undefined → C⁰-подхват (velocity 0), канон css-каналов фасада.
 */
export const cssVarCodec: PropertyCodec<VarValue> = {
  _parse: (value, property) => {
    if (typeof value === 'number') {
      // Числовая финитность имеет один SSOT с transform/opacity: отдельный
      // throw здесь разошёлся бы в тексте и правилах валидации.
      return { n: _finite(value), unit: '' };
    }
    if (typeof value !== 'string') {
      throw new MotionParamError('LM143');
    }
    const m = _UNIT_RE.exec(value.trim());
    if (m === null) {
      throw new MotionParamError('LM144');
    }
    return { n: parseFloat(m[1]!), unit: m[2]! };
  },
  _interpolate: (from, to) => (p) => ({ n: from.n + (to.n - from.n) * p, unit: to.unit }),
  // Финитность-страж: non-finite n → 0 (враждебный p не течёт в CSS-значение).
  _serialize: (value) => {
    const n = finiteOrZero(value.n);
    return value.unit === '' ? n : `${n}${value.unit}`;
  },
};

// ─── DOM-адаптер элемента (surface-композиция transform) ─────────────────────

/** DOM-подобная цель: объект со style.setProperty/getPropertyValue (Element подходит). */
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

/** camelCase-имя свойства → kebab-case CSS-имя (backgroundColor → background-color). */
function _camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** Конечное число или 0 (значения уже валидны finite — страж переполнения). */
/**
 * Лёгкая компоновка transform-строки из каналов (порядок Motion/GSAP:
 * translate→scale→rotate→skew; identity-компоненты опущены; пусто → 'none').
 * Инлайн (НЕ тянем ../value/transform.js ~0.55 KB gz) — под потолок mini 5 KB;
 * формат байт-в-байт совпадает с ядровым buildTransform (запинено contract-тестом).
 */
function _buildTransform(s: Record<string, number>): string {
  const parts: string[] = [];
  const x = finiteOrZero(s.x ?? 0);
  const y = finiteOrZero(s.y ?? 0);
  if (x !== 0 && y === 0) parts.push(`translateX(${x}px)`);
  else if (x === 0 && y !== 0) parts.push(`translateY(${y}px)`);
  else if (x !== 0 || y !== 0) parts.push(`translate(${x}px, ${y}px)`);
  if (s.scale !== undefined) {
    const sv = finiteOrZero(s.scale);
    if (sv !== 1) parts.push(`scale(${sv})`);
  } else {
    const sx = finiteOrZero(s.scaleX ?? 1);
    const sy = finiteOrZero(s.scaleY ?? 1);
    if (sx === sy) {
      if (sx !== 1) parts.push(`scale(${sx})`);
    } else {
      parts.push(`scaleX(${sx})`);
      if (sy !== 1) parts.push(`scaleY(${sy})`);
    }
  }
  const rot = finiteOrZero(s.rotate ?? 0);
  if (rot !== 0) parts.push(`rotate(${rot}deg)`);
  const skewX = finiteOrZero(s.skewX ?? 0);
  const skewY = finiteOrZero(s.skewY ?? 0);
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
  _read: (target, property) => {
    if (isTransformKey(property)) return TRANSFORM_IDENTITY[property]!;
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
  _surfaceOf: (property) =>
    isTransformKey(property) ? 'transform' : property === 'opacity' ? 'opacity' : _camelToKebab(property),
  _compose: (surface, channels) => {
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
  _apply: (target, surface, value) => {
    (target as StyleTarget).style.setProperty(surface, String(value));
  },
};
