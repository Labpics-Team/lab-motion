/**
 * animate/compositor-unit.ts — исполнительный WAAPI-юнит поверх ProgressCurveIR
 * (срез R2 rebuild): ОДНА группа каналов одного элемента = одна host Animation.
 *
 * Роль в перестройке ./animate: планировщик собирает компактный план
 * (краевые значения, IR-кривая, швы) и решает маршрут/владение; юнит только
 * исполняет. Физика сюда не входит: кривая уже скомпилирована linear-compile,
 * интерполяцию значений (включая цвета) делает браузер по easing-строке.
 *
 * Режимы исполнения (кроссплатформенная директива владельца):
 *   - linear(): два кадра [from, to] + easing toLinear(ir.points) —
 *     вся кривая в прогресс-пространстве, ноль работы main-потока;
 *   - explicit keyframes (linearSupported=false): пары IR становятся offsets
 *     кадров; значения — from + (to−from)·value ТОЛЬКО для числовых пар.
 *     Нечисловая пара без linear() → честный undefined-отказ фабрики:
 *     судьбу решает планировщик, интерполятор цветов юнит не тянет.
 *
 * Lazy-commit (ТЗ «Скорость»): конструктор НЕ трогает DOM. Физический
 * element.animate уходит в ОДИН queueMicrotask на пачку юнитов (статический
 * аккумулятор; identity очереди = epoch, см. scheduleFlush). Старт намеренно
 * НЕ на rAF: freeze-преимущество WAAPI не размывается кадровой очередью.
 * До коммита контролы работают на виртуальном состоянии: cancel/seek/pause
 * не делают ни одного DOM-вызова.
 *
 * Дисциплина native (hostile host): транзакционный старт — сбой host-animate
 * не оставляет частичных эффектов (частичный effect снимается, finished
 * реджектится причиной); опциональные host-методы (pause/play/commitStyles)
 * читаются РОВНО один раз после animate(); currentTime хоста НИКОГДА не
 * читается — источник времени только инжектированный now (снимок прогресса
 * аналитический: бинарный поиск + lerp по ir.points). Реентрантные контролы
 * из host-колбэков гасятся транзакционным замком (канон waapi-unit).
 *
 * Ownership: юнит не знает реестра целиком — наружу только _supersede()/
 * _rollback() в терминах waapi-unit (совместимость с фасадным протоколом);
 * кто владеет группой — решает планировщик.
 *
 * Не публичный entry: модуль внутренний, exports в package.json не участвует.
 */

import { type SetTimerFn } from '../compositor/core.js';
import { MotionParamError, type MotionParamErrorCode } from '../errors.js';
import { toLinear, type ProgressCurveIR } from './linear-compile.js';

/** @motionErrorFactory */
function failUnit(code: MotionParamErrorCode): never {
  throw new MotionParamError(code);
}

// HTML-таймеры клампят задержки выше signed int32 — граница платформы;
// добор остатка делает bounded-цикл _armTimer (та же дисциплина waapi-unit).
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Duck-контракт цели: setProperty для фиксации позы + Element.animate. */
export interface CompositorUnitTarget {
  readonly style: { setProperty(name: string, value: string): void };
  animate(
    keyframes: Record<string, string | number>[],
    timing: Record<string, unknown>,
  ): unknown;
}

/** Инжектируемые швы детерминизма — без чтения глобальных часов/таймеров. */
export interface CompositorUnitSeams {
  readonly now: () => number;
  readonly setTimer: SetTimerFn;
}

/** Возможности среды, разрешённые планировщиком (детект — его забота). */
export interface CompositorUnitCapability {
  readonly linearSupported: boolean;
}

/** Узкий структурный AbortSignal: без зависимости от DOM-lib. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * Компактный план одной группы — собран планировщиком.
 *
 * group — имя, валидное одновременно для WAAPI-кейфрейма и setProperty
 * ('transform' | 'opacity' | односложное CSS-имя; двусоставные имена в форме
 * хоста — забота планировщика следующего среза). keyframes — УЖЕ собранные
 * краевые значения: строки (transform-строка, цвет) либо конечные числа.
 */
export interface CompositorUnitPlan {
  readonly el: CompositorUnitTarget;
  readonly group: string;
  readonly keyframes: readonly [string | number, string | number];
  readonly ir: ProgressCurveIR;
  readonly delayMs: number;
  readonly seams: CompositorUnitSeams;
  readonly capability: CompositorUnitCapability;
  readonly signal?: AbortSignalLike | undefined;
}

