/** Общий конструктор ошибок и машинные причины всех уровней API. */

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** Стабильный машинный код ошибки параметров. */
export type MotionParamErrorCode = `LM${Digit}${Digit}${Digit}`;

const MOTION_PARAM_ERROR_CODE = /^LM\d{3}$/;

/** Последний непрерывный код каталога; contract-тест сверяет его с docs/errors.md. */
export const LAST_MOTION_PARAM_ERROR_CODE: MotionParamErrorCode = 'LM214';

/** Thrown when caller-supplied physics parameters are invalid (invariant 2). */
export class MotionParamError extends Error {
  override readonly name: string = 'MotionParamError';
  declare readonly code: MotionParamErrorCode;

  /**
   * Старый строковый конструктор остаётся совместимым. Внутренние границы
   * передают только статический код; причины и исправления живут в каталоге.
   */
  constructor(messageOrCode: string) {
    super(messageOrCode);
    this.code = messageOrCode <= LAST_MOTION_PARAM_ERROR_CODE && MOTION_PARAM_ERROR_CODE.test(messageOrCode)
      ? messageOrCode as MotionParamErrorCode : 'LM000';
  }
}

/** Совместимое имя ошибки высокоуровневого API; классификация принадлежит базе. */
export class MotionError extends MotionParamError {
  override readonly name = 'MotionError';
}
