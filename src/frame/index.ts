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
  readonly _cb: (ts?: number) => void;
  readonly _once: boolean;
  readonly _onTeardown: (() => void) | undefined;
  _alive: boolean;
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

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    const myToken = ++token;
    const fire = (ts?: number): void => tick(myToken, ts);
    if (useTimeoutFallback) {
      setTimeout(fire, FIXED_DT_S * 1000);
      return;
    }
    let handle: number;
    try {
      handle = requestFrame(fire);
    } catch (error) {
      // Host-планировщик не должен навечно оставлять scheduled=true:
      // следующая валидная подписка обязана снова запустить цикл.
      if (myToken === token) scheduled = false;
      throw error;
    }
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

    // Границы всех фаз фиксируются ДО callback-ов: добавленное в тике ждёт
    // следующего кадра без трёх slice-аллокаций. alive сохраняет немедленную отписку.
    // Ссылки тоже фиксированы: cancelAll внутри read/update заменяет массивы
    // фаз. Старые entries уже помечены dead и безопасно дочитываются, тогда как
    // обращение к новым пустым массивам по старой границе дало бы OOB.
    const list0 = phases[0];
    const list1 = phases[1];
    const list2 = phases[2];
    const end0 = list0.length;
    const end1 = list1.length;
    const end2 = list2.length;
    for (let phase = 0; phase < phases.length; phase++) {
      const list = phase === 0 ? list0 : phase === 1 ? list1 : list2;
      const end = phase === 0 ? end0 : phase === 1 ? end1 : end2;
      for (let i = 0; i < end; i++) {
        const entry = list[i]!;
        if (!entry._alive) continue; // отписан в этом же кадре — не вызывать
        if (entry._once) entry._alive = false;
        try {
          entry._cb(ts);
        } catch {
          // Подписчик не имеет права срывать кадр соседям и убивать цикл.
        }
      }
    }

    // In-place compaction сохраняет порядок и новые записи без filter-массива на каждом кадре.
    for (let phase = 0; phase < 3; phase++) {
      const list = phases[phase];
      let write = 0;
      for (let read = 0; read < list.length; read++) {
        const entry = list[read]!;
        if (entry._alive) list[write++] = entry;
      }
      list.length = write;
    }

    // После compaction «есть живые» ≡ «списки непусты»: отдельный alive-скан
    // дублировал бы механику, а callback для Array.some аллоцировался бы на кадре.
    if (phases[0].length + phases[1].length + phases[2].length > 0) schedule();
  };

  const subscribe = (
    phase: 0 | 1 | 2,
    cb: (ts?: number) => void,
    options?: FrameCallbackOptions,
  ): (() => void) => {
    const entry: Entry = {
      _cb: cb,
      _once: options?.once === true,
      _onTeardown: options?.onTeardown,
      _alive: true,
    };
    const list = phases[phase];
    list.push(entry);
    try {
      schedule();
    } catch (error) {
      // Создатель юнита ещё не получил off-handle: откатываем его
      // последнюю запись, чтобы брошенная подписка не ожила позже.
      entry._alive = false;
      if (list[list.length - 1] === entry) list.pop();
      throw error;
    }
    return () => {
      entry._alive = false;
    };
  };

  return {
    read: (cb, o) => subscribe(0, cb, o),
    update: (cb, o) => subscribe(1, cb, o),
    render: (cb, o) => subscribe(2, cb, o),
    cancelAll(): void {
      // Выданный host callback отменить переносимо нельзя; новый token делает
      // его инертным, а scheduled=false позволяет следующей подписке сразу
      // поставить собственный кадр вместо ожидания чужого drain.
      scheduled = false;
      token++;
      const teardown: Entry[] = [];
      for (const list of phases) {
        for (const entry of list) {
          if (!entry._alive) continue;
          entry._alive = false;
          if (entry._onTeardown !== undefined) teardown.push(entry);
        }
      }
      phases[0] = [];
      phases[1] = [];
      phases[2] = [];
      for (const entry of teardown) {
        try { entry._onTeardown!(); } catch { /* teardown одного owner не блокирует остальных */ }
      }
    },
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
