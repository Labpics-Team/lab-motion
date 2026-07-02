/**
 * lit/controller.ts — S10: Lit ReactiveController over the headless MotionValue.
 *
 * Тонкая прослойка: подписывается на MotionValue.onChange и вызывает
 * host.requestUpdate() (hostConnected/hostDisconnected lifecycle), не трогая
 * DOM напрямую — запись остаётся за потребителем (host.render()) или за
 * LabMotionSpringElement (src/lit/element.ts), который делегирует DOM-запись
 * через свой updated().
 *
 * Работает с ЛЮБЫМ ReactiveControllerHost (не только LitElement) — контроллер
 * зависит только от структурного контракта addController/requestUpdate.
 *
 * Инварианты (package North):
 *   1. Zero runtime deps — 'lit' импортируется только как типы (ReactiveController /
 *      ReactiveControllerHost — стёрты при компиляции); lit объявлен peerDependency.
 *   2. CSS-safe — значения приходят из MotionValue, уже гарантированно конечны.
 *   3. Детерминизм — requestFrame инжектируется, как и во всех остальных биндингах.
 *   4. Reduced-motion — CHARACTER-switch (snap-to-target), НЕ hard-off.
 *   5. Domain purity — matchMedia инжектируется явным seam-параметром (как в
 *      ./driver); НЕТ обращения к window/matchMedia на верхнем уровне модуля.
 *   6. SSR-safe — импорт модуля не обращается к window/document/customElements.
 */

import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { MotionValue, MotionValueOptions, RequestFrameFn } from '../motion-value.js';
import { createBoundValue } from '../internal/binding-value.js';
import { type SpringParams } from '../spring.js';

/** Injectable matchMedia seam — тот же контракт, что и DriverOptions['matchMedia']. */
export type MatchMediaFn = (query: string) => MediaQueryList;

/** Опции для MotionController. */
export interface MotionControllerOptions {
  /** Параметры пружины. По умолчанию: { mass: 1, stiffness: 200, damping: 20 }. */
  readonly spring?: SpringParams;
  /** Инъектируемый rAF-seam (детерминированные тесты). */
  readonly requestFrame?: RequestFrameFn;
  /**
   * Инъектируемый matchMedia seam для prefers-reduced-motion.
   * undefined = попытаться взять глобальный window.matchMedia (только если он
   * СУЩЕСТВУЕТ — SSR/Node без window просто отключает reduced-motion, никогда
   * не обращается к window напрямую на верхнем уровне модуля).
   */
  readonly matchMedia?: MatchMediaFn | undefined;
}

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

/**
 * Резолвит matchMedia seam: явный инжект побеждает; иначе — глобальный
 * window.matchMedia, если он присутствует в рантайме (браузер). В SSR/Node
 * без window — undefined (reduced-motion трактуется как false).
 * Вызывается лениво (внутри конструктора), никогда на верхнем уровне модуля.
 */
function resolveMatchMedia(explicit: MatchMediaFn | undefined): MatchMediaFn | undefined {
  if (explicit) return explicit;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia.bind(window);
  }
  return undefined;
}

/** Считать prefers-reduced-motion из инжектированного (или резолвленного) seam. */
function prefersReducedMotion(matchMedia: MatchMediaFn | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Lit ReactiveController: анимирует одно число пружиной, вызывая
 * host.requestUpdate() при каждом изменении.
 *
 * Reduced-motion policy (CHARACTER-switch, northInvariant #5):
 *   При prefers-reduced-motion: reduce, setTarget() снэпает `value` к target
 *   СИНХРОННО (не hard-off — значение всегда достигает цели), без пружинных
 *   кадров.
 *
 * @example
 * ```ts
 * class MyElement extends LitElement {
 *   private motion = new MotionController(this, 0, { spring: { mass: 1, stiffness: 200, damping: 20 } });
 *   render() {
 *     return html`<div style="opacity: ${this.motion.value}"></div>`;
 *   }
 * }
 * ```
 */
export class MotionController implements ReactiveController {
  private readonly _host: ReactiveControllerHost;
  private readonly _mv: MotionValue;
  private readonly _matchMedia: MatchMediaFn | undefined;
  private _value: number;
  private _unsub: (() => void) | undefined;

  constructor(host: ReactiveControllerHost, initial: number, options: MotionControllerOptions = {}) {
    this._host = host;
    this._value = initial;
    this._matchMedia = resolveMatchMedia(options.matchMedia);

    const mvOptions: MotionValueOptions = {
      initial,
      spring: options.spring ?? DEFAULT_SPRING,
      requestFrame: options.requestFrame,
    };
    this._mv = createBoundValue(mvOptions);

    host.addController(this);
  }

  /** Текущее анимируемое значение. Всегда конечно. */
  get value(): number {
    return this._value;
  }

  /**
   * Анимировать к `target`.
   * При reduced-motion: CHARACTER-switch — синхронный снэп к target, без
   * пружинных кадров (не hard-off: значение всё равно достигает цели).
   */
  setTarget(target: number): void {
    if (prefersReducedMotion(this._matchMedia)) {
      // snapTo() halts any in-flight spring run AND resyncs the MotionValue's
      // internal from/target/velocity (not just this._value) — otherwise a
      // stale pending frame from a run that was mid-flight when reduced-motion
      // engaged would fire later and overwrite the snap via the onChange
      // subscriber in hostConnected(). snapTo() emits synchronously, which
      // that same subscriber turns into exactly one requestUpdate() call.
      this._mv.snapTo(target);
      return;
    }
    this._mv.setTarget(target);
  }

  /** Lit lifecycle: подписаться на MotionValue при подключении host. */
  hostConnected(): void {
    this._unsub = this._mv.onChange((v) => {
      this._value = v;
      this._host.requestUpdate();
    });
  }

  /**
   * Lit lifecycle: отписаться и остановить пружину при отключении host.
   *
   * `stop()`, НЕ `destroy()` — hostDisconnected не терминален в Lit (host
   * может вернуться: keyed-список, ре-рендер родителя). `destroy()` взводит
   * `_destroyed` навсегда → setTarget() после reconnect был бы no-op.
   */
  hostDisconnected(): void {
    this._unsub?.();
    this._unsub = undefined;
    this._mv.stop();
  }
}
