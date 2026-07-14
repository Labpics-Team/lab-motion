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
 * mini регистрирует минимальный внутренний набор кодеков/адаптеров и не тянет
 * ./value или compositor-компилятор. Публичного registry API у субпути нет.
 * Цветовые CSS-значения и WAAPI-путь предоставляет ./animate; ключевые кадры и
 * оркестрация живут в отдельных ./keyframes и ./timeline.
 *
 * Инварианты наследуют движок (engine.ts): один владелец target/поверхности,
 * C¹-подхват value+velocity при повторном запуске, разделение read/write фаз
 * единым ./frame, SSR-safe импорт, fail-fast MotionParamError ДО записи стиля.
 */

import { MotionParamError } from '../../errors.js';
import type { CodecResolver } from '../registry.js';
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
 * Mini-поставка замкнута на двух кодеках и одном DOM-адаптере, поэтому
 * компилированный resolver выбирает их за O(1) без массивов матчеров и init-аллокаций.
 * Движок зависит от узкого внутреннего CodecResolver; публичный mini-контракт
 * не выдаёт реестр и не допускает скрытого роста графа зависимостей.
 */
const _miniRegistry: CodecResolver = {
  _resolveCodec(property) {
    if (property === 'opacity' || isTransformKey(property)) return numberCodec;
    if (property.startsWith('--')) return cssVarCodec;
    throw new MotionParamError('LM145');
  },
  _resolveAdapter(target) {
    if (isStyleTarget(target)) return domAdapter;
    throw new MotionParamError('LM148');
  },
};

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
