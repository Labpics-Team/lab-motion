/**
 * timeline/index.ts — S11: headless zero-DOM timeline orchestrator subpath.
 *
 * Компонует несколько tween-сегментов вдоль единого виртуального времени.
 * Offset/at-позиционирование, seek/progress, stagger-compatible.
 * Переиспользует tween-паттерн и инъектируемый virtual-time seam из core.
 *
 * Инварианты (North):
 *   1. Zero runtime deps — нет внешних npm-зависимостей.
 *   2. CSS-safe — все эмитируемые значения всегда конечны (NaN/Infinity запрещены).
 *   3. Детерминизм — clock инжектируется; одинаковый seam → идентичный вывод.
 *   4. Reduced-motion — CHARACTER-switch: snap-to-final (все сегменты → `to`), НЕ hard-off.
 *   5. Domain purity — никаких querySelector/document/window/DOM внутри ядра.
 *   6. SSR-safe — нет window/document при импорте.
 */

import { MotionParamError } from '../errors.js';

// ─── Внутренние константы ────────────────────────────────────────────────────

/** Фиксированный dt (с) при отсутствии DOMHighResTimeStamp. */
const FIXED_DT_S = 1 / 60;
/**
 * Жёсткий cap кадров (safety escape от патологически огромного totalDuration).
 * 100_000 кадров ≈ 1666 с (~27 мин) при 60fps — заведомо больше любой
 * практической анимации, но всё ещё конечен как fail-safe от зависания.
 */
const MAX_FRAMES = 100_000;

// ─── Вспомогательные функции ─────────────────────────────────────────────────

/**
 * Зажать значение к конечному диапазону.
 * NaN → 0 (spring-at-rest позиция; безопасный CSS-дефолт)
 * +Infinity → Number.MAX_VALUE
 * -Infinity → -Number.MAX_VALUE
 */
