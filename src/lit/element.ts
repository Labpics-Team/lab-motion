/**
 * lit/element.ts — S10: generic web-component (custom element) над MotionController.
 *
 * `<lab-motion-spring>` анимирует ОДНО числовое CSS-свойство своего host-элемента
 * пружиной, делегируя всю физику/reduced-motion-логику тому же MotionController,
 * что используется напрямую в идиоматичных Lit-компонентах (src/lit/controller.ts).
 * Это тонкая DOM-обёртка: единственное место записи в стиль — _applyStyle().
 *
 * Usage:
 * ```html
 * <lab-motion-spring target="100" property="opacity" template="{v}"></lab-motion-spring>
 * ```
 * ```ts
 * const el = document.createElement('lab-motion-spring') as LabMotionSpringElement;
 * el.spring = { mass: 1, stiffness: 300, damping: 30 }; // до вставки в DOM
 * el.target = 1;
 * document.body.appendChild(el);
 * ```
 *
 * SSR-safe: регистрация customElements.define() выполняется ТОЛЬКО если
 * customElements присутствует в рантайме (typeof-guard) — модуль можно
 * импортировать в Node/SSR без window/document.
 */

import { LitElement, html, css, type PropertyValues } from 'lit';
import { MotionController, type MatchMediaFn } from './controller.js';
import { type SpringParams } from '../spring.js';
import { type RequestFrameFn } from '../motion-value.js';

/** Тег custom element'а. */
export const LAB_MOTION_SPRING_TAG = 'lab-motion-spring';

/**
 * Pure template substitution — extracted from `_applyStyle()` so the
 * placeholder logic is unit-testable without a DOM (LitElement requires one;
 * this function does not). Replaces EVERY `{v}` occurrence, not just the
 * first — composite templates like `'translate({v}px, {v}px)'` repeat the
 * placeholder, and a single `.replace()` would leave the second one literal
 * in the emitted CSS value.
 */
export function renderTemplateValue(template: string, value: number): string {
  return template.includes('{v}') ? template.replaceAll('{v}', String(value)) : String(value);
}

/**
 * `<lab-motion-spring>` — фреймворк-независимая обёртка над MotionController.
 *
 * Реактивные атрибуты:
 *   - `target` (number)  — целевое значение анимации.
 *   - `property` (string) — CSS-свойство для записи (по умолчанию 'opacity').
 *   - `template` (string) — шаблон значения, `{v}` заменяется на число
 *     (по умолчанию '{v}'; пример: 'translateX({v}px)').
 *
 * JS-only свойства (не reflected-атрибуты, задаются до/после вставки в DOM):
 *   - `spring`       — параметры пружины (SpringParams).
 *   - `requestFrame` — инъектируемый rAF-seam (детерминированные тесты).
 *   - `matchMedia`   — инъектируемый prefers-reduced-motion seam.
 */
export class LabMotionSpringElement extends LitElement {
  static override readonly properties = {
    target: { type: Number },
    property: { type: String },
    template: { type: String },
  };

  declare target: number;
  declare property: string;
  declare template: string;

  /**
   * JS-only: параметры пружины. Применяются один раз при первом connectedCallback.
   * undefined ⇒ MotionController применяет свой собственный DEFAULT_SPRING —
   * единственный источник дефолта (не дублируем константу здесь, иначе два
   * значения могут разъехаться при тюнинге одного без другого).
   */
  spring: SpringParams | undefined;
  /** JS-only: инъектируемый rAF-seam. */
  requestFrame: RequestFrameFn | undefined;
  /** JS-only: инъектируемый matchMedia-seam (SSR/тесты). */
  matchMedia: MatchMediaFn | undefined;

  static override readonly styles = css`
    :host {
      display: inline-block;
    }
  `;

  private _motion: MotionController | undefined;
  private _lastAppliedTarget: number | undefined;

  constructor() {
    super();
    this.target = 0;
    this.property = 'opacity';
    this.template = '{v}';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Ленивое создание РОВНО ОДИН РАЗ: к первому connectedCallback потребитель
    // уже успел выставить spring/requestFrame/matchMedia/target через JS-свойства.
    // Последующие disconnect/reconnect обрабатываются автоматически Lit-ом
    // через hostConnected()/hostDisconnected() уже зарегистрированного контроллера.
    if (!this._motion) {
      this._motion = new MotionController(this, this.target, {
        spring: this.spring,
        requestFrame: this.requestFrame,
        matchMedia: this.matchMedia,
      });
      this._lastAppliedTarget = this.target;
    }
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has('target') && this._motion && this._lastAppliedTarget !== this.target) {
      this._motion.setTarget(this.target);
      this._lastAppliedTarget = this.target;
    }
    this._applyStyle();
  }

  /**
   * Единственное место записи в DOM-стиль хоста.
   * Делегирует значение от MotionController — сам компонент не считает физику.
   */
  private _applyStyle(): void {
    if (!this._motion) return;
    const cssValue = renderTemplateValue(this.template, this._motion.value);
    // Прямой bracket-доступ к CSSStyleDeclaration — тот же паттерн, что и в
    // vue-биндинге (_applyValue): работает с camelCase и составными именами.
    (this.style as unknown as Record<string, string>)[this.property] = cssValue;
  }

  protected override render() {
    return html`<slot></slot>`;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get(LAB_MOTION_SPRING_TAG)) {
  customElements.define(LAB_MOTION_SPRING_TAG, LabMotionSpringElement);
}
