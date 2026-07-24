/**
 * test/support/waapi-double.ts — ОДИН разделяемый двойник WAAPI/DOM для сьюты.
 *
 * ЗАЧЕМ. В сьюте жили девять независимых самодельных двойников элемента
 * (`fakeEl`, `fakeElement`, `timedEl`, duck-объекты), и каждый реализовывал
 * ровно то, что нужно было своему файлу. Дефекты стирания фасада (#240) прошли
 * мимо тестов именно поэтому: двойник не отдавал `addEventListener`, поэтому
 * finish-хвост продукта (`commitStyles(); cancel();`) НЕ ИСПОЛНЯЛСЯ НИ РАЗУ, и
 * зависящий от него дефект был невидим. Тест не сильнее среды, в которой бежит.
 *
 * ЗАКОН ДВОЙНИКА: он воспроизводит наблюдаемый контракт спецификации, а не
 * удобства теста —
 *   • машина состояний `playState`: idle → running → (finished | idle);
 *   • `cancel()` переводит в **idle**, обнуляет `currentTime` в null, отклоняет
 *     `finished` ошибкой `AbortError` и рассылает событие `cancel`;
 *   • естественное завершение переводит в **finished**, резолвит `finished` и
 *     рассылает `finish` — обе рассылки идут через `addEventListener`;
 *   • `commitStyles()` пишет текущие значения эффекта в `element.style` и
 *     журналируется (продукт обязан звать его ДО `cancel()`, иначе элемент
 *     отскочит в исходное состояние — этот порядок здесь наблюдаем);
 *   • время виртуальное: `clock.advance(ms)`, ноль зависимости от стены.
 *
 * Всё, что двойник НЕ умеет, он умеет явно: `getComputedStyle`/`matchMedia`
 * ставятся `installDomShims()` и снимаются в `afterEach`, поэтому ветка чтения
 * живого стиля исполняется, а не пропускается молча.
 */

export interface AnimateCall {
  readonly keyframes: readonly Record<string, unknown>[];
  readonly timing: Record<string, unknown>;
}

