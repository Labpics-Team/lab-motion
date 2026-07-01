/**
 * a11y/index.ts — политика prefers-reduced-motion (subpath ./a11y).
 *
 * Закрывает S20 суперсета: глобальный конфиг reduced-motion (класс
 * MotionConfig у Motion / Globals.skipAnimation у react-spring) —
 * режимы 'system' | 'always' | 'never', реактивная подписка и читатель.
 *
 * Ключ интеграции: конфиг отдаёт СИНТЕЗИРОВАННЫЙ matchMedia-шов, который
 * принимает каждый существующий subpath движка (drive/driver/decay/
 * gestures/flip/presence/lit/...) — политика приложения включается одной
 * строкой, без изменения ядра:
 *
 *   const cfg = createMotionConfig({
 *     reducedMotion: 'system',
 *     matchMedia: window.matchMedia.bind(window),
 *   });
 *   drive({ ..., matchMedia: cfg.matchMedia });
 *   createDrag({ ..., matchMedia: cfg.matchMedia });
 *   cfg.set('always'); // выключить движение во всём приложении
 *
 * Инварианты пакета:
 *   A1. Zero-DOM/SSR-safe: системный matchMedia — инжектируемый шов;
 *       без него 'system' = false (движение включено), 'always' работает.
 *   A2. Не-reduce запросы прозрачно проксируются в системный matchMedia.
 *   A3. Zero runtime deps; никакого модульного глобального состояния —
 *       конфиг это значение, приложение само решает, сколько их.
 */

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Режим политики. */
export type ReducedMotionMode = 'system' | 'always' | 'never';

/** Опции конфига. */
export interface MotionConfigOptions {
  /** Начальный режим. По умолчанию 'system'. */
  readonly reducedMotion?: ReducedMotionMode | undefined;
  /** Системный matchMedia (window.matchMedia.bind(window)); undefined = SSR. */
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
}

/** Конфиг политики reduced-motion. */
export interface MotionConfig {
  /** Эффективное предпочтение с учётом режима. */
  prefersReduced(): boolean;
  /** Сменить режим на лету (уведомляет подписчиков при смене эффекта). */
  set(mode: ReducedMotionMode): void;
  /** Подписка на смену ЭФФЕКТИВНОГО значения; возвращает отписку. */
  onChange(cb: (reduced: boolean) => void): () => void;
  /**
   * Синтезированный matchMedia: reduce-запросы отражают ПОЛИТИКУ, прочие
   * прозрачно идут в системный шов (A2). Передавайте в любой API движка.
   */
  matchMedia(query: string): MediaQueryList;
  readonly mode: ReducedMotionMode;
}

// ─── Внутреннее ──────────────────────────────────────────────────────────────

const REDUCE_QUERY_RE = /prefers-reduced-motion\s*:\s*reduce/;

function systemPrefersReduced(mm: ((q: string) => MediaQueryList) | undefined): boolean {
  if (typeof mm !== 'function') return false;
  try {
    return mm('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/** Минимальный статический MediaQueryList-совместимый объект. */
function staticMql(query: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

// ─── createMotionConfig ──────────────────────────────────────────────────────

/** Создать политику reduced-motion. */
export function createMotionConfig(options?: MotionConfigOptions): MotionConfig {
  const systemMM = options?.matchMedia;
  let mode: ReducedMotionMode =
    options?.reducedMotion === 'always' || options?.reducedMotion === 'never'
      ? options.reducedMotion
      : 'system';
  const listeners = new Set<(reduced: boolean) => void>();

  const effective = (): boolean =>
    mode === 'always' ? true : mode === 'never' ? false : systemPrefersReduced(systemMM);

  let lastEffective = effective();

  const notifyIfChanged = (): void => {
    const now = effective();
    if (now === lastEffective) return;
    lastEffective = now;
    for (const cb of [...listeners]) cb(now);
  };

  // Слушаем системное предпочтение (актуально только в режиме 'system').
  if (typeof systemMM === 'function') {
    try {
      const mql = systemMM('(prefers-reduced-motion: reduce)');
      const handler = (): void => notifyIfChanged();
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', handler);
      else if (typeof (mql as { addListener?: (cb: () => void) => void }).addListener === 'function') {
        (mql as unknown as { addListener: (cb: () => void) => void }).addListener(handler);
      }
    } catch {
      // Системный шов без подписки — политика остаётся опрашиваемой.
    }
  }

  return {
    prefersReduced(): boolean {
      return effective();
    },
    set(next: ReducedMotionMode): void {
      if (next !== 'system' && next !== 'always' && next !== 'never') return;
      mode = next;
      notifyIfChanged();
    },
    onChange(cb: (reduced: boolean) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    matchMedia(query: string): MediaQueryList {
      if (REDUCE_QUERY_RE.test(query)) return staticMql(query, effective());
      if (typeof systemMM === 'function') {
        try {
          return systemMM(query);
        } catch {
          return staticMql(query, false);
        }
      }
      return staticMql(query, false);
    },
    get mode(): ReducedMotionMode {
      return mode;
    },
  };
}
