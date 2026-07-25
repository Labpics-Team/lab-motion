/**
 * errors.ts — typed domain boundary for motion engine errors.
 *
 * L1 Domain / cross-cutting. No DOM, no window, no clock.
 * Only MotionParamError is public; it is the sole error type
 * callers should catch to distinguish invalid inputs from bugs.
 */

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** Стабильный машинный код ошибки параметров. */
export type MotionParamErrorCode = `LM${Digit}${Digit}${Digit}`;

const MOTION_PARAM_ERROR_CODE = /^LM\d{3}$/;

/** Последний непрерывный код каталога; contract-тест сверяет его с docs/errors.md. */
export const LAST_MOTION_PARAM_ERROR_CODE: MotionParamErrorCode = 'LM171';

/**
 * Проверка «это ошибка параметров пакета» — рабочая ЧЕРЕЗ ГРАНИЦЫ СУБПУТЕЙ.
 *
 * Найдено аудитом 2026-07-25. Пакет собирается БЕЗ code-splitting: каждый
 * субпуть несёт собственную копию класса, поэтому `e instanceof MotionParamError`
 * в СОБРАННОМ пакете ложен ВСЕГДА, если ошибка пришла не из того же субпутя,
 * откуда импортирован класс (проверено на dist; `e.constructor.name` после
 * минификации равен 'o' — зацепиться было не за что). Восемь reference-страниц
 * учили именно паттерну с instanceof.
 *
 * Почему функция, а не `static [Symbol.hasInstance]` в классе: статический метод
 * уезжает в КАЖДЫЙ субпуть, который лишь бросает ошибку и никогда не участвует в
 * проверке (замер: +30 B gz — пробиты пороги ./utils, ./spring и behaviors).
 * Отдельная функция tree-shakeable: кто её не импортирует, не платит ничего.
 *
 * Бренд — собственное поле `name`: присваивается в конструкторе, переживает
 * минификацию и уже лежит в строковом пуле бандла. Объект с таким `name` — это
 * и есть наша ошибка из другой копии; её мы и обязаны признать своей.
 */
export function isMotionParamError(value: unknown): value is MotionParamError {
  return (value as { name?: unknown } | null)?.name === 'MotionParamError';
}

/** Thrown when caller-supplied physics parameters are invalid (invariant 2). */
export class MotionParamError extends Error {
  override readonly name = 'MotionParamError';
  declare readonly code: MotionParamErrorCode;

  /**
   * Старый строковый конструктор остаётся совместимым. Внутренние границы
   * передают только статический код; причины и исправления живут в каталоге.
   */
  constructor(messageOrCode: string) {
    super(messageOrCode);
    this.code = messageOrCode <= LAST_MOTION_PARAM_ERROR_CODE &&
      MOTION_PARAM_ERROR_CODE.test(messageOrCode)
      ? messageOrCode as MotionParamErrorCode
      : 'LM000';
  }
}
