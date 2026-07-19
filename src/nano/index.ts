/**
 * Минимальный DOM-фасад для доверенной платформы: to-only значения компилируются
 * в native WAAPI, а пружина — в CSS linear(). Hostile/polyfill-защита, C1-подхват
 * и произвольные keyframes намеренно остаются контрактом полного ./animate.
 */

import { springLinear, type NanoSpring } from './spring-linear.js';

export type { NanoSpring } from './spring-linear.js';

interface NanoCommonOptions {
  readonly delay?: number | undefined;
  readonly stagger?: number | undefined;
  /** Явное значение; иначе prefers-reduced-motion читается в момент вызова. */
  readonly reducedMotion?: boolean | undefined;
}

export type NanoOptions = NanoCommonOptions & ({
  /** Пружина из покоя; по умолчанию mass/stiffness/damping = 1/170/26. */
  readonly spring?: NanoSpring | undefined;
  readonly duration?: never;
  readonly ease?: never;
} | {
  readonly spring?: never;
  /** Tween-длительность в миллисекундах. */
  readonly duration: number;
  /** Нативная CSS easing-строка tween. */
  readonly ease?: string | undefined;
});

export type NanoProps = Record<string, string | number | undefined> & {
  /** Вся CSS translate longhand: независимыми x/y владеет полный ./animate. */
  readonly translate?: string | undefined;
  readonly scale?: number | undefined;
  readonly rotate?: number | undefined;
};

export type NanoTarget = Element | string | Iterable<Element> | ArrayLike<Element>;

export type NanoControls = Animation[] & { finished: Promise<Animation[]> };

const TRANSFORM = { scale: 1, rotate: 1 };

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
  if (props.scale != null) frame.scale = props.scale;
  if (props.rotate != null) frame.rotate = `${props.rotate}deg`;
  for (const property of Object.keys(props)) {
    if (!(property in TRANSFORM)) frame[property] = props[property];
  }

  const [duration, easing] = options.duration != null
    ? [options.duration, options.ease ?? 'ease']
    : springLinear(options.spring);
  const reduced = options.reducedMotion
    ?? (typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animations = Array.from(source, (element, index) => {
    const animation = element.animate(frame, {
      duration: reduced ? 0 : duration,
      easing: reduced ? 'linear' : easing,
      delay: reduced ? 0 : (options.delay ?? 0) + (options.stagger ?? 0) * index,
      fill: 'both',
    });
    return animation;
  }) as NanoControls;
  animations.finished = Promise.all(animations.map((animation) => new Promise<Animation>((resolve, reject) => {
    animation.finished.catch(reject);
    animation.addEventListener('finish', () => {
      try {
        animation.commitStyles();
        animation.cancel();
      } catch { /* fill сохраняет финал на платформе без commitStyles */ }
      resolve(animation);
    });
  })));
  return animations;
}
