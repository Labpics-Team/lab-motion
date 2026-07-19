/**
 * nano/run.ts — platform-trusted исполнительный хвост nano: резолв целей,
 * native WAAPI-запуск и агрегированный finished с commitStyles/cancel.
 * Общий SSOT для ./nano и private compiler-executor (#208): compiled-путь
 * обязан исполняться ровно тем же кодом, что runtime, отличаясь только
 * источником duration/easing (build-time артефакт вместо springLinear).
 */

export type NanoTarget = Element | string | Iterable<Element> | ArrayLike<Element>;

export type NanoControls = Animation[] & { finished: Promise<Animation[]> };

export function runNano(
  target: NanoTarget,
  frame: PropertyIndexedKeyframes,
  duration: number,
  easing: string,
  delay: number,
  stagger: number,
  reduced: boolean,
): NanoControls {
  const source = typeof target === 'string'
    ? document.querySelectorAll(target)
    : 'animate' in target ? [target] : target;
  const animations = Array.from(source, (element, index) => {
    const animation = element.animate(frame, {
      duration: reduced ? 0 : duration,
      easing: reduced ? 'linear' : easing,
      delay: reduced ? 0 : delay + stagger * index,
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
