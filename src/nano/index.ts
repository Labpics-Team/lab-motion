/**
 * Минимальный DOM-фасад для доверенной платформы: to-only значения компилируются
 * в native WAAPI, а пружина — в CSS linear(). Hostile/polyfill-защита, C1-подхват
 * и произвольные keyframes намеренно остаются контрактом полного ./animate.
 */

import { BASE_GRID_MAX } from '../compositor/segmenter.js';

export interface NanoSpring {
  readonly mass: number;
  readonly stiffness: number;
  readonly damping: number;
}

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

function springLinear(input?: NanoSpring): [number, string] {
  const k = input?.stiffness ?? 170;
  const c = input?.damping ?? 26;
  const m = input?.mass ?? 1;
  if (!(k > 0 && c > 0 && m > 0)
    || !Number.isFinite(k) || !Number.isFinite(c) || !Number.isFinite(m)) {
    throw new RangeError('spring parameters must be finite and positive');
  }
  const w = Math.sqrt(k / m);
  // Сначала нормализуем ОДУ по mass: `2*m` само переполняется при конечных
  // scale-equivalent m/k/c и не должно менять физику той же системы.
  const a = c / m / 2;
  const d = Math.sqrt(Math.abs(w * w - a * a));
  const critical = d <= w * Math.sqrt(Number.EPSILON);
  const under = a < w && !critical;
  const slow = under ? 0 : critical ? w : w * w / (a + d);
  const fast = under || critical ? 0 : -a - d;
  const sample = under
    ? (t: number) => 1 - Math.exp(-a * t)
      * (Math.cos(d * t) + a / d * Math.sin(d * t))
    : critical
      ? (t: number) => 1 - Math.exp(-w * t) * (1 + w * t)
      : (t: number) => 1
        - (fast * Math.exp(-slow * t) + slow * Math.exp(fast * t)) / (fast + slow);
  const velocity = under
    ? (t: number) => Math.exp(-a * t) * w * w / d * Math.sin(d * t)
    : critical
      ? (t: number) => Math.exp(-w * t) * w * w * t
      : (t: number) => w * w / (-fast - slow)
        * (Math.exp(-slow * t) - Math.exp(fast * t));

  // ε=1e-3 — тот же физический settle-допуск, что у runtime пакета. Для
  // осцилляций длительность выводится из строгих огибающих позиции и скорости;
  // монотонные режимы ищутся в безразмерном времени медленного полюса.
  const epsilon = 1e-3;
  let duration = under
    ? Math.max(
        Math.log(w / d / epsilon) / a,
        Math.log(w * w / d / (30 * epsilon)) / a,
      )
    : 0;
  if (!under) {
    const step = 1 / (30 * slow);
    do duration += step;
    while (1 - sample(duration) > epsilon || velocity(duration) / 30 > epsilon);
  }
  if (!Number.isFinite(duration)) throw new RangeError('spring is not representable');

  // Для линейной интерполяции ошибка сегмента <= max|x''|*h^2/8. У пассивной
  // step-response max|x''|=ω², поэтому число узлов выводится из ε, не из Hz/cap.
  const count = Math.ceil(duration * w / Math.sqrt(8 * epsilon));
  // Тот же физический потолок, что у полного compositor-компилятора: выше
  // синхронной CSS-строки живой solver дешевле и не блокирует event loop.
  if (!(count <= BASE_GRID_MAX)) throw new RangeError('spring is not representable');
  const points: number[] = [];
  for (let index = 0; index <= count; index++) {
    points.push(Math.round(sample(duration * index / count) * 1e4) / 1e4);
  }
  points[count] = 1;
  return [duration * 1000, `linear(${points})`];
}

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
