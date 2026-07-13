/**
 * compositor/handoff.ts — C¹-хендофф compositor→live (subpath ./compositor).
 *
 * Мост из compositor-трека (WAAPI, off-main-thread) в ЖИВУЮ rAF-пружину
 * (MotionValue, main-thread) без разрыва позиции И скорости. Нужен, когда
 * будущая траектория ПЕРЕСТАЁТ быть автономной (палец перехватил значение,
 * follow-фаза жеста) — фазовая модель ./compositor: follow живёт на main-потоке.
 *
 * Механизм (заземлён M1 «непрерывность C¹»): владелец compositor снимает
 * состояние (value, velocity) из фактических serialized stops по native time,
 * НЕ через getComputedStyle-семплинг (тот форсил бы синхронный recalc, побеждая
 * compositor). Live-пружина РОЖДАЕТСЯ в этой точке
 * (MotionValue.initialVelocity), и первый setTarget() подхватывает скорость
 * штатным smooth-pickup (тот же solveSpring с произвольным v0) → хвост
 * траектории воспроизводится тем же ядром бит-в-бит. Ни позиция, ни скорость не
 * имеют разрыва.
 *
 * Владение: возвращается MotionValue — ПОЛНОЦЕННЫЙ live-контроллер (setTarget /
 * stop / destroy / value). После хендоффа значением управляет вызывающий: это и
 * есть «отпустить в live». Чистая функция уровня состояния (не трогает DOM):
 * (value, velocity) приходят снаружи (обычно из execution-снимка), поэтому нет
 * зависимости от index.ts и цикла импорта.
 */

import { MotionValue, type RequestFrameFn } from '../motion-value.js';
import { validateSpringParams, type SpringParams } from '../spring.js';
import { MotionParamError } from '../errors.js';

/** Опции хендоффа compositor→live. */
export interface HandoffToLiveOptions {
  readonly spring: SpringParams;
  /** Позиция в момент хендоффа (обычно значение execution-снимка). */
  readonly value: number;
  /** Скорость units/s в момент хендоффа (обычно скорость execution-снимка). */
  readonly velocity: number;
  /**
   * Цель live-пружины. Продолжить ТОТ ЖЕ переход → передайте исходный `to`
   * (тогда хвост воспроизводится точно). Новая интеракция → новая цель. По
   * умолчанию = value: при ненулевой velocity значение физически выбегает по
   * импульсу и возвращается в ту же точку, а не теряет скорость на нулевом span.
   */
  readonly target?: number;
  /** Инжектируемый requestFrame (в проде requestAnimationFrame.bind(window)). */
  readonly requestFrame?: RequestFrameFn | undefined;
  /** Слушатель каждого кадра live-пружины. */
  readonly onChange?: ((v: number) => void) | undefined;
  /**
   * Клэмп значений в [from, target]. По умолчанию false — честная пружина
   * (overshoot эмитится), паритет с compositor-кривой linear() (несёт overshoot).
   */
  readonly clamp?: boolean | undefined;
}

/**
 * Строит live rAF-пружину (MotionValue), продолжающую движение с (value,
 * velocity) к target без разрыва C¹. Возвращает MotionValue — им и управляет
 * вызывающий дальше (setTarget для нового ретаргета, stop/destroy для уборки).
 */
export function handoffToLive(opts: HandoffToLiveOptions): MotionValue {
  validateSpringParams(opts.spring);
  const target = opts.target ?? opts.value;
  if (!Number.isFinite(opts.value) || !Number.isFinite(opts.velocity) || !Number.isFinite(target)) {
    throw new MotionParamError('LM015');
  }

  const mv = new MotionValue({
    initial: opts.value,
    initialVelocity: opts.velocity,
    spring: opts.spring,
    clamp: opts.clamp ?? false,
    requestFrame: opts.requestFrame,
  });
  if (opts.onChange !== undefined) mv.onChange(opts.onChange);
  // Первый setTarget подхватывает засеянную скорость (C¹) через smooth-pickup.
  mv.setTarget(target);
  return mv;
}