function clampFinite(x: number): number {
  if (Number.isFinite(x)) return x;
  if (Number.isNaN(x)) return 0;
  return x > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

/**
 * Структурный подвид MediaQueryList — только то, что нужно timeline.
 * Используется вместо DOM-типа MediaQueryList, чтобы не протаскивать
 * lib.dom.d.ts в публичный API headless zero-DOM subpath'а (Invariant 5).
 */
export interface MatchMediaResult {
  readonly matches: boolean;
}

/** Считать prefers-reduced-motion из инжектируемого matchMedia. */
function prefersReducedMotion(
  matchMedia: ((query: string) => MatchMediaResult) | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ─── Публичные типы ───────────────────────────────────────────────────────────

/**
 * Конфигурация одного tween-сегмента таймлайна.
 *
 * Позиционирование:
 *   • `at` (абсолютное) — переопределяет `offset`, если оба заданы.
 *   • `offset` (относительное) — задержка после конца предыдущего сегмента.
 *   • По умолчанию: offset=0 → сегменты идут последовательно.
 */
export interface SegmentConfig {
  /** Начальное значение. Должно быть конечным числом. */
  readonly from: number;
  /** Конечное значение. Должно быть конечным числом. */
  readonly to: number;
  /**
   * Длительность сегмента (секунды виртуального времени).
   * Должна быть > 0 и конечной.
   */
  readonly duration: number;
  /**
   * Задержка (секунды) относительно конца предыдущего сегмента.
   * >= 0 и конечное. По умолчанию: 0.
   * Игнорируется если задан `at`.
   */
  readonly offset?: number;
  /**
   * Абсолютное начальное время (секунды). Если задан — игнорирует `offset`.
   * Должен быть >= 0 и конечным.
   */
  readonly at?: number;
  /**
   * Функция easing (нормализованное время 0..1 → 0..1).
   * По умолчанию: линейная идентичность.
   * Выход зашивается guard'ом конечности: NaN→0, ±Infinity→±MAX_VALUE.
   */
  readonly easing?: (t: number) => number;
  /**
   * Per-сегментный колбэк. Вызывается при каждом шаге с текущим значением.
   * При reduce=true вызывается однократно синхронно с `to`.
   */
  readonly onStep?: (value: number) => void;
}

/** Значение одного сегмента в текущий момент. */
export interface SegmentValue {
  /** Индекс сегмента в массиве opts.segments. */
  readonly index: number;
  /** Текущее конечное значение. */
  readonly value: number;
}

/** Опции для createTimeline(). */
export interface TimelineOptions {
  /**
   * Конфигурации сегментов. Не может быть пустым.
   * @throws MotionParamError если пусто или содержит невалидные значения.
   */
  readonly segments: readonly SegmentConfig[];
  /**
   * Глобальный колбэк — массив значений всех сегментов на каждом шаге.
   * При reduce=true вызывается однократно с финальными значениями.
   */
  readonly onStep?: (values: readonly SegmentValue[]) => void;
  /**
   * Injectable requestAnimationFrame-заменитель.
   * Возврат 0 = non-draining (для тестов с виртуальным временем).
   */
  readonly requestFrame?: ((cb: (ts?: number) => void) => number) | undefined;
  /**
   * Injectable matchMedia. В браузере: `window.matchMedia.bind(window)`.
   * undefined = SSR / нет предпочтений (reduce=false).
   * Тип структурный (`{ matches: boolean }`), не DOM `MediaQueryList` —
   * headless zero-DOM subpath не должен требовать lib.dom.d.ts (Invariant 5).
   */
  readonly matchMedia?: ((query: string) => MatchMediaResult) | undefined;
}

/** Управляемый хендл таймлайна. Возвращается createTimeline(). Thenable. */
export interface TimelineControls {
  /** Суммарная длительность таймлайна (секунды). Конечна и >= 0. */
  readonly totalDuration: number;
  /** Текущее виртуальное время (секунды). */
  readonly time: number;
  /** Нормированный прогресс [0, 1]. 1 = все сегменты завершены. */
  readonly progress: number;

  /** Возобновить воспроизведение (no-op если уже играет или завершён). */
  play(): void;
  /** Остановить воспроизведение (no-op если уже завершён). */
  pause(): void;
  /**
   * Перемотать к виртуальному времени t (секунды).
   * t < 0 → 0, NaN → no-op, +Infinity → complete().
   * Эмитирует значения всех сегментов при новом времени.
   */
  seek(t: number): void;
  /**
   * Немедленно снэпнуть к финальным значениям всех сегментов (to) и
   * разрешить Promise.
   */
  complete(): void;
  /**
   * Остановить таймлайн в текущей позиции и разрешить Promise.
   * Эмитирует текущие значения.
   */
  cancel(): void;

  /**
   * Thenable — позволяет `await timeline` или `timeline.then(cb)`.
   * Резолвится при любом завершении (complete/cancel/natural).
   */
  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): Promise<TResult1 | TResult2>;
}

// ─── Внутренняя скомпилированная структура сегмента ─────────────────────────

interface ComputedSegment {
  readonly from: number;
  readonly to: number;
  readonly startTime: number;  // абсолютное виртуальное время начала
  readonly endTime: number;    // startTime + duration
  readonly easing: (t: number) => number;
  readonly onStep: ((value: number) => void) | undefined;
  /** true если range = to − from переполняется (→ ±Infinity). */
  readonly hasOverflowRange: boolean;
}

// ─── Построение скомпилированных сегментов ───────────────────────────────────

function buildSegments(configs: readonly SegmentConfig[]): ComputedSegment[] {
  const result: ComputedSegment[] = [];
  let prevEndTime = 0;

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]!;

    // Валидация from/to/duration
    if (!Number.isFinite(cfg.from)) {
      throw new MotionParamError(
        `timeline: segment[${i}].from должен быть конечным числом, получено ${cfg.from}`,
      );
    }
    if (!Number.isFinite(cfg.to)) {
      throw new MotionParamError(
        `timeline: segment[${i}].to должен быть конечным числом, получено ${cfg.to}`,
      );
    }
    if (!Number.isFinite(cfg.duration) || cfg.duration <= 0) {
      throw new MotionParamError(
        `timeline: segment[${i}].duration должен быть положительным конечным числом, получено ${cfg.duration}`,
      );
    }

    // Позиционирование
    let startTime: number;
    if (cfg.at !== undefined) {
      if (!Number.isFinite(cfg.at) || cfg.at < 0) {
        throw new MotionParamError(
          `timeline: segment[${i}].at должен быть >= 0 и конечным, получено ${cfg.at}`,
        );
      }
      startTime = cfg.at;
    } else {
      const offset = cfg.offset ?? 0;
      if (!Number.isFinite(offset) || offset < 0) {
        throw new MotionParamError(
          `timeline: segment[${i}].offset должен быть >= 0 и конечным, получено ${offset}`,
        );
      }
      startTime = prevEndTime + offset;
    }

    const rawEndTime = startTime + cfg.duration;
    const range = cfg.to - cfg.from;
    // endTime может переполниться в Infinity, даже когда startTime и duration
    // по отдельности конечны (накопленный offset через много сегментов).
    // Не пропускаем Infinity дальше: клампим и трактуем сегмент как overflow
    // (snap к `to`), иначе Infinity протекает в prevEndTime → totalDuration.
    const endTimeOverflowed = !Number.isFinite(rawEndTime);
    const endTime = endTimeOverflowed ? Number.MAX_VALUE : rawEndTime;
    const hasOverflowRange = !Number.isFinite(range) || endTimeOverflowed;

    result.push({
      from: cfg.from,
      to: cfg.to,
      startTime,
      endTime,
      easing: cfg.easing ?? linearEasing,
      onStep: cfg.onStep,
      hasOverflowRange,
    });

    prevEndTime = endTime;
  }

  return result;
}