export interface DoubleAnimation {
  playState: 'idle' | 'running' | 'paused' | 'finished';
  currentTime: number | null;
  startTime: number | null;
  readonly finished: Promise<DoubleAnimation>;
  readonly effect: { getComputedTiming(): { duration: number; delay: number } };
  cancel(): void;
  finish(): void;
  pause(): void;
  play(): void;
  commitStyles(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface DoubleElement {
  readonly style: Record<string, string> & {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
    removeProperty(name: string): void;
  };
  animate(keyframes: unknown, timing: unknown): DoubleAnimation;
  getAnimations(): DoubleAnimation[];
  getBoundingClientRect(): DOMRect;
  readonly isConnected: boolean;
}

export interface WaapiDouble {
  /** Элемент, который отдаётся продукту вместо настоящего. */
  readonly el: DoubleElement;
  /** Журнал вызовов `element.animate` в порядке поступления. */
  readonly calls: AnimateCall[];
  /** Живые (не отменённые и не завершённые) анимации. */
  readonly animations: DoubleAnimation[];
  /** Журнал `commitStyles()` — по одному снимку стиля на вызов. */
  readonly commits: Record<string, string>[];
  /** Журнал `cancel()` — индексы анимаций в порядке отмены. */
  readonly cancels: number[];
  /** Двигает виртуальное время: завершает всё, чей срок вышел. */
  advance(ms: number): void;
  /** Текущее виртуальное время (мс от старта двойника). */
  now(): number;
}

function makeStyle(initial: Record<string, string>): DoubleElement['style'] {
  const store: Record<string, string> = { ...initial };
  return new Proxy(store as DoubleElement['style'], {
    get(target, prop: string) {
      if (prop === 'setProperty') {
        return (name: string, value: string) => { store[name] = value; };
      }
      if (prop === 'getPropertyValue') return (name: string) => store[name] ?? '';
      if (prop === 'removeProperty') {
        return (name: string) => { delete store[name]; };
      }
      return target[prop as keyof typeof target];
    },
    set(_target, prop: string, value: string) {
      store[prop] = value;
      return true;
    },
  });
}

/** Числовая длительность и задержка из произвольного timing-объекта WAAPI. */
function timingOf(timing: Record<string, unknown>): { duration: number; delay: number } {
  const duration = typeof timing['duration'] === 'number' ? timing['duration'] : 0;
  const delay = typeof timing['delay'] === 'number' ? timing['delay'] : 0;
  return { duration, delay };
}

/**
 * Создаёт двойник элемента с виртуальными часами.
 *
 * @param initialStyle — начальные значения `element.style` (важно: продукт
 *   читает их как «живое состояние», и именно здесь раньше не было ветки).
 */
export function createWaapiDouble(initialStyle: Record<string, string> = {}): WaapiDouble {
  const calls: AnimateCall[] = [];
  const animations: DoubleAnimation[] = [];
  const commits: Record<string, string>[] = [];
  const cancels: number[] = [];
  const style = makeStyle(initialStyle);
  let clock = 0;

  const el: DoubleElement = {
    style,
    isConnected: true,
    getBoundingClientRect: () => ({
      x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100,
      toJSON: () => ({}),
    }) as DOMRect,
    getAnimations: () => animations.filter((a) => a.playState === 'running' || a.playState === 'paused'),
    animate(keyframes: unknown, timing: unknown) {
      const frames = (Array.isArray(keyframes) ? keyframes : [keyframes]) as Record<string, unknown>[];
      const options = (typeof timing === 'object' && timing !== null ? timing : {}) as Record<string, unknown>;
      calls.push({ keyframes: frames, timing: options });

      const { duration, delay } = timingOf(options);
      const index = animations.length;
      const listeners = new Map<string, Set<() => void>>();
      const startedAt = clock;
      let resolveFinished!: (value: DoubleAnimation) => void;
      let rejectFinished!: (reason: unknown) => void;
      const finished = new Promise<DoubleAnimation>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
      });
      // Спека: неперехваченный reject у cancel() не должен валить процесс —
      // продукт вправе не подписываться на finished.
      finished.catch(() => {});

      const dispatch = (type: string) => {
        for (const listener of listeners.get(type) ?? []) listener();
      };

      const animation: DoubleAnimation = {
        playState: 'running',
        currentTime: 0,
        startTime: startedAt,
        finished,
        effect: { getComputedTiming: () => ({ duration, delay }) },
        addEventListener(type, listener) {
          const set = listeners.get(type) ?? new Set();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener(type, listener) {
          listeners.get(type)?.delete(listener);
        },
        pause() {
          if (animation.playState === 'running') animation.playState = 'paused';
        },
        play() {
          if (animation.playState !== 'finished') animation.playState = 'running';
        },
        commitStyles() {
          // Последний кадр — то, что реально «останется» на элементе.
          const last = frames.at(-1) ?? {};
          for (const [prop, value] of Object.entries(last)) {
            if (prop === 'offset' || prop === 'easing' || prop === 'composite') continue;
            style[prop] = String(value);
          }
          commits.push({ ...(style as unknown as Record<string, string>) });
        },
        finish() {
          if (animation.playState === 'finished' || animation.playState === 'idle') return;
          animation.playState = 'finished';
          animation.currentTime = delay + duration;
          resolveFinished(animation);
          dispatch('finish');
        },
        cancel() {
          if (animation.playState === 'idle') return;
          // Спека: cancel переводит в idle и обнуляет время — именно это
          // делает отменённый прогон НЕОТЛИЧИМЫМ от никогда не стартовавшего,
          // и на этом сломался реестр прогонов в #240.
          animation.playState = 'idle';
          animation.currentTime = null;
          cancels.push(index);
          rejectFinished(Object.assign(new Error('The animation was aborted'), { name: 'AbortError' }));
          dispatch('cancel');
        },
      };
      animations.push(animation);
      return animation;
    },
  };

  return {
    el,
    calls,
    animations,
    commits,
    cancels,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      for (const animation of animations) {
        if (animation.playState !== 'running') continue;
        const { duration, delay } = animation.effect.getComputedTiming();
        const elapsed = clock - (animation.startTime ?? 0);
        animation.currentTime = Math.min(elapsed, delay + duration);
        if (elapsed >= delay + duration) animation.finish();
      }
    },
  };
}

/**
 * Ставит `getComputedStyle` и `matchMedia` в окружении `node` и возвращает
 * функцию снятия. Без них ветки продукта, читающие живой стиль и политику
 * `prefers-reduced-motion`, ПРОПУСКАЮТСЯ молча — тест зелёный, ветка не
 * исполнена (класс дефекта #240).
 */
export function installDomShims(options: {
  computed?: Record<string, string>;
  reducedMotion?: boolean;
} = {}): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousComputed = globals['getComputedStyle'];
  const previousMatchMedia = globals['matchMedia'];
  const computed = options.computed ?? {};

  globals['getComputedStyle'] = (element: unknown) => ({
    getPropertyValue: (name: string) => {
      const own = (element as DoubleElement | undefined)?.style?.getPropertyValue?.(name);
      return own !== undefined && own !== '' ? own : (computed[name] ?? '');
    },
    ...computed,
  });
  globals['matchMedia'] = (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? options.reducedMotion === true : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });

  return () => {
    if (previousComputed === undefined) delete globals['getComputedStyle'];
    else globals['getComputedStyle'] = previousComputed;
    if (previousMatchMedia === undefined) delete globals['matchMedia'];
    else globals['matchMedia'] = previousMatchMedia;
  };
}
