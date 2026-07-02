/**
 * frame/index.ts — единый frame-шедулер (subpath ./frame, S21).
 *
 * Закрывает D11-гэп «shared rAF frameloop»: сейчас каждый MotionValue/drive
 * планирует собственный rAF — N живых значений стоят N колбэков на кадр.
 * Один цикл = один rAF на кадр и батч всех подписчиков.
 *
 * Фазы read → update → render (канон Motion frame / gsap.ticker): измерения
 * DOM, затем вычисления, затем записи — исключает layout-thrash по построению.
 *
 * Семантика кадра:
 * - батч кадра фиксируется на входе в тик: add во время тика исполняется со
 *   СЛЕДУЮЩЕГО кадра (детерминизм: кадр не видит собственных порождений);
 * - отписка действует немедленно (сосед, снятый в тике, в этом кадре уже не
 *   вызывается) — записи гасятся флагом alive, чистка ленивая;
 * - исключение подписчика не срывает ни соседей, ни цикл (try/catch на кадр
 *   каждого cb);
 * - ленивый старт/стоп: пустой цикл не планирует кадров вовсе.
 *
 * Планирование: инжектируемый requestFrame (детерминированные тесты) или
 * глобальный rAF/setTimeout-шим. handle=0 (non-draining тест-клок) переключает
 * на setTimeout-фоллбек; токен кадра гасит возможный дубль тика от уже
 * заклоненного пути (класс двойного цикла — Finding 3 ядра — закрыт
 * конструктивно, а не пост-фактум).
 *
 * SSR-safe: на импорте ничего не планируется — дефолтный синглтон `frame`
 * трогает rAF только при первой подписке.
 */

import { type RequestFrameFn } from '../motion-value.js';

/** Фиксированный шаг фоллбека (сек) — тот же, что в ядре. */
const FIXED_DT_S = 1 / 60;

export interface FrameCallbackOptions {
  /**
   * Вызваться один раз и самоотписаться. Внимание пришедшим из Motion: там
   * инверсный дефолт (однократно, повтор через keepAlive) — здесь дефолт
   * ПОВТОРЯЕТСЯ каждый кадр, потому что главный потребитель — тикающие
   * значения ядра, и repeat-по-умолчанию снимает шум с каждой подписки.
   */
  readonly once?: boolean;
}

/** Единый цикл кадров с фазами против layout-thrash. */
export interface FrameLoop {
  /** Фаза 1: измерения DOM. Возвращает отписку (идемпотентна). */
  read(cb: (ts?: number) => void, options?: FrameCallbackOptions): () => void;
  /** Фаза 2: вычисления (физика/состояние). */
  update(cb: (ts?: number) => void, options?: FrameCallbackOptions): () => void;
  /** Фаза 3: записи в DOM. */
  render(cb: (ts?: number) => void, options?: FrameCallbackOptions): () => void;
  /**
   * Снять все подписки всех фаз и остановить цикл. Это TEARDOWN владельца
   * цикла, не отписка одного потребителя: на разделяемом синглтоне `frame`
   * гасит подписки ВСЕХ субпутей — для точечной отписки держите off()-хендл
   * своей подписки.
   */
  cancelAll(): void;
}

interface Entry {
  readonly cb: (ts?: number) => void;
  readonly once: boolean;
  alive: boolean;
}

export function createFrameLoop(options?: { requestFrame?: RequestFrameFn }): FrameLoop {
  const phases: [Entry[], Entry[], Entry[]] = [[], [], []];

  let scheduled = false;
  let useTimeoutFallback = false;
  /** Токен планирования: тик чужого токена — no-op (гард двойного цикла). */
  let token = 0;

  const defaultRequestFrame: RequestFrameFn = (cb) =>
    typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame(cb)
      : (setTimeout(cb, FIXED_DT_S * 1000) as unknown as number);
  const requestFrame = options?.requestFrame ?? defaultRequestFrame;

  // После ленивой чистки в конце тика «есть живые» ≡ «списки непусты»:
  // одна механика вместо двух дублирующих (alive-скан пинался бы только в
  // связке с чисткой — coupled-мутант), и чистка становится несущей.
  const hasLive = (): boolean => phases.some((list) => list.length > 0);

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    const myToken = ++token;
    const fire = (ts?: number): void => tick(myToken, ts);
    if (useTimeoutFallback) {
      setTimeout(fire, FIXED_DT_S * 1000);
      return;
    }
    const handle = requestFrame(fire);
    if (handle === 0) {
      // Non-draining тест-клок: колбэк из requestFrame может не прийти никогда
      // (а если придёт — его погасит токен следующего планирования).
      useTimeoutFallback = true;
      setTimeout(fire, 0);
    }
  };

  const tick = (myToken: number, ts?: number): void => {
    // Токен-гард покрывает и поздний дрейн, и двойной вызов одного колбэка:
    // каждый schedule инкрементит токен, чужой/повторный тик гаснет здесь.
    // Отдельная scheduled-защёлка была бы мёртвым дублем (эквивалентный
    // мутант) — scheduled остаётся только флагом «не планируй дважды».
    if (myToken !== token) return;
    scheduled = false;

    // Батч кадра: снимки всех фаз ДО исполнения — add в тике ждёт следующего.
    const snapshots = phases.map((list) => list.slice());
    for (const snapshot of snapshots) {
      for (const entry of snapshot) {
        if (!entry.alive) continue; // отписан в этом же кадре — не вызывать
        if (entry.once) entry.alive = false;
        try {
          entry.cb(ts);
        } catch {
          // Подписчик не имеет права срывать кадр соседям и убивать цикл.
        }
      }
    }

    // Ленивая чистка мёртвых записей (не в снапшоте — в живых списках).
    for (let i = 0; i < phases.length; i++) {
      if (phases[i]!.some((e) => !e.alive)) {
        phases[i] = phases[i]!.filter((e) => e.alive) as Entry[];
      }
    }

    if (hasLive()) schedule();
  };

  const subscribe = (
    phase: 0 | 1 | 2,
    cb: (ts?: number) => void,
    options?: FrameCallbackOptions,
  ): (() => void) => {
    const entry: Entry = { cb, once: options?.once === true, alive: true };
    phases[phase].push(entry);
    schedule();
    return () => {
      entry.alive = false;
    };
  };

  return {
    read: (cb, o) => subscribe(0, cb, o),
    update: (cb, o) => subscribe(1, cb, o),
    render: (cb, o) => subscribe(2, cb, o),
    cancelAll(): void {
      for (const list of phases) for (const e of list) e.alive = false;
      phases[0] = [];
      phases[1] = [];
      phases[2] = [];
    },
  };
}

/**
 * Дефолтный общий цикл пакета. Создание ничего не планирует (ленивый старт) —
 * импорт SSR-safe; rAF затрагивается только первой подпиской.
 */
export const frame: FrameLoop = createFrameLoop();
