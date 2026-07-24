/**
 * Минимальный DOM-фасад для доверенной платформы: целевое значение (или явная
 * пара [from, to]) компилируется в native WAAPI, а пружина — в CSS linear().
 * Hostile/polyfill-защита, C1-подхват и произвольные N-keyframes намеренно
 * остаются контрактом полного ./animate.
 */

import { springLinear, type NanoSpring } from './spring-linear.js';

export type { NanoSpring } from './spring-linear.js';

interface NanoCommonOptions {
  /** Задержка старта в МИЛЛИСЕКУНДАХ (Framer/Motion считают в секундах — ×1000). */
  readonly delay?: number | undefined;
  /** Шаг каскада между целями в МИЛЛИСЕКУНДАХ. */
  readonly stagger?: number | undefined;
  /** Явное значение; иначе prefers-reduced-motion читается в момент вызова. */
  readonly reducedMotion?: boolean | undefined;
}

export type NanoOptions = NanoCommonOptions & ({
  /**
   * Пружина из покоя; по умолчанию mass/stiffness/damping = 1/170/26.
   * Думаете в duration/bounce? `spring: fromBounce({ duration, bounce })`
   * из `@labpics/motion/spring` — точное преобразование (#218).
   */
  readonly spring?: NanoSpring | undefined;
  readonly duration?: never;
  readonly ease?: never;
} | {
  readonly spring?: never;
  /** Tween-длительность в МИЛЛИСЕКУНДАХ (Framer/Motion: секунды — ×1000). */
  readonly duration: number;
  /** Нативная CSS easing-строка tween; JS-функции изинга — контракт `./animate`. */
  readonly ease?: string | undefined;
});

/**
 * Пара [from, to]: явный старт вместо to-only инференса WAAPI. Однородна по типу
 * (числа ИЛИ строки — как того требует WAAPI PropertyIndexedKeyframes), поэтому
 * `frame[prop] = props[prop]` пробрасывает её нативно без единого runtime-байта.
 */
export type NanoPair = [from: number, to: number] | [from: string, to: string];

export type NanoProps = Record<string, string | number | NanoPair | undefined> & {
  /** Вся CSS translate longhand: независимыми x/y владеет полный ./animate. */
  readonly translate?: string | [from: string, to: string] | undefined;
  readonly scale?: number | [from: number, to: number] | undefined;
  /**
   * Только скаляр: принудительный `deg`-суффикс (`${rotate}deg`) не переживает
   * массив — пара [from, to] для поворота остаётся контрактом полного ./animate.
   */
  readonly rotate?: number | undefined;
  /** Transform-шортхенды `x`/`y` — грамматика полного `./animate`; здесь — `translate: '240px 12px'`. */
  readonly x?: never;
  /** Transform-шортхенды `x`/`y` — грамматика полного `./animate`; здесь — `translate: '240px 12px'`. */
  readonly y?: never;
  /** `translateX/translateY` — оси полного `./animate` (`x`/`y`); nano ведёт целый `translate` longhand. */
  readonly translateX?: never;
  /** `translateX/translateY` — оси полного `./animate` (`x`/`y`); nano ведёт целый `translate` longhand. */
  readonly translateY?: never;
};

export type NanoTarget = Element | string | Iterable<Element> | ArrayLike<Element>;

export type NanoControls = Animation[] & { finished: Promise<Animation[]> };


/**
 * Анимирует одну или несколько DOM-целей на native WAAPI.
 *
 * Контракт platform-trusted требует нативные Element.animate(), commitStyles()
 * и CSS linear(); для defensive host boundary используется полный ./animate.
 */
export function animate(
  target: NanoTarget,
  props: NanoProps,
  options: NanoOptions = {},
): NanoControls {
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  const frame: PropertyIndexedKeyframes = {};
  for (const property of Object.keys(props)) {
    const value = props[property];
    frame[property] = property === 'rotate' && value != null ? `${value}deg` : value;
  }

  const [duration, easing] = options.duration != null
    ? [options.duration, options.ease ?? 'ease']
    : springLinear(options.spring);
  const reduced = options.reducedMotion
    ?? (typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animations = Array.from(source, (element, index) => element.animate(frame, {
    duration: reduced ? 0 : duration,
    easing: reduced ? 'linear' : easing,
    delay: reduced ? 0 : (options.delay ?? 0) + (options.stagger ?? 0) * index,
    fill: 'both',
  })) as NanoControls;
  animations.finished = Promise.all(animations.map((animation) => new Promise<Animation>((resolve, reject) => {
    animation.finished.catch(reject);
    // Listener, не finished.then: пин «чистит каждый replay» (n-й finish после
    // play() тоже коммитится), а пользовательский onfinish остаётся свободным.
    // Сама чистка — микротаском ПОСЛЕ рассылки события: пользовательские
    // listeners видят finished-состояние, а guard пропускает чистку, если
    // консюмер перезапустил анимацию прямо в хендлере.
    animation.addEventListener('finish', () => queueMicrotask(() => {
      // Каждый цикл перевзводит reject на ТЕКУЩИЙ finished: replay из хендлера
      // создаёт новый промис, и его cancel обязан осадить обёртку (не вечный
      // pending и не unhandled rejection). На осевшем промисе catch — no-op.
      animation.finished.catch(reject);
      if (animation.playState !== 'finished') return;
      try {
        animation.commitStyles();
        animation.cancel();
      } catch { /* fill сохраняет финал на платформе без commitStyles */ }
      resolve(animation);
    }));
  })));
  return animations;
}
