/**
 * animate/full-codecs.ts — РАСШИРЕННЫЙ набор кодеков/адаптеров (поставка full).
 *
 * Демонстрирует ЗАКОН расширения (registry.ts): новые виды свойств/целей входят
 * РЕГИСТРАЦИЕЙ в реестр, а движок (mini/engine.ts) не меняется ни строкой — он
 * дергает те же codec.parse/interpolate/serialize и adapter.read/surfaceOf/
 * compose/apply. Поверх МИНИМАЛЬНОГО набора mini добавляет:
 *   - colorCodec        — цвет (hex/rgb/hsl) через движок ./value (reused);
 *   - svgAttrAdapter    — SVG-атрибуты (cx/cy/r/…) через get/setAttribute;
 *   - plainObjectAdapter — plain JS-объект как цель, БЕЗ единого касания DOM.
 *
 * mini НЕ импортирует этот модуль (граф mini не тянет full — import-cost гейт).
 * Модуль внутренний (не экспорт-субпуть): его назначение — доказать адаптерную
 * архитектуру и дать contract-тестам движок с расширенным реестром.
 *
 * Инварианты наследуют кодек/адаптер-контракт: SSR-safe (DOM/атрибуты трогаются
 * лишь в read/apply); fail-fast (parse на некорректном входе → MotionParamError);
 * plain-object путь — НУЛЕВОЙ DOM (read/apply — только обращения к полям объекта).
 */

import { MotionParamError } from '../errors.js';
import { interpolateColor, parseColor, type ParsedColor } from '../value/color.js';
import { cssVarCodec, domAdapter, isStyleTarget, isTransformKey, numberCodec } from './mini-codecs.js';
import { createRegistry, type CodecRegistry, type PropertyCodec, type TargetAdapter } from './registry.js';

// ─── Кодек цвета (reuse движка ./value) ──────────────────────────────────────

/** CSS-свойства, которые кодек цвета обслуживает в full-реестре. */
const _COLOR_PROPS = new Set(['color', 'background-color', 'backgroundColor', 'fill', 'stroke', 'border-color']);

/** Является ли свойство цветовым каналом (для регистрации предикатом). */
export function isColorProperty(property: string): boolean {
  return _COLOR_PROPS.has(property);
}

/**
 * Кодек цвета: parse → ParsedColor (движок ./value), interpolate — в RGB/HSL
 * (hue-wrap) через interpolateColor, serialize → css-строка. C⁰-подхват (range
 * undefined): цвет перехватывается по значению, скорость не проецируется.
 * TParsed внутри разнороден (parse→ParsedColor, interp(p)→string) — движок
 * трактует его непрозрачно (serialize замыкает контур).
 */
export const colorCodec: PropertyCodec = {
  parse: (value, property) => {
    if (typeof value !== 'string') {
      throw new MotionParamError(`animate: '${property}' — цвет строкой, получено ${typeof value}`);
    }
    const c = parseColor(value);
    if (c === null) {
      throw new MotionParamError(`animate: '${property}' — не цвет: '${value}'`);
    }
    return c;
  },
  interpolate: (from, to) => (p) => interpolateColor(from as ParsedColor, to as ParsedColor, p),
  serialize: (value) => String(value),
  canComposite: () => false,
};

// ─── SVG-адаптер (атрибуты через get/setAttribute) ───────────────────────────

interface SvgTarget {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  readonly ownerSVGElement?: unknown;
  readonly namespaceURI?: string | null;
}

/** Duck-проверка SVG-цели: get/setAttribute + SVG-namespace/ownerSVGElement. */
export function isSvgTarget(t: unknown): t is SvgTarget {
  const el = t as SvgTarget | null;
  if (el == null || typeof el.setAttribute !== 'function' || typeof el.getAttribute !== 'function') {
    return false;
  }
  return el.ownerSVGElement != null || (el.namespaceURI ?? '').includes('svg');
}

/**
 * Адаптер SVG-элемента: числовые атрибуты (cx/cy/r/width/x1/…) читаются/пишутся
 * через get/setAttribute (НЕ через style — presentation-атрибуты живут в
 * атрибутном пространстве). Каждый атрибут — своя поверхность (без композиции).
 * SSR-safe: атрибуты трогаются только в read/apply.
 */
export const svgAttrAdapter: TargetAdapter = {
  read: (target, property) => (target as SvgTarget).getAttribute(property) ?? '',
  surfaceOf: (property) => property,
  compose: (_surface, channels) => {
    for (const v of channels.values()) return v;
    return '';
  },
  apply: (target, surface, value) => {
    (target as SvgTarget).setAttribute(surface, String(value));
  },
};

// ─── plain-object адаптер (ноль-DOM) ─────────────────────────────────────────

/** plain JS-объект (не DOM/SVG-цель): анимируемое хранилище полей. */
export function isPlainObjectTarget(t: unknown): boolean {
  return t !== null && typeof t === 'object' && !isStyleTarget(t) && !isSvgTarget(t) && !Array.isArray(t);
}

/**
 * Адаптер plain-объекта: read = target[property], apply = target[property]=value.
 * НИ ОДНОГО касания DOM (ни style, ни document, ни getComputedStyle) — цель
 * анимации может быть чистым JS-состоянием (камера, аудио-гейн, число прогресса).
 * Каждое поле — своя поверхность (без композиции transform).
 */
export const plainObjectAdapter: TargetAdapter = {
  read: (target, property) => (target as Record<string, unknown>)[property],
  surfaceOf: (property) => property,
  compose: (_surface, channels) => {
    for (const v of channels.values()) return v;
    return '';
  },
  apply: (target, surface, value) => {
    (target as Record<string, unknown>)[surface] = value;
  },
};

// ─── Сборка full-реестра ─────────────────────────────────────────────────────

/**
 * full-реестр: минимальный набор mini (числовой/var кодеки + DOM-адаптер) плюс
 * расширения (цвет, SVG-атрибут, plain-object). Порядок регистрации задаёт
 * приоритет (позже — выше, resolve идёт last-first): plain-object и SVG-адаптеры
 * с более узкими предикатами перекрывают DOM-адаптер для своих целей.
 */
export function createFullRegistry(): CodecRegistry {
  const r = createRegistry();
  // Кодеки.
  r.registerCodec((p) => p.startsWith('--'), cssVarCodec);
  r.registerCodec((p) => isTransformKey(p) || p === 'opacity', numberCodec);
  r.registerCodec(isColorProperty, colorCodec);
  // Числовые SVG-атрибуты — та же числовая математика (reuse numberCodec).
  r.registerCodec(
    (p) => /^(cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|stroke-width|stroke-dashoffset)$/.test(p),
    numberCodec,
  );
  // Адаптеры (last-first: узкие предикаты первыми).
  r.registerAdapter(isStyleTarget, domAdapter);
  r.registerAdapter(isSvgTarget, svgAttrAdapter);
  r.registerAdapter(isPlainObjectTarget, plainObjectAdapter);
  return r;
}
