/**
 * wc/index.ts — generic web-component биндинг (subpath ./wc, S19).
 *
 * `<lab-spring>` — vanilla-зеркало `<lab-motion-spring>` из ./lit БЕЗ lit:
 * ноль зависимостей вообще (только платформенные custom elements). Покрывает
 * потребителей без фреймворка: vanilla, Astro (client-side скрипты — у Astro
 * нет собственной реактивности), Stencil-соседство, HTML-first стеки.
 *
 * Контракт атрибутов зеркалит lit-версию:
 *   - `target` (number) — целевое значение; невалидное значение атрибута
 *     ИГНОРИРУЕТСЯ (HTML-конвенция: атрибуты — враждебные строки, бросок из
 *     attributeChangedCallback уронил бы чужой рантайм).
 *   - `property` (string) — CSS-свойство хоста (по умолчанию 'opacity').
 *   - `template` (string) — шаблон значения, `{v}` → число.
 * JS-only свойства до вставки в DOM: spring / requestFrame / matchMedia.
 *
 * SSR-safe: класс создаётся ФАБРИКОЙ от базового конструктора — на импорте
 * нет обращения к HTMLElement/customElements (в Node их не существует);
 * авто-регистрация выполняется только под typeof-гардом. Фабрика же делает
 * биндинг тестируемым без DOM: базовый конструктор и реестр инжектируются.
 *
 * Reduced-motion — смена ХАРАКТЕРА: при prefers-reduced-motion смена target
 * снапает стиль синхронно, без кадров пружины.
 *
 * MotionValue живёт с элементом через disconnect/reconnect (зеркало
 * lit-reconnect-семантики) и разрушается вместе с ним сборщиком мусора.
 */

import type { MotionValue, MotionValueOptions, RequestFrameFn } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
import { renderTemplateValue } from '../internal/template.js';
import { type SpringParams } from '../spring.js';

export { renderTemplateValue } from '../internal/template.js';

/** Тег custom element'а. */
export const LAB_SPRING_TAG = 'lab-spring';

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

/** Структурный минимум прото-хоста (реальный HTMLElement соответствует). */
export interface SpringHostBase {
  style: Record<string, string>;
  getAttribute(name: string): string | null;
}

interface MatchMediaResult {
  readonly matches: boolean;
}
export type MatchMediaFn = (query: string) => MatchMediaResult;

/** Инстанс `<lab-spring>` (для типизации потребителя). */
export interface LabSpringHost extends SpringHostBase {
  target: number;
  property: string;
  template: string;
  spring: SpringParams | undefined;
  requestFrame: RequestFrameFn | undefined;
  matchMedia: MatchMediaFn | undefined;
  connectedCallback(): void;
  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void;
}

function prefersReduced(matchMedia: MatchMediaFn | undefined): boolean {
  const mm =
    matchMedia ??
    (typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia.bind(globalThis)
      : undefined);
  if (mm === undefined) return false;
  try {
    return mm('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Фабрика класса элемента от инжектируемого базового конструктора.
 * В браузере база = HTMLElement (авто-регистрация ниже); в тестах — фейк.
 */
export function createLabSpringElementClass(
  Base: new () => SpringHostBase,
): new () => LabSpringHost {
  class LabSpringElement extends Base implements LabSpringHost {
    static readonly observedAttributes = ['target', 'property', 'template'];

    target = 0;
    property = 'opacity';
    template = '{v}';

    /** JS-only, применяются при первом connectedCallback (как в ./lit). */
    spring: SpringParams | undefined;
    requestFrame: MotionValueOptions['requestFrame'];
    matchMedia: MatchMediaFn | undefined;

    private _mv: MotionValue | undefined;

    connectedCallback(): void {
      // Ленивое создание ровно один раз: MotionValue переживает
      // disconnect/reconnect (зеркало lit-семантики).
      if (this._mv === undefined) {
        this._mv = createBoundValue({
          initial: this.target,
          spring: this.spring ?? DEFAULT_SPRING,
          requestFrame: this.requestFrame,
        });
        this._mv.onChange((v) => {
          this._applyStyle(v);
        });
      }
      // Первый connect — initial (===target); reconnect mid-flight — ТЕКУЩЕЕ
      // значение живого MotionValue: снап в target дал бы визуальный прыжок
      // с обратной коррекцией на следующем кадре.
      this._applyStyle(this._mv.value);
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
      if (value === null) return;
      if (name === 'property') {
        const previousProperty = this.property;
        this.property = value;
        if (this._mv !== undefined) this._applyStyle(this._mv.value, previousProperty);
        return;
      }
      if (name === 'template') {
        this.template = value;
        if (this._mv !== undefined) this._applyStyle(this._mv.value);
        return;
      }
      // target: атрибут — враждебная строка; невалидное игнорируется.
      if (value.trim() === '') return;
      const target = Number(value);
      if (!Number.isFinite(target)) return;
      this.target = target;
      if (this._mv === undefined) return; // применится в connectedCallback
      if (prefersReduced(this.matchMedia)) {
        // onChange пишет стиль, а доменный снап гасит прежний полёт
        // и инвалидирует уже поставленный кадр.
        this._mv.snapTo(target);
      } else {
        this._mv.setTarget(target);
      }
    }

    /** Единственное место записи в стиль хоста (зеркало lit-версии). */
    private _applyStyle(value: number, previousProperty?: string): void {
      this.style[this.property] = renderTemplateValue(this.template, value);
      // Новая проекция уже записана; только после этого освобождаем прежний
      // inline-канал, чтобы один биндинг не владел двумя CSS-свойствами.
      if (previousProperty !== undefined && previousProperty !== this.property) {
        this.style[previousProperty] = '';
      }
    }
  }
  return LabSpringElement;
}

/** Реестр custom elements в объёме, нужном для регистрации. */
export interface ElementRegistry {
  get(name: string): unknown;
  define(name: string, ctor: new () => SpringHostBase): void;
}

/**
 * Регистрация элемента. Без аргументов — платформенные HTMLElement и
 * customElements (SSR: тихий no-op, среды нет). Возвращает класс или
 * undefined, если регистрация невозможна/уже сделана.
 */
export function defineLabSpring(
  registry?: ElementRegistry,
  Base?: new () => SpringHostBase,
): (new () => LabSpringHost) | undefined {
  const reg =
    registry ??
    (typeof customElements !== 'undefined'
      ? (customElements as unknown as ElementRegistry)
      : undefined);
  const BaseCtor =
    Base ??
    (typeof HTMLElement !== 'undefined'
      ? (HTMLElement as unknown as new () => SpringHostBase)
      : undefined);
  if (reg === undefined || BaseCtor === undefined) return undefined;
  if (reg.get(LAB_SPRING_TAG) !== undefined) return undefined;
  const ctor = createLabSpringElementClass(BaseCtor);
  reg.define(LAB_SPRING_TAG, ctor);
  return ctor;
}

// Авто-регистрация в браузере; в Node — тихий no-op (SSR-safe).
defineLabSpring();
