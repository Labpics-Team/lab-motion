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
 * Наследование импульса при прерывании (#93, C¹): колбэки фаз получают
 * (done, interrupted, capture). capture(read) регистрирует у ТЕКУЩЕЙ фазы
 * функцию живого снимка её рана; при прерывании (enter во время exiting /
 * exit во время entering) машина синхронно зовёт снимок и передаёт его
 * новой фазе вторым аргументом — reversed continuation вместо телепорта:
 *
 *   const p = createPresence({
 *     onExitStart: (done, from, capture) => {
 *       const mv = new MotionValue({ initial: from?.value ?? 1,
 *         initialVelocity: from?.velocity ?? 0, spring, clamp: false });
 *       mv.onChange(apply); mv.setTarget(0);   // clamp:false — честный довыбег
 *       capture(() => ({ value: mv.value, velocity: mv.velocity }));
 *     },
 *     onEnterStart: (done, from, capture) => { ...тот же паттерн к 1... },
 *   });
 *
 * Для WAAPI/compositor-рана живого чтения нет — снимайте замкнутой формой:
 * capture(() => readCompositorSpring(spring, { from, to, t: elapsedSec }))
 * (аналитика ./compositor, БЕЗ getComputedStyle). Машина остаётся headless:
 * снимок — непрозрачный S (по умолчанию пара PresenceSnapshot), никакой
 * математики внутри. Снимок читается ТОЛЬКО из живой прерываемой фазы
 * (state-гард takeInterrupted): доигранная фаза не наследуется, reduce-ветка
 * его НЕ читает (P2: без импульса), непрочитанное гасится на первом же
 * следующем переходе (стейл-снимок недостижим).
 *
 * Инварианты пакета:
 *   P1. Zero-DOM/SSR-safe: единственный платформенный шов — инжектируемый
 *       matchMedia (для prefers-reduced-motion).
 *   P2. Reduced-motion CHARACTER-switch: анимационной фазы НЕТ — enter()
 *       мгновенно present, exit() мгновенно gone (элемент не «зависает»
 *       и не мигает); onEnterStart/onExitStart не вызываются, снимок
 *       прерванного рана не читается и не переносится.
 *   P3. Детерминизм: никаких таймеров/часов внутри — темп задаёт потребитель.
 *   P4. Zero runtime deps.
 *
 * ── RED PROOF (#93 срез 5, база = срез 4) ────────────────────────────────────
 * Колбэки фаз звались строго с одним аргументом (done): канала передать
 * (value, velocity) прерванного рана не существовало — enter после exit()
 * стартовал с нуля (телепорт). Тесты presence-impulse-continuity падали
 * 10 из 11: «TypeError: capture is not a function» (третьего аргумента не
 * было; второй, interrupted, был недостижим — всегда undefined).
 *
 * ── MUTATION PROOF (мутанты руками, каждый кусался, откачены) ────────────────
 *   [capture-loss]   при прерывании передавать undefined вместо capture() →
 *                    вертикаль/двойное прерывание RED (7 тестов);
 *   [reduced-leak]   читать снимок и в reduce-ветке (takeInterrupted до снапа) →
 *                    «reduce: …снимок НЕ читается» RED (reads=1 вместо 0);
 *   [stale-clear]    убрать безусловное гашение в takeInterrupted → «регистратор
 *                    прерванной фазы инертен» RED (стейл 'live-enter' утёк);
 *   [state-guard]    снять `state === running` в takeInterrupted (читать всегда)
 *                    → «после доигранной фазы снимок погашен» RED;
 *   [register-guard] снять gen-гард регистратора → «регистратор прерванной
 *                    фазы инертен» RED (стейл-регистрация подменила снимок).
 *   [register-late]  создать register ПОСЛЕ transition → «ре-энтрантность…»
 *                    RED (зомби-фаза подменяет живой снимок, ревью PR #128);
 *   [no-finally]     гасить capture без finally → «бросающий read…» RED.
 *   Примечание минимальности: явные гашения capture в reduce-ветках и в живом
 *   done были мёртвым кодом (мутанты не кусались — state-гард takeInterrupted
 *   уже делает чтение стейл-снимка недостижимым, а его безусловное гашение
 *   чистит на первом же переходе) и удалены. НО state-гард сам по себе
 *   НЕдостаточен под ре-энтрантностью (слушатель onStateChange синхронно
 *   меняет фазу): done/register обязаны фиксировать генерацию ДО transition —
 *   иначе регистратор зомби-фазы снимает чужую генерацию (ревью PR #128).
 */

import type { MatchMediaLike } from '../internal/media-query.js';

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Состояние присутствия элемента. */
export type PresenceState = 'gone' | 'entering' | 'present' | 'exiting';

/**
 * Снимок прерванного рана по умолчанию — каноническая пара #93
 * (value в единицах значения, velocity — units/s). Тип-подсказка для S;
 * машина снимок не интерпретирует (можно нести вектор каналов и т.п.).
 */
export interface PresenceSnapshot {
  readonly value: number;
  readonly velocity: number;
}

/**
 * Колбэк старта фазы: `done` — сообщить о её завершении; `interrupted` —
 * снимок прерванного встречного рана (undefined, если прерывать было нечего
 * или снимок не регистрировался); `capture` — зарегистрировать функцию живого
 * снимка ТЕКУЩЕГО рана (зовётся машиной синхронно в момент прерывания;
 * регистратор прерванной фазы инертен — тот же класс stale-гарда, что done).
 */
export type PresencePhaseStart<S> = (
  done: () => void,
  interrupted: S | undefined,
  capture: (read: () => S) => void,
) => void;

/** Опции машины присутствия. */
export interface PresenceOptions<S = PresenceSnapshot> {
  /** Стартовать в 'present' (элемент уже в DOM). По умолчанию false → 'gone'. */
  readonly initiallyPresent?: boolean | undefined;
  /**
   * Начало входной анимации. Потребитель обязан вызвать `done` по её
   * завершении — машина перейдёт в 'present'. После прерывания done инертен.
   * `interrupted`/`capture` — наследование импульса (#93), см. шапку модуля.
   */
  readonly onEnterStart?: PresencePhaseStart<S> | undefined;
  /** Начало выходной анимации; `done` → 'gone'. */
  readonly onExitStart?: PresencePhaseStart<S> | undefined;
  /** Терминально вошли (в т.ч. мгновенно при reduced-motion). */
  readonly onPresent?: (() => void) | undefined;
  /** Терминально ушли — безопасный момент убрать элемент из DOM. */
  readonly onGone?: (() => void) | undefined;
  /** Инжектируемый matchMedia для prefers-reduced-motion (P2). */
  readonly matchMedia?: MatchMediaLike | undefined;
}

/** Контроллер присутствия. */
export interface PresenceControls {
  /** Запросить вход (идемпотентен в entering/present). */
  enter(): void;
  /** Запросить выход (идемпотентен в exiting/gone). */
  exit(): void;
  /**
   * Подписка на смену состояния; возвращает отписку. Вызов синхронный.
   * При синхронной ре-энтрантности (терминальный колбэк сам зовёт
   * enter()/exit()) аргумент может отставать — авторитетен `controls.state`,
   * читайте его, а не доверяйте аргументу слепо.
   */
  onStateChange(cb: (state: PresenceState) => void): () => void;
  readonly state: PresenceState;
}

// ─── Внутреннее ──────────────────────────────────────────────────────────────

function prefersReducedMotion(matchMedia: MatchMediaLike | undefined): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

// ─── createPresence ──────────────────────────────────────────────────────────

/** Создать машину enter/exit lifecycle. */
export function createPresence<S = PresenceSnapshot>(
  options?: PresenceOptions<S>,
): PresenceControls {
  let state: PresenceState = options?.initiallyPresent ? 'present' : 'gone';
  /** Инвалидация done прерванных фаз (класс stale-callback). */
  let generation = 0;
  /** Функция живого снимка ТЕКУЩЕЙ фазы (наследование импульса #93). */
  let capture: (() => S) | undefined;
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
      // Снимок доигранной фазы гасить здесь не нужно: takeInterrupted читает
      // ТОЛЬКО из живой фазы (state-гард) и гасит на первом же новом переходе.
      transition(terminal, notify);
    };
  };

  /** Регистратор снимка фазы `gen`: после прерывания (generation++) инертен. */
  const makeRegister = (): ((read: () => S) => void) => {
    const gen = generation;
    return (read: () => S): void => {
      if (gen === generation) capture = read;
    };
  };

  /**
   * Снимок встречного рана в момент прерывания: читается синхронно, ровно один
   * раз, ТОЛЬКО если прерываем живую фазу `running` (из терминальных состояний
   * снимка нет по построению — done его погасил). Всегда гасит capture.
   */
  const takeInterrupted = (running: PresenceState): S | undefined => {
    // finally: capture гасится даже если read бросил — иначе машина остаётся
    // полу-мёртвой (state не сменился, снимок не погашен, ретрай бросает снова).
    try {
      return state === running && capture !== undefined ? capture() : undefined;
    } finally {
      capture = undefined;
    }
  };

  return {
    enter(): void {
      if (state === 'entering' || state === 'present') return;
      if (prefersReducedMotion(options?.matchMedia)) {
        // P2: анимационной фазы нет — мгновенно терминальное состояние; снимок
        // НЕ читается (импульс не переносится). Явное гашение не нужно:
        // takeInterrupted стережёт состоянием и гасит при первом же не-reduce
        // переходе (чтение стейл-снимка из терминального состояния недостижимо).
        generation++;
        transition('present', options?.onPresent);
        return;
      }
      // Reversed continuation (#93): снимок exit-рана — ДО перехода.
      const interrupted = takeInterrupted('exiting');
      generation++; // инертит done прерванного exit'а
      // done/register фиксируют СВОЮ генерацию ДО transition: слушатель
      // onStateChange может ре-энтрантно сменить фазу (generation++), и
      // регистратор, созданный после, снял бы ЧУЖУЮ генерацию — зомби-фаза
      // перезаписала бы живой снимок (пробой state-гарда takeInterrupted).
      const done = makeDone('entering', 'present', options?.onPresent);
      const register = makeRegister();
      transition('entering');
      if (options?.onEnterStart) options.onEnterStart(done, interrupted, register);
      else done(); // аниматор не задан — вход мгновенен
    },
    exit(): void {
      if (state === 'exiting' || state === 'gone') return;
      if (prefersReducedMotion(options?.matchMedia)) {
        generation++;
        transition('gone', options?.onGone);
        return;
      }
      const interrupted = takeInterrupted('entering'); // симметрия наследования
      generation++; // инертит done прерванного enter'а
      // Симметрично enter(): done/register — ДО transition (ре-энтрантность).
      const done = makeDone('exiting', 'gone', options?.onGone);
      const register = makeRegister();
      transition('exiting');
      if (options?.onExitStart) options.onExitStart(done, interrupted, register);
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
 *
 * Контракт 'wait': если потребитель НИКОГДА не вызовет done у exit-анимации
 * старого, новый не войдёт, а подписка останется жить — доигрывание exit'а
 * ответственность потребителя (машина без таймеров по P3 и не имеет права
 * «дотаймаутить» за него).
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