/** Линейное easing (идентичность) — эталонное значение по умолчанию. */
function linearEasing(t: number): number {
  return t;
}

// ─── Вычисление значения сегмента ────────────────────────────────────────────

/**
 * Вычислить значение сегмента при виртуальном времени t.
 *
 * Семантика:
 *   t < startTime  → from  (сегмент ещё не начался)
 *   t >= endTime   → to    (сегмент завершён)
 *   interior       → tween с easing + finiteness guard
 *
 * Overflow-range (|from|+|to| > MAX_VALUE → range=±Infinity) → snap to `to`.
 */
function computeSegmentAt(seg: ComputedSegment, t: number): number {
  if (t <= seg.startTime) return seg.from;
  if (t >= seg.endTime) return seg.to;

  // Overflow guard: диапазон = ±Infinity → snap to `to`
  if (seg.hasOverflowRange) return seg.to;

  const duration = seg.endTime - seg.startTime;
  const localT = (t - seg.startTime) / duration;

  // Easing с guard на выход (NaN→0, ±Infinity→±MAX_VALUE)
  const rawEased = seg.easing(localT);
  const easedT = clampFinite(rawEased);

  // Tween: from + (to − from) * easedT
  const range = seg.to - seg.from;
  const raw = seg.from + range * easedT;

  // CSS-safety guard: если raw = NaN/Infinity → snap to to
  return Number.isFinite(raw) ? raw : seg.to;
}

// ─── createTimeline ───────────────────────────────────────────────────────────

/**
 * Создаёт управляемый таймлайн анимации из последовательности tween-сегментов.
 *
 * Начинает воспроизведение немедленно. Для старта на паузе вызовите
 * `pause()` сразу после создания (до первого raf-колбэка).
 *
 * Возвращаемый хендл thenable: `await createTimeline(opts)` резолвится при
 * завершении таймлайна.
 *
 * @throws MotionParamError если segments пустой или содержит невалидные значения.
 */
