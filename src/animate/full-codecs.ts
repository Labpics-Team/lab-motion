/**
 * animate/full-codecs.ts — РАСШИРЕННЫЙ набор кодеков/адаптеров (поставка full).
 *
 * Демонстрирует ЗАКОН расширения (registry.ts): новые виды свойств/целей входят
 * РЕГИСТРАЦИЕЙ в реестр, а движок (mini/engine.ts) не меняется ни строкой — он
 * дергает те же codec._parse/_interpolate/_serialize и adapter._read/_surfaceOf/
 * _compose/_apply. Поверх МИНИМАЛЬНОГО набора mini добавляет:
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
  _parse: (value, property) => {
    if (typeof value !== 'string') {
      throw new MotionParamError('LM143');
    }
    const c = parseColor(value);
    if (c === null) {
      throw new MotionParamError('LM144');
    }
    return c;
  },
  _interpolate: (from, to) => (p) => interpolateColor(from as ParsedColor, to as ParsedColor, p),
  _serialize: (value) => String(value),
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

/** Белый список анимируемых SVG-презентационных атрибутов (surfaceOf-гейт). */
const _SVG_ATTRS = new Set([
  'opacity', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-dashoffset', 'stroke-dasharray', 'r', 'rx', 'ry', 'cx', 'cy', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'width', 'height', 'd', 'points', 'transform', 'viewBox',
  'offset-distance',
]);

/**
 * Адаптер SVG-элемента: числовые атрибуты (cx/cy/r/width/x1/…) читаются/пишутся
 * через get/setAttribute (НЕ через style — presentation-атрибуты живут в
 * атрибутном пространстве). Каждый атрибут — своя поверхность (без композиции).
 * surfaceOf ГЕЙТИТ имя по белому списку: transform-шортхенды (scale/x-как-сдвиг
 * резолвятся target-независимо) и CSS-vars (--*) отклоняются fail-fast — иначе
 * writeAttribute('scale',…)/('--foo',…) был бы тихий no-op. SSR-safe: атрибуты
 * трогаются только в read/apply.
 */
export const svgAttrAdapter: TargetAdapter = {
  _read: (target, property) => (target as SvgTarget).getAttribute(property) ?? '',
  _surfaceOf: (property) => {
    if (!_SVG_ATTRS.has(property)) {
      throw new MotionParamError('LM145');
    }
    return property;
  },
  _compose: (_surface, channels) => {
    for (const v of channels.values()) return v;
    return '';
  },
  _apply: (target, surface, value) => {
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
  _read: (target, property) => (target as Record<string, unknown>)[property],
  _surfaceOf: (property) => property,
  _compose: (_surface, channels) => {
    for (const v of channels.values()) return v;
    return '';
  },
  _apply: (target, surface, value) => {
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
  r._registerCodec((p) => p.startsWith('--'), cssVarCodec);
  r._registerCodec((p) => isTransformKey(p) || p === 'opacity', numberCodec);
  r._registerCodec(isColorProperty, colorCodec);
  // Числовые SVG-атрибуты — та же числовая математика (reuse numberCodec).
  r._registerCodec(
    (p) => /^(cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|stroke-width|stroke-dashoffset)$/.test(p),
    numberCodec,
  );
  // Адаптеры (last-first: узкие предикаты первыми).
  r._registerAdapter(isStyleTarget, domAdapter);
  r._registerAdapter(isSvgTarget, svgAttrAdapter);
  r._registerAdapter(isPlainObjectTarget, plainObjectAdapter);
  return r;
}
