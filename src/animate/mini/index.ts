/**
 * animate/mini/index.ts — лёгкий срез animate (subpath ./animate/mini).
 *
 * Subpath export: import { animate } from '@labpics/motion/animate/mini'
 *
 * ПОТОЛОК: ≤ 5 KB gz. Покрывает контракт mini:
 *   transform-шортхенды (x/y/scale/scaleX/scaleY/rotate/skewX/skewY), opacity,
 *   CSS-переменные, spring/tween, delay/stagger, контролы, reduced-motion снап.
 *
 * mini исполняет transform/opacity на MAIN-потоке аналитической замкнутой формой
 * (БЕЗ WAAPI/compositor-offload — тот не помещается под 5 KB, живёт в ./animate).
 *
 * mini регистрирует МИНИМАЛЬНЫЙ набор кодеков/адаптеров (mini-codecs.ts) и НЕ
 * импортирует full-набор (цвет/SVG-атрибут/plain-object) — граф mini не тянет
 * full (проверяемо import-cost тестом). Полная поверхность (keyframes,
 * per-property transitions, repeats, function values, sequences, доп. адаптеры)
 * — субпуть ./animate.
 *
 * Инварианты наследуют движок (engine.ts): один владелец target/поверхности,
 * C¹-подхват value+velocity при повторном запуске, разделение read/write фаз
 * единым ./frame, SSR-safe импорт, fail-fast MotionParamError ДО записи стиля.
 */

import { createRegistry, type CodecRegistry } from '../registry.js';
import { cssVarCodec, domAdapter, isStyleTarget, isTransformKey, numberCodec } from '../mini-codecs.js';
import {
  runAnimate,
  type AnimateControls,
  type EngineOptions,
  type PropValue,
} from './engine.js';

export type { AnimateControls, EngineOptions as AnimateOptions, PropValue };

/** Цель: DOM-элемент, список или CSS-селектор (резолв в момент вызова). */
export type AnimateTarget = object | string | ArrayLike<object>;

/** Каналы движения: transform-шортхенды, opacity, CSS-переменные. */
export type AnimateProps = Record<string, PropValue>;

/**
 * Собирает mini-реестр: числовой кодек (transform-компоненты + opacity),
 * кодек CSS-переменной, DOM-адаптер элемента. Модульный синглтон — один реестр
 * на весь субпуть (расширение — регистрацией, но mini замкнут на минимум).
 */
function _buildMiniRegistry(): CodecRegistry {
  const r = createRegistry();
  // CSS-переменные (--*): число+юнит, main-thread.
  r.registerCodec((p) => p.startsWith('--'), cssVarCodec);
  // Числовые каналы: transform-шортхенды + opacity (compositor-eligible).
  r.registerCodec((p) => isTransformKey(p) || p === 'opacity', numberCodec);
  r.registerAdapter(isStyleTarget, domAdapter);
  return r;
}

const _miniRegistry = _buildMiniRegistry();

/**
 * Анимирует DOM-цель(и) к props одной строкой (лёгкий срез).
 *
 * @param target  Element | список | CSS-селектор (резолв в момент вызова).
 * @param props   transform-шортхенды (x/y/scale/rotate/…), opacity, CSS-переменные;
 *                значение — цель или пара [from, to].
 * @param options { spring } ИЛИ { duration, ease }; delay; stagger (мс-шаг); onComplete.
 * @returns Контролы { finished, play, pause, seek, cancel, stop }.
 * @throws {MotionParamError} рано, ДО записей в стиль: не-конечные числа,
 *         'transform' целиком, конфликт режимов, неподдержанное свойство/цель.
 */
export function animate(
  target: AnimateTarget,
  props: AnimateProps,
  options: EngineOptions = {},
): AnimateControls {
  return runAnimate(_miniRegistry, target, props, options);
}
