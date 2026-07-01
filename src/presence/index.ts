/**
 * presence/index.ts — машина enter/exit lifecycle (subpath ./presence).
 *
 * Закрывает S13 суперсета: класс AnimatePresence (Motion) / useTransition
 * (react-spring) — «элемент хочет размонтироваться → доиграть exit-анимацию →
 * ТОЛЬКО потом убрать из DOM», с честными прерываниями в обе стороны.
 *
 * Архитектура: headless-машина состояний; сами анимации запускает потребитель
 * в onEnterStart/onExitStart и сообщает о завершении вызовом полученного
 * `done`. `done` привязан к СВОЕЙ фазе поколением (generation) — после
 * прерывания завершение старой анимации не двигает машину (тот же класс
 * stale-инвалидации, что в MotionValue/drag).
 *
 *   const p = createPresence({
 *     onEnterStart: (done) => drive({ ..., onStep, matchMedia }).then(done),
 *     onExitStart:  (done) => drive({ ... }).then(done),
 *     onGone: () => element.remove(),
 *   });
 *   p.enter(); // добавили в DOM → входная анимация
 *   p.exit();  // хотим убрать → выходная анимация → onGone
 *
 * Инварианты пакета:
 *   P1. Zero-DOM/SSR-safe: единственный платформенный шов — инжектируемый
 *       matchMedia (для prefers-reduced-motion).
 *   P2. Reduced-motion CHARACTER-switch: анимационной фазы НЕТ — enter()
 *       мгновенно present, exit() мгновенно gone (элемент не «зависает»
 *       и не мигает); onEnterStart/onExitStart не вызываются.
 *   P3. Детерминизм: никаких таймеров/часов внутри — темп задаёт потребитель.
 *   P4. Zero runtime deps.
 */

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Состояние присутствия элемента. */
export type PresenceState = 'gone' | 'entering' | 'present' | 'exiting';

/** Опции машины присутствия. */
export interface PresenceOptions {
  /** Стартовать в 'present' (элемент уже в DOM). По умолчанию false → 'gone'. */
  readonly initiallyPresent?: boolean | undefined;
  /**
   * Начало входной анимации. Потребитель обязан вызвать `done` по её
   * завершении — машина перейдёт в 'present'. После прерывания done инертен.
   */
  readonly onEnterStart?: ((done: () => void) => void) | undefined;
  /** Начало выходной анимации; `done` → 'gone'. */
  readonly onExitStart?: ((done: () => void) => void) | undefined;
  /** Терминально вошли (в т.ч. мгновенно при reduced-motion). */
  readonly onPresent?: (() => void) | undefined;
  /** Терминально ушли — безопасный момент убрать элемент из DOM. */
  readonly onGone?: (() => void) | undefined;
  /** Инжектируемый matchMedia для prefers-reduced-motion (P2). */
  readonly matchMedia?: ((query: string) => MediaQueryList) | undefined;
}

/** Контроллер присутствия. */
export interface PresenceControls {
  /** Запросить вход (идемпотентен в entering/present). */
  enter(): void;
  /** Запросить выход (идемпотентен в exiting/gone). */
  exit(): void;
  /** Подписка на смену состояния; возвращает отписку. Вызов синхронный. */
  onStateChange(cb: (state: PresenceState) => void): () => void;
  readonly state: PresenceState;
}

// ─── Внутреннее ──────────────────────────────────────────────────────────────

function prefersReducedMotion(matchMedia: ((q: string) => MediaQueryList) | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ─── createPresence ──────────────────────────────────────────────────────────

/** Создать машину enter/exit lifecycle. */
export function createPresence(options?: PresenceOptions): PresenceControls {
  let state: PresenceState = options?.initiallyPresent ? 'present' : 'gone';
  /** Инвалидация done прерванных фаз (класс stale-callback). */
  let generation = 0;
  const listeners = new Set<(s: PresenceState) => void>();

  // Переход: терминальный колбэк (onPresent/onGone) — ЧАСТЬ перехода и идёт
  // ДО слушателей onStateChange: потребитель успевает снять элемент из DOM
  // прежде, чем координаторы (swapPresence) начнут вводить новый.
  const transition = (s: PresenceState, notify?: (() => void) | undefined): void => {
    state = s;
    notify?.();
    for (const cb of [...listeners]) cb(s);
  };

  const makeDone = (expect: PresenceState, terminal: PresenceState, notify: (() => void) | undefined) => {
    const gen = generation;
    let used = false;
    return (): void => {
      if (used || gen !== generation || state !== expect) return; // stale/повторный
      used = true;
      transition(terminal, notify);
    };
  };

  return {
    enter(): void {
      if (state === 'entering' || state === 'present') return;
      if (prefersReducedMotion(options?.matchMedia)) {
        // P2: анимационной фазы нет — мгновенно терминальное состояние.
        generation++;
        transition('present', options?.onPresent);
        return;
      }
      generation++; // инертит done прерванного exit'а
      transition('entering');
      const done = makeDone('entering', 'present', options?.onPresent);
      if (options?.onEnterStart) options.onEnterStart(done);
      else done(); // аниматор не задан — вход мгновенен
    },
    exit(): void {
      if (state === 'exiting' || state === 'gone') return;
      if (prefersReducedMotion(options?.matchMedia)) {
        generation++;
        transition('gone', options?.onGone);
        return;
      }
      generation++; // инертит done прерванного enter'а
      transition('exiting');
      const done = makeDone('exiting', 'gone', options?.onGone);
      if (options?.onExitStart) options.onExitStart(done);
      else done();
    },
    onStateChange(cb: (s: PresenceState) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get state(): PresenceState {
      return state;
    },
  };
}

// ─── swapPresence ────────────────────────────────────────────────────────────

/** Режим замены: 'wait' — вход нового после ухода старого; 'sync' — одновременно. */
export interface SwapPresenceOptions {
  readonly mode: 'wait' | 'sync';
}

/**
 * Координатор замены old→new (класс режимов AnimatePresence).
 * 'wait': exit старого; вход нового ТОЛЬКО по его terminal 'gone'
 * (прерывание exit'а — например, prev.enter() — отменяет своп: наблюдатель
 * увидит state ≠ 'gone' и не даст ложного входа).
 * 'sync': exit старого и enter нового стартуют одновременно.
 */
export function swapPresence(
  prev: PresenceControls,
  next: PresenceControls,
  options: SwapPresenceOptions,
): void {
  if (options.mode === 'sync') {
    prev.exit();
    next.enter();
    return;
  }
  // 'wait': подписка на state старого — синхронно, без таймеров/опроса (P3).
  // 'gone' → входит новый; любой другой переход из exiting (например,
  // prev.enter() передумал) — своп отменён, отписка.
  const unsub = prev.onStateChange((s) => {
    if (s === 'gone') {
      unsub();
      next.enter();
    } else if (s !== 'exiting') {
      unsub(); // exit прерван — новый не входит
    }
  });
  prev.exit();
  if (prev.state === 'gone') {
    // exit завершился синхронно ВНУТРИ prev.exit() ДО подписки-срабатывания?
    // Нет: подписка стоит до exit(). Ветка — страховка идемпотентности,
    // когда prev уже был 'gone' (exit() = no-op, событий не будет).
    unsub();
    if (next.state !== 'present' && next.state !== 'entering') next.enter();
  }
}