/** Аналитический снимок прогресса для C¹-ретаргета планировщиком. */
export interface ProgressSnapshot {
  /** Прогресс-пространство кривой (может выходить за [0,1] при перелёте). */
  readonly value: number;
  /** Скорость прогресса, 1/с — из наклона соседних пар IR. */
  readonly velocity: number;
}

// ─── Статический microtask-батч ──────────────────────────────────────────────
//
// Все юниты, созданные в одном синхронном заходе планировщика, коммитятся
// ОДНИМ queueMicrotask (паттерн aggregate из surface-batch, но без кадров).
// Identity очереди — и есть epoch: flush сначала отвязывает накопитель, так
// что юниты, созданные из host-колбэков во время коммита, честно уходят в
// следующий microtask, а pre-commit cancel гасит слот без DOM-вызовов.

type BatchQueue = Array<CompositorUnit | undefined>;

let batchQueue: BatchQueue | undefined;

function scheduleFlush(unit: CompositorUnit): void {
  let queue = batchQueue;
  if (queue === undefined) {
    const epoch: BatchQueue = (queue = batchQueue = []);
    queueMicrotask(() => {
      if (batchQueue === epoch) batchQueue = undefined;
      for (const pending of epoch) pending?._flush();
    });
  }
  unit._batchSlot = queue.length;
  unit._batchEpoch = queue;
  queue.push(unit);
}

/** Герметичный сброс аккумулятора для детерминированных тестов. */
export function __resetCompositorUnitBatch(): void {
  batchQueue = undefined;
}

// ─── Юнит ────────────────────────────────────────────────────────────────────

/** Канал завершения без аллокаций: natural=false — прерывание/отказ хоста. */
export type CompositorUnitDone = (natural: boolean, failure?: unknown) => void;

/** Исполнитель одной группы: host Animation + виртуальное состояние. */
export class CompositorUnit {
  /** Слот в microtask-очереди; epoch-ссылка инвалидируется при finish. */
  _batchSlot = 0;
  _batchEpoch: BatchQueue | undefined;

  private readonly _el: CompositorUnitTarget;
  private readonly _group: string;
  private readonly _from: string | number;
  private readonly _to: string | number;
  private readonly _numeric: boolean;
  private readonly _points: readonly number[];
  private readonly _durationMs: number;
  private readonly _delayMs: number;
  private readonly _deadline: number;
  private readonly _now: () => number;
  private readonly _setTimer: SetTimerFn;
  /** Кадры и easing материализованы заранее: flush не делает лишней работы. */
  private readonly _frames: Record<string, string | number>[];
  private readonly _easing: string | undefined;
  private readonly _signal: AbortSignalLike | undefined;
  private readonly _onAbort: (() => void) | undefined;
  private readonly _onDone: CompositorUnitDone | undefined;

  /** 0 — pending, 1 — resolved, 2 — rejected(_failure). */
  private _settled: 0 | 1 | 2 = 0;
  private _failure: unknown;
  private _finished: Promise<void> | undefined;
  private _finishedResolve: (() => void) | undefined;
  private _finishedReject: ((reason: unknown) => void) | undefined;
  private _done = false;
  private _locked = false;
  private _paused = false;
  private _flushed = false;
  /** Числовая пауза уже зафиксировала позу инлайн — seek двигает её же. */
  private _held = false;
  /** Виртуальная позиция (мс прогона): до коммита и на паузе. */
  private _base = 0;
  private _startTime = 0;
  private _anim: Record<string, unknown> | undefined;
  private _hostCancel: (() => void) | undefined;
  private _hostPause: (() => void) | undefined;
  private _hostPlay: (() => void) | undefined;
  private _hostCommit: (() => void) | undefined;
  private _timerOff: (() => void) | undefined;

