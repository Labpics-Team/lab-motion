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
 *   вызывается) — callback обнуляется сразу, физическая чистка массива ленивая;
 * - исключение подписчика не срывает ни соседей, ни цикл (try/catch на кадр
 *   каждого cb);
 * - ленивый старт/стоп: пустой цикл не планирует кадров вовсе.
 *
 * Планирование: инжектируемый requestFrame (детерминированные тесты) или
 * глобальный rAF/setTimeout-шим. handle=0 (non-draining тест-клок) переключает
 * на setTimeout-фоллбек; identity callback-владельца гасит дубль и stale-путь.
 * Любой синхронный host переводится в отслеживаемый async-trampoline: фазы не
 * вклиниваются в subscribe/cancelAll/teardown-транзакцию.
 *
 * SSR-safe: на импорте ничего не планируется — дефолтный синглтон `frame`
 * трогает rAF только при первой подписке.
 */

import { type RequestFrameFn } from '../motion-value.js';

export interface FrameCallbackOptions {
  /**
   * Вызваться один раз и самоотписаться. Внимание пришедшим из Motion: там
   * инверсный дефолт (однократно, повтор через keepAlive) — здесь дефолт
   * ПОВТОРЯЕТСЯ каждый кадр, потому что главный потребитель — тикающие
   * значения ядра, и repeat-по-умолчанию снимает шум с каждой подписки.
   */
  readonly once?: boolean;
  /**
   * Вызывается только глобальным cancelAll(), не обычным off(). Persistent
   * aggregate использует этот handshake, чтобы терминализировать владельцев,
   * а не удерживать мёртвые handles удалённых извне подписок.
   */
  readonly onTeardown?: (() => void) | undefined;
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
  _cb: ((ts?: number) => void) | null;
  _onTeardown: (() => void) | undefined | null;
  _once: boolean | undefined;
}