export function createTimeline(opts: TimelineOptions): TimelineControls {
  const { segments: segConfigs, onStep: globalOnStep, matchMedia } = opts;

  // ── Валидация массива сегментов ───────────────────────────────────────────
  if (!segConfigs || segConfigs.length === 0) {
    throw new MotionParamError(
      'timeline: segments не может быть пустым — необходим хотя бы один сегмент',
    );
  }

  // ── Компиляция сегментов (с валидацией полей) ─────────────────────────────
  const segments = buildSegments(segConfigs);

  // ── Суммарная длительность = max(segment.endTime) ────────────────────────
  let _totalDuration = 0;
  for (const seg of segments) {
    if (seg.endTime > _totalDuration) _totalDuration = seg.endTime;
  }
  // Paranoia: если overflow — cap к 0 (будет settle(true) немедленно)
  if (!Number.isFinite(_totalDuration) || _totalDuration < 0) {
    _totalDuration = 0;
  }

  // Perf hotpath: pre-allocated buffer (no per-frame map/object alloc in computeAll/emit for timeline)
  // Use mutable shape internally; cast on return (shape identical, readonly is API contract)
  const _valuesBuffer: { index: number; value: number }[] = segments.map((_, index) => ({ index, value: 0 }));

  // ── Reduced-motion policy ─────────────────────────────────────────────────
  const reduce = prefersReducedMotion(matchMedia);

  // ── Platform frame scheduler ──────────────────────────────────────────────
  const scheduleFrame: (cb: (ts?: number) => void) => number =
    opts.requestFrame ??
    ((cb) =>
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame(cb)
        : (setTimeout(cb, FIXED_DT_S * 1000) as unknown as number));

  // ── Изменяемое состояние ──────────────────────────────────────────────────

  /** Текущее виртуальное время (секунды). */
  let _vt = 0;
  /** Реальный timestamp последнего кадра. undefined = сбрасывается при паузе/seek. */
  let _lastRealTs: number | undefined;
  /** true — воспроизведение на паузе. */
  let _paused = false;
  /** true — таймлайн завершён (settled). Все последующие вызовы — no-op. */
  let _settled = false;
  /** true — loop запущен (tick уже запланирован или выполняется). */
  let _loopRunning = false;
  /** Ре-энтрантный guard тела tick. */
  let _tickActive = false;
  /** true — использовать setTimeout-fallback вместо scheduleFrame. */
  let _useTimeoutFallback = false;
  /** Счётчик кадров (safety cap). */
  let _frameCount = 0;

  // ── Promise ───────────────────────────────────────────────────────────────
  let _resolve!: () => void;
  const _promise = new Promise<void>((res) => {
    _resolve = res;
  });

  // ── Вычисление и эмит ─────────────────────────────────────────────────────

  /**
   * Вычислить значения всех сегментов при времени t.
   * Все значения гарантированно конечны (clampFinite).
   */
  function computeAll(t: number): SegmentValue[] {
    for (let i = 0; i < segments.length; i++) {
      _valuesBuffer[i]!.value = clampFinite(computeSegmentAt(segments[i]!, t));
    }
    return _valuesBuffer as SegmentValue[];
  }

  /**
   * Эмитировать значения всех сегментов при времени t.
   * Вызывает per-сегментный onStep и глобальный onStep.
   */
  function emit(t: number): void {
    const values = computeAll(t);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const val = values[i]!.value;
      if (seg.onStep) seg.onStep(val);
    }
    if (globalOnStep) globalOnStep(values);
  }

  // ── Settlement ────────────────────────────────────────────────────────────

  /**
   * Зафиксировать таймлайн: эмитировать финальное состояние и разрешить Promise.
   * Идемпотентна.
   *
   * @param snapToEnd true = snap все сегменты к `to` (complete/natural),
   *                  false = snap к текущему _vt (cancel/stop).
   */
  function settle(snapToEnd: boolean): void {
    if (_settled) return;
    _settled = true;
    _loopRunning = false;

    // API-контракт: после settle(true) (complete/natural/reduced-motion)
    // .time и .progress должны читаться как totalDuration/1, а не как
    // застрявшее предыдущее _vt (напр. explicit complete() до первого тика).
    if (snapToEnd) _vt = _totalDuration;

    // t = Infinity → computeSegmentAt вернёт `to` для всех сегментов,
    // так как Infinity >= endTime для любого конечного endTime.
    const emitT = snapToEnd ? Infinity : _vt;
    // _resolve() ОБЯЗАН выполниться, даже если пользовательский onStep
    // бросает исключение — иначе `await timeline` зависает навсегда.
    try {
      emit(emitT);
    } finally {
      _resolve();
    }
  }

  // ── Frame loop ────────────────────────────────────────────────────────────

  function tick(ts?: number): void {
    if (_settled) { _loopRunning = false; return; }
    if (_tickActive) return;

    if (_paused) {
      _loopRunning = false;
      _lastRealTs = undefined;
      return;
    }

    _tickActive = true;
    // _tickActive ОБЯЗАН сброситься даже если emit()/settle() ниже бросят
    // исключение (пользовательский onStep) — иначе tick() навсегда
    // ре-энтрантно блокируется (анимация тихо замирает).
    try {
      _frameCount++;

      // Safety cap: предотвращает бесконечный цикл при патологическом
      // totalDuration. Это ИСКЛЮЧИТЕЛЬНО fail-safe, НЕ признак настоящего
      // завершения — settle(false) эмитит ТЕКУЩЕЕ _vt (как cancel), а не
      // snap к `to`, чтобы не выдавать бейлаут за реальный natural-complete.
      if (_frameCount >= MAX_FRAMES) {
        settle(false);
        return;
      }

      // Вычислить dt
      let dt: number;
      if (ts !== undefined) {
        dt = _lastRealTs !== undefined ? (ts - _lastRealTs) / 1000 : FIXED_DT_S;
        _lastRealTs = ts;
      } else {
        dt = FIXED_DT_S;
      }
      // Защита от отрицательного/нулевого dt (повторный ts, браузерная вкладка)
      if (dt <= 0) dt = FIXED_DT_S;

      // Продвинуть виртуальное время
      _vt += dt;

      // Проверить завершение
      if (_vt >= _totalDuration) {
        _vt = _totalDuration;
        settle(true);
        return;
      }

      // Эмитировать текущее состояние
      emit(_vt);
    } finally {
      _tickActive = false;
    }

    // Перепланировать следующий кадр
    if (_useTimeoutFallback) {
      setTimeout(tick, 0);
    } else {
      const h = scheduleFrame(tick);
      if (h === 0) {
        // Non-draining convention: переходим на setTimeout-fallback
        _useTimeoutFallback = true;
        setTimeout(tick, 0);
      }
    }
  }

  /** Запустить frame loop, если ещё не запущен. */
  function ensureLoop(): void {
    if (_loopRunning || _settled || _paused) return;
    _loopRunning = true;
    const h = scheduleFrame(tick);
    if (h === 0) {
      _useTimeoutFallback = true;
      setTimeout(tick, 0);
    }
  }

  // ── Мгновенные завершения (degenerate / reduced-motion) ───────────────────

  if (_totalDuration <= 0) {
    // Нулевая суммарная длительность → немедленно завершить
    settle(true);
  } else if (reduce) {
    // Reduced-motion CHARACTER-switch: snap все сегменты к `to`, НЕ hard-off.
    // Эмитируется однократно синхронно (до ensureLoop/scheduleFrame).
    settle(true);
  }

  // ── Bootstrap frame loop (если ещё не settled) ────────────────────────────
  if (!_settled) {
    ensureLoop();
  }

  // ── Public handle ─────────────────────────────────────────────────────────
  const controls: TimelineControls = {
    get totalDuration(): number {
      return _totalDuration;
    },

    get time(): number {
      return _vt;
    },

    get progress(): number {
      if (_totalDuration <= 0) return 1;
      return Math.min(1, Math.max(0, _vt / _totalDuration));
    },

    play(): void {
      if (_settled) return;
      if (!_paused) return; // уже играет
      _paused = false;
      _lastRealTs = undefined; // сброс: первый dt после resume не должен прыгнуть
      ensureLoop();
    },

    pause(): void {
      _paused = true;
      // tick() проверит _paused и остановит loop на следующей итерации
    },

    seek(t: number): void {
      if (_settled) return;
      if (Number.isNaN(t)) return; // NaN: тихо проигнорировать
      if (t === Infinity) {
        controls.complete();
        return;
      }
      // Зажать t в [0, totalDuration]
      _vt = Math.max(0, Math.min(_totalDuration, t));
      _lastRealTs = undefined; // сброс, чтобы следующий dt не прыгнул
      emit(_vt);
    },

    complete(): void {
      if (_settled) return;
      settle(true);
    },

    cancel(): void {
      if (_settled) return;
      settle(false);
    },

    then<TResult1 = void, TResult2 = never>(
      onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return _promise.then(onfulfilled, onrejected);
    },
  };

  return controls;
}