  /** @internal — конструирует фабрика createCompositorUnit (валидация там). */
  constructor(
    el: CompositorUnitTarget,
    group: string,
    from: string | number,
    to: string | number,
    numeric: boolean,
    ir: ProgressCurveIR,
    delayMs: number,
    seams: CompositorUnitSeams,
    frames: Record<string, string | number>[],
    easing: string | undefined,
    signal: AbortSignalLike | undefined,
    dead: boolean,
    onDone: CompositorUnitDone | undefined,
  ) {
    this._el = el;
    this._group = group;
    this._from = from;
    this._to = to;
    this._numeric = numeric;
    this._points = ir.points;
    this._durationMs = ir.durationMs;
    this._delayMs = delayMs;
    this._deadline = delayMs + ir.durationMs;
    this._now = seams.now;
    this._setTimer = seams.setTimer;
    this._frames = frames;
    this._easing = easing;
    this._onDone = onDone;
    if (dead) {
      // Уже отменённый signal: юнит рождается завершённым, ноль DOM/батча.
      this._signal = undefined;
      this._onAbort = undefined;
      this._finish(false);
      return;
    }
    this._signal = signal;
    if (signal !== undefined) {
      const onAbort = (): void => this.cancel();
      this._onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    } else {
      this._onAbort = undefined;
    }
    scheduleFlush(this);
  }

  /**
   * Обещание завершения — ЛЕНИВОЕ: фасад слушает onDone-канал и не платит
   * Promise-аллокацией на юнит (контракт O(1) аллокаций aggregate на N целей);
   * прямой потребитель получает обещание при первом чтении. Отказ host-старта
   * доставляется реджектом; внутренний noop-хендлер помечает promise
   * обслуженным, не меняя семантики потребителя (без него не подписавшийся
   * мгновенно ловил бы unhandled rejection).
   */
  get finished(): Promise<void> {
    if (this._finished === undefined) {
      this._finished = new Promise<void>((resolve, reject) => {
        if (this._settled === 1) resolve();
        else if (this._settled === 2) reject(this._failure);
        else {
          this._finishedResolve = resolve;
          this._finishedReject = reject;
        }
      });
      this._finished.catch(() => {});
    }
    return this._finished;
  }

  // ── Протокол владения (термины waapi-unit; реестр — у планировщика) ───────

  /**
   * Прервать прогон в пользу successor. replacement пишется ДО destructive
   * cleanup: его отказ оставляет старого владельца живым и повторяемым.
   * Для числовой группы поза предварительно фиксируется инлайн — hostile
   * successor не раскрывает underlying style ни на один кадр.
   */
  _supersede(replacement?: () => void): void {
    if (this._done) return;
    if (this._locked) throw new MotionParamError('LM157');
    this._transaction(() => {
      if (this._anim !== undefined && this._numeric) {
        try {
          this._holdInline();
        } catch {
          /* hostile style не блокирует передачу владения */
        }
      }
      replacement?.();
      this._clearTimer();
      this._cancelAnim();
      this._finish(false);
    });
  }

  /** Откат ещё не опубликованного successor: без инлайн-записей. */
  _rollback(): void {
    if (this._done) return;
    this._transaction(() => {
      this._clearTimer();
      this._cancelAnim();
      this._finish(false);
    });
  }

  // ── Контролы ──────────────────────────────────────────────────────────────

  pause(): void {
    if (this._done || this._locked || this._paused) return;
    this._transaction(() => {
      this._base = this._position();
      this._clearTimer();
      if (this._anim !== undefined) {
        let byHost = false;
        if (this._hostPause !== undefined) {
          try {
            this._hostPause.call(this._anim);
            byHost = true;
          } catch {
            /* хост без паузы обслуживается fallback-фиксацией ниже */
          }
        }
        if (!byHost) {
          // Поза фиксируется без чтения стиля: числовая — аналитически из IR,
          // браузерно-интерполируемая — host commitStyles (его отказ — честная
          // деградация к underlying, инвариант «без getComputedStyle» дороже).
          try {
            if (this._numeric) this._holdInline();
            else this._hostCommit?.call(this._anim);
          } catch {
            /* поза не зафиксирована — effect снимается как есть */
          }
          this._cancelAnim();
        }
      }
      this._paused = true;
    });
  }

  play(): void {
    if (this._done || this._locked || !this._paused) return;
    this._transaction(() => {
      this._paused = false;
      // До коммита play лишь снимает виртуальную паузу — стартует microtask.
      if (!this._flushed) return;
      if (this._anim !== undefined && this._hostPlay !== undefined) {
        try {
          this._hostPlay.call(this._anim);
          this._startTime = this._now() - this._base;
          this._armTimer();
          return;
        } catch {
          /* хост без play → ре-эмиссия со смещённым delay */
        }
      }
      this._cancelAnim();
      this._restart(this._base);
    });
  }