export function createFrameLoop(options?: { requestFrame?: RequestFrameFn }): FrameLoop {
  let phases: [Entry[], Entry[], Entry[]] = [[], [], []];

  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Callback-владелец reserve; `schedule` — sentinel исполняемого тика. */
  let reservation: ((ts?: number) => void) | null = null;
  /** Живые entries — O(1)-решение остановки без квадратичного off-компакта. */
  let live = 0;

  const clearFallback = (): void => {
    const timer = fallbackTimer;
    fallbackTimer = null;
    if (timer !== null) clearTimeout(timer);
  };

  const idle = (): void => {
    reservation = null;
    clearFallback();
  };

  const fallback: RequestFrameFn = (cb) =>
    (fallbackTimer = setTimeout(cb, 1000 / 60)) as unknown as number;
  // undefined резолвит поздний global rAF; fallback — демотированный host.
  let requestFrame = options?.requestFrame;

  const release = (entry: Entry): void => {
    live--;
    entry._cb = entry._onTeardown = null;
  };

  /** Единый in-place compactor запускается только вне зафиксированного тика. */
  const compact = (): void => {
    if (live === phases[0].length + phases[1].length + phases[2].length) return;
    for (const list of phases) {
      let write = 0;
      for (let read = 0; read < list.length; read++) {
        const entry = list[read]!;
        if (entry._cb) list[write++] = entry;
      }
      list.length = write;
    }
  };

  /** Один terminal снимает очередь, ссылки и teardown-владельцев. */
  const stopAll = (): void => {
    idle();
    const teardown: Array<() => void> = [];
    const owned = phases;
    phases = [[], [], []];
    for (const list of owned) {
      for (const entry of list) {
        if (entry._cb) {
          if (entry._onTeardown) teardown.push(entry._onTeardown);
          release(entry);
        }
      }
    }
    for (const terminal of teardown) {
      try { terminal(); } catch { /* teardown одного owner не блокирует остальных */ }
    }
  };

  const schedule = (): void => {
    if (reservation) return;
    let synchronous = true;
    const fire = (ts?: number): void => {
      if (reservation !== fire) return;
      if (synchronous) {
        if (fallbackTimer === null) {
          requestFrame = fallback;
          // Нарушивший rAF-фазу timestamp не переносим в новый временной домен.
          fallbackTimer = setTimeout(fire, 0);
        }
        return;
      }
      tick(fire, ts);
    };
    reservation = fire;
    let handle: number;
    try {
      const injected = requestFrame;
      const native = (globalThis as { requestAnimationFrame?: RequestFrameFn })
        .requestAnimationFrame;
      // Injected clock остаётся receiver-free; native rAF получает
      // Window receiver без доверия к подменному own `.call` host-функции.
      handle = injected
        ? injected(fire)
        : native
          ? Reflect.apply(native, globalThis, [fire])
          : fallback(fire);
    } catch (error) {
      // Host-планировщик не должен навечно оставлять цикл не-idle:
      // следующая валидная подписка обязана снова запустить цикл.
      if (reservation === fire) idle();
      throw error;
    }
    synchronous = false;
    if (!handle && reservation === fire && fallbackTimer === null) {
      // Non-draining тест-клок: колбэк из requestFrame может не прийти никогда
      // (а если придёт — callback identity погасит stale-доставку).
      requestFrame = fallback;
      fallbackTimer = setTimeout(fire, 0);
    }
  };

  const recover = (): void => {
    // Ошибка stale host не владеет уже зарезервированным fresh-кадром:
    // проверка обязана предшествовать подмене clock, иначе следующий тик
    // незаметно уйдёт с инжектированного времени на fallback.
    if (reservation) return;
    requestFrame = fallback;
    try { schedule(); } catch { stopAll(); }
  };

  const runPhase = (list: Entry[], end: number, ts?: number): void => {
    for (let i = 0; i < end; i++) {
      const entry = list[i]!;
      const cb = entry._cb;
      if (!cb) continue;
      if (entry._once) release(entry);
      try { cb(ts); } catch { /* подписчик не блокирует соседей */ }
    }
  };

  const tick = (owner: (ts?: number) => void, ts?: number): void => {
    // Identity-гард покрывает поздний дрейн и повтор одного host callback.
    if (reservation !== owner) return;
    clearFallback();
    reservation = schedule;

    // Границы всех фаз фиксируются ДО callback-ов: добавленное в тике ждёт
    // следующего кадра без трёх slice-аллокаций. null-callback даёт немедленный off.
    // Ссылки тоже фиксированы: cancelAll внутри read/update заменяет массивы
    // фаз. Старые entries уже помечены dead и безопасно дочитываются, тогда как
    // обращение к новым пустым массивам по старой границе дало бы OOB.
    const batch = phases;
    const end1 = batch[1].length;
    const end2 = batch[2].length;
    runPhase(batch[0], batch[0].length, ts);
    runPhase(batch[1], end1, ts);
    runPhase(batch[2], end2, ts);

    if (reservation === schedule) reservation = null;
    compact();
    if (live) {
      try {
        schedule();
      } catch {
        // У async-reschedule нет caller, которому можно отдать ошибку host:
        // один раз демотируемся, затем терминализируем недоступный clock.
        recover();
      }
    } else {
      idle();
    }
  };

  const subscribe = (
    phase: 0 | 1 | 2,
    cb: (ts?: number) => void,
    options?: FrameCallbackOptions,
  ): (() => void) => {
    const entry: Entry = {
      _cb: cb,
      _once: options?.once,
      _onTeardown: options?.onTeardown,
    };
    live++;
    const list = phases[phase];
    list.push(entry);
    try {
      schedule();
    } catch (error) {
      // Создатель юнита ещё не получил off-handle: откатываем его
      // последнюю запись, чтобы брошенная подписка не ожила позже.
      if (entry._cb) release(entry);
      // Реентрантная подписка могла присоединиться к ещё не закоммиченной
      // host-заявке; ошибка внешнего юнита не должна лишать её собственного кадра.
      compact();
      if (live) recover();
      throw error;
    }
    return () => {
      if (!entry._cb) return;
      release(entry);
      // Внутри tick только tombstone сохраняет его зафиксированные индексы;
      // снаружи terminal обязан сразу разорвать callback/DOM и pending reservation.
      if (reservation !== schedule && !live) {
        compact();
        idle();
      }
    };
  };

  return {
    read: (cb, o) => subscribe(0, cb, o),
    update: (cb, o) => subscribe(1, cb, o),
    render: (cb, o) => subscribe(2, cb, o),
    cancelAll: stopAll,
  };
}

/**
 * Дефолтный общий цикл пакета. Создание ничего не планирует (ленивый старт) —
 * импорт SSR-safe; rAF затрагивается только первой подпиской.
 */
export const frame: FrameLoop = createFrameLoop();

/**
 * Адаптер к шву инъекции ядра: превращает цикл в RequestFrameFn, сажая
 * MotionValue/drive/driver на ОДИН общий кадр (закрывает D11: N живых
 * значений = один rAF, не N). Зависимость инвертирована: ядро про ./frame
 * не знает — адаптер входит через существующий opts.requestFrame.
 *
 * Заявка = once-подписка фазы update: ядро перезаявляется из собственного
 * тика, и батч-семантика цикла (заявка из тика → следующий кадр)
 * воспроизводит семантику нативного rAF один-в-один. Handle всегда
 * ненулевой: 0 по контракту ядра означает non-draining тест-клок и включил
 * бы параллельный setTimeout-путь (класс двойного цикла — Finding 3).
 *
 * Дисциплина фаз: тики значений (и, значит, onChange-эмиты) исполняются в
 * фазе update — потребитель, пишущий DOM синхронно из onChange, пишет в
 * update, не в render. Нужна строгая read→update→render запись — буферизуй
 * значение в onChange и пиши из своей render-подписки этого же цикла.
 */
export function asRequestFrame(loop: FrameLoop = frame): RequestFrameFn {
  return (cb) => {
    loop.update(cb, { once: true });
    return 1;
  };
}