  /** Перемотка к времени прогона (мс от начала delay); пауза сохраняется. */
  seek(tMs: number): void {
    if (this._done || this._locked || !Number.isFinite(tMs)) return;
    this._transaction(() => {
      const pos = Math.min(Math.max(tMs, 0), this._deadline);
      this._base = pos;
      if (this._paused || !this._flushed) {
        // Виртуальное состояние: до коммита — ноль DOM; на числовой паузе
        // с уже записанной фиксацией поза двигается той же инлайн-записью.
        if (this._held) {
          try {
            this._holdInline();
          } catch {
            /* hostile style не рвёт виртуальную перемотку */
          }
        }
        return;
      }
      if (this._anim === undefined) return;
      try {
        this._startTime = this._now() - pos;
        // Запись валидна и для hostile read-once getter: сеттер не читает.
        this._anim['currentTime'] = pos;
      } catch {
        this._cancelAnim();
        this._restart(pos);
        return;
      }
      this._armTimer();
    });
  }

  /** Стоп в текущей позиции; finished резолвится (прерывание — не отказ). */
  cancel(): void {
    if (this._done || this._locked) return;
    this._transaction(() => {
      this._clearTimer();
      if (this._anim !== undefined) {
        try {
          if (this._numeric) this._holdInline();
          else this._hostCommit?.call(this._anim);
        } catch {
          /* фиксация позы best-effort; терминализация не блокируется */
        }
        this._cancelAnim();
      }
      this._finish(false);
    });
  }

  /** Аналитический снимок прогресса: только IR + инжектированные часы. */
  _snapshot(): ProgressSnapshot {
    const points = this._points;
    const u = (this._position() - this._delayMs) / this._durationMs;
    if (!(u > 0)) return { value: points[1]!, velocity: 0 };
    const lastPair = points.length - 2;
    if (u >= 1) return { value: points[lastPair + 1]!, velocity: 0 };
    // Бинарный поиск сегмента по offset-парам [offset, value, ...].
    let lo = 0;
    let hi = lastPair / 2;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid * 2]! <= u) lo = mid;
      else hi = mid;
    }
    const o0 = points[lo * 2]!;
    const v0 = points[lo * 2 + 1]!;
    const span = points[hi * 2]! - o0;
    const slope = (points[hi * 2 + 1]! - v0) / span;
    return {
      value: v0 + slope * (u - o0),
      // offset-пространство → секунды: наклон делится на активную длительность.
      velocity: slope / (this._durationMs / 1000),
    };
  }

  // ── Коммит и жизненный цикл ───────────────────────────────────────────────

  /** Вызывается microtask-батчем ровно один раз. @internal */
  _flush(): void {
    this._batchEpoch = undefined;
    this._flushed = true;
    // Отменён или виртуально paused до коммита — DOM не трогается вовсе.
    if (this._done || this._paused) return;
    this._transaction(() => this._restart(this._base));
  }

  /**
   * Транзакционный физический старт с позиции atMs: отрицательный delay
   * смещает host-кривую в середину активной фазы (ре-эмиссия после паузы и
   * fallback-seek без пересборки кадров). Любой сбой хоста снимает частичный
   * effect и терминализирует юнит реджектом finished — планировщик уходит
   * на живой путь; частичных эффектов не остаётся.
   */
  private _restart(atMs: number): void {
    const timing: Record<string, unknown> = {
      duration: this._durationMs,
      iterations: 1,
      fill: 'both',
      composite: 'replace',
    };
    if (this._easing !== undefined) timing['easing'] = this._easing;
    const delay = this._delayMs - atMs;
    if (delay !== 0) timing['delay'] = delay;
    let anim: Record<string, unknown> | null | undefined;
    try {
      this._startTime = this._now() - atMs;
      anim = this._el.animate(this._frames, timing) as
        | Record<string, unknown>
        | null
        | undefined;
      // Read-once граница host-полей: методы читаются один раз сразу после
      // animate(); дальше hostile getters не имеют канала влияния.
      const cancel = anim?.['cancel'];
      if (typeof cancel !== 'function') throw new MotionParamError('LM162');
      const pause = anim!['pause'];
      const play = anim!['play'];
      const commit = anim!['commitStyles'];
      this._anim = anim!;
      this._hostCancel = cancel as () => void;
      this._hostPause = typeof pause === 'function' ? (pause as () => void) : undefined;
      this._hostPlay = typeof play === 'function' ? (play as () => void) : undefined;
      this._hostCommit = typeof commit === 'function' ? (commit as () => void) : undefined;
      this._armTimer();
    } catch (error) {
      this._anim = undefined;
      this._clearTimer();
      try {
        (anim?.['cancel'] as (() => void) | undefined)?.call(anim);
      } catch {
        /* частичный effect мог не создаться — cleanup best-effort */
      }
      this._finish(false, error);
    }
  }

  /**
   * Bounded-таймер завершения: инжектированные часы — единственный авторитет
   * (host currentTime/finished не читаются). Кламп int32 добирается
   * повторными плечами; дрейф paused/seek переармирует то же плечо.
   */
  private _armTimer(): void {
    this._clearTimer();
    let hostOff: (() => void) | undefined;
    const off = (): void => {
      try {
        hostOff?.();
      } catch {
        /* host cleanup не блокирует lifecycle */
      }
    };
    this._timerOff = off;
    const wait = Math.min(Math.max(this._deadline - this._position(), 0), MAX_TIMER_MS);
    hostOff = this._setTimer(() => {
      if (this._timerOff !== off || this._done || this._paused) return;
      if (this._position() >= this._deadline) this._complete();
      else this._armTimer();
    }, wait);
  }

  /** Естественное завершение: финальная поза из плана (SSOT), не из хоста. */
  private _complete(): void {
    this._transaction(() => {
      this._clearTimer();
      try {
        this._el.style.setProperty(this._group, String(this._to));
        this._cancelAnim();
      } catch {
        // Hostile style: fill:both effect остаётся визуальным fallback,
        // логическая ссылка отпускается, терминализация продолжается.
        this._anim = undefined;
      }
      this._finish(true);
    });
  }

  /** Позиция прогона (мс): виртуальная до коммита/на паузе, иначе часы. */
  private _position(): number {
    if (this._done) return this._deadline;
    if (this._paused || this._anim === undefined) return this._base;
    let t: number;
    try {
      t = this._now() - this._startTime;
    } catch {
      return this._base; // отказ часов — fail-closed к последней базе
    }
    // x−x равен нулю только у конечного x: NaN/±∞ не отравляют позицию.
    return t - t === 0 ? Math.min(Math.max(t, 0), this._deadline) : this._base;
  }

  /** Числовая фиксация позы из IR — артефакт как SSOT, стиль не читается. */
  private _holdInline(): void {
    const from = this._from as number;
    const value = from + ((this._to as number) - from) * this._snapshot().value;
    this._el.style.setProperty(
      this._group,
      // Перелёт на краевых величинах может быть непредставим в IEEE-754 —
      // фиксация не эмитит нефинитное (зеркало native valueAt).
      String(Number.isFinite(value) ? value : this._to),
    );
    this._held = true;
  }

  private _cancelAnim(): void {
    const anim = this._anim;
    const cancel = this._hostCancel;
    this._anim = undefined;
    this._hostCancel = undefined;
    this._hostPause = undefined;
    this._hostPlay = undefined;
    this._hostCommit = undefined;
    if (anim === undefined) return;
    try {
      cancel?.call(anim);
    } catch {
      /* duck-цель могла отозвать cancel — прерывание не роняем */
    }
  }

  private _clearTimer(): void {
    const off = this._timerOff;
    this._timerOff = undefined;
    off?.();
  }

  /**
   * Реентрантно-безопасный транзакционный замок: восстанавливает прежний
   * уровень (синхронный host-таймер может завершить юнит изнутри старта).
   */
  private _transaction(action: () => void): void {
    const previous = this._locked;
    this._locked = true;
    try {
      action();
    } finally {
      this._locked = previous;
    }
  }

  private _finish(natural: boolean, failure?: unknown): void {
    if (this._done) return;
    this._done = true;
    this._clearTimer();
    if (this._batchEpoch !== undefined) {
      // Гашение слота = pre-commit отмена без DOM; epoch-ссылка рвётся сразу.
      this._batchEpoch[this._batchSlot] = undefined;
      this._batchEpoch = undefined;
    }
    if (this._signal !== undefined && this._onAbort !== undefined) {
      try {
        this._signal.removeEventListener('abort', this._onAbort);
      } catch {
        /* hostile signal не блокирует терминализацию */
      }
    }
    if (failure === undefined) {
      this._settled = 1;
      this._finishedResolve?.();
    } else {
      this._settled = 2;
      this._failure = failure;
      this._finishedReject?.(failure);
    }
    this._finishedResolve = undefined;
    this._finishedReject = undefined;
    // Callback-канал — после фиксации состояния: бросок слушателя не может
    // оставить юнит полу-завершённым.
    this._onDone?.(natural && failure === undefined, failure);
  }
}

// Symbol.dispose ставится условно: вычисляемый ключ в объявлении класса
// падал бы в средах без символа, а установка на прототип сохраняет
// `using unit = ...` там, где среда её умеет. dispose = cancel (ТЗ §5.5).
const disposeSymbol = (Symbol as { readonly dispose?: symbol }).dispose;
if (disposeSymbol !== undefined) {
  (CompositorUnit.prototype as unknown as Record<symbol, unknown>)[disposeSymbol] =
    function disposeUnit(this: CompositorUnit): void {
      this.cancel();
    };
}

// ─── Фабрика ─────────────────────────────────────────────────────────────────

/**
 * Валидирующая граница плана (каждое hostile-поле читается один раз) →
 * юнит, либо undefined-отказ: explicit-режим не представляет нечисловую
 * пару без интерполятора — маршрут решает планировщик (живой путь/отказ).
 *
 * Бросает MotionParamError по каталогу: LM160/LM161 (цель без animate /
 * style), LM156 (швы/сигнал не функции), LM010 (пустое имя группы),
 * LM141/LM142/LM143 (пара from/to), LM139 (delay), LM137 (длительность IR),
 * LM159 (IR не является кривой прогресса).
 */
export function createCompositorUnit(
  plan: CompositorUnitPlan,
  onDone?: CompositorUnitDone,
): CompositorUnit | undefined {
  const el = plan.el;
  const group = plan.group;
  const pair = plan.keyframes;
  const ir = plan.ir;
  const delayMs = plan.delayMs;
  const seams = plan.seams;
  const capability = plan.capability;
  const signal = plan.signal;

  if (typeof seams?.now !== 'function' || typeof seams.setTimer !== 'function') {
    failUnit('LM156');
  }
  if (typeof (el as Partial<CompositorUnitTarget> | null)?.animate !== 'function') {
    failUnit('LM160');
  }
  if (typeof el.style?.setProperty !== 'function') failUnit('LM161');
  if (typeof group !== 'string' || group.length === 0) failUnit('LM010');
  if (!Array.isArray(pair) || pair.length !== 2) failUnit('LM141');
  const from: unknown = pair[0];
  const to: unknown = pair[1];
  for (const edge of [from, to]) {
    if (typeof edge === 'number') {
      if (!Number.isFinite(edge)) failUnit('LM142');
    } else if (typeof edge !== 'string') {
      failUnit('LM143');
    }
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) failUnit('LM139');
  if (!Number.isFinite(ir?.durationMs) || ir.durationMs <= 0) failUnit('LM137');
  const points = ir.points;
  // Форма IR — контракт linear-compile: чётные пары, минимум две, только
  // конечные числа. Нарушение — ошибка интеграции, не «непредставимость».
  if (!Array.isArray(points) || points.length < 4 || points.length % 2 !== 0) {
    failUnit('LM159');
  }
  for (const n of points) {
    if (typeof n !== 'number' || !Number.isFinite(n)) failUnit('LM159');
  }
  let aborted = false;
  if (signal !== undefined && signal !== null) {
    if (
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function'
    ) failUnit('LM156');
    aborted = signal.aborted === true;
  }

  const numeric = typeof from === 'number' && typeof to === 'number';
  // Строгий гейт capability: любой не-true (включая hostile мусор) — это
  // отсутствие доказанного linear(), безопасный маршрут — явные кадры.
  const linear = capability?.linearSupported === true;
  let frames: Record<string, string | number>[];
  let easing: string | undefined;
  if (linear) {
    frames = [{ [group]: from as string | number }, { [group]: to as string | number }];
    easing = toLinear(points);
  } else if (numeric) {
    const span = (to as number) - (from as number);
    frames = new Array<Record<string, string | number>>(points.length / 2);
    for (let i = 0; i < frames.length; i++) {
      const value = (from as number) + span * points[i * 2 + 1]!;
      frames[i] = {
        [group]: Number.isFinite(value) ? value : (to as number),
        offset: points[i * 2]!,
      };
    }
  } else {
    // Explicit-кадры нечисловой пары требуют интерполятора значений —
    // это вес планировщика/value, юнит честно отказывается.
    return undefined;
  }

  return new CompositorUnit(
    el,
    group,
    from as string | number,
    to as string | number,
    numeric,
    ir,
    delayMs,
    seams,
    frames,
    easing,
    signal ?? undefined,
    aborted,
    onDone,
  );
}
