/**
 * qwik/index.ts — Qwik-биндинг (subpath ./qwik, S19).
 *
 * Резумабельность диктует форму: живой MotionValue НЕ сериализуем — хранится
 * как noSerialize (после резюма undefined) и пересоздаётся на клиенте в
 * useVisibleTask$. Управление — ЧЕРЕЗ СИГНАЛ target, а не через функцию:
 * сигналы сериализуемы и переживают резюм; потребитель пишет
 * `spring.target.value = 100`, драйвер-таска трекает сигнал и гонит физику.
 *
 * Две таски по ответственности: init-таска (без track) создаёт MotionValue
 * один раз и регистрирует destroy на unmount — в драйвер-таске cleanup нельзя,
 * он выполняется перед КАЖДЫМ re-run по track и убил бы физику на первой же
 * смене цели. Драйвер-таска только трекает target и передаёт его ядру.
 *
 * Reduced-motion — смена ХАРАКТЕРА: снап значения в сигнал синхронно; запись
 * в обход ядра зеркалит его валидацию (не-finite → MotionParamError).
 *
 * Шов requestFrame — client-only тестовая инъекция: функция не сериализуема,
 * через resume-границу не переносится (в SSR-приложении оставляйте дефолт).
 *
 * Mid-flight резюм: сериализуются только сигналы value/target — скорость
 * пружины несериализуема принципиально, после резюма анимация дожимает к
 * цели с нулевой начальной скоростью (перезапуск дуги, не бесшовный подхват).
 * Это ограничение резумабельности, не дефект.
 */

import {
  noSerialize,
  useSignal,
  useVisibleTask$,
  type NoSerialize,
  type Signal,
} from '@builder.io/qwik';
import { MotionValue, type MotionValueOptions } from '../motion-value.js';
import { MotionParamError } from '../errors.js';
import { type SpringParams } from '../spring.js';

const DEFAULT_SPRING: SpringParams = { mass: 1, stiffness: 200, damping: 20 };

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Ручки пружины: читаемое значение + сигнал-цель (пиши в target.value). */
export interface QwikSpring {
  /** Текущее анимированное значение (для стилей/рендера). */
  readonly value: Signal<number>;
  /** Цель: присваивание запускает анимацию. Сериализуем, переживает резюм. */
  readonly target: Signal<number>;
}

/**
 * Числовое значение, анимируемое пружиной к `target.value`.
 *
 * @example
 * ```tsx
 * const x = useSpring(0, { mass: 1, stiffness: 300, damping: 30 });
 * <div style={{ transform: `translateX(${x.value.value}px)` }}
 *      onClick$={() => { x.target.value = 100; }} />
 * ```
 */
export function useSpring(
  initial: number,
  spring: SpringParams = DEFAULT_SPRING,
  reducedMotionMode: 'instant' | 'fade' = 'instant',
  requestFrame?: MotionValueOptions['requestFrame'],
): QwikSpring {
  const value = useSignal(initial);
  const target = useSignal(initial);
  const mvRef = useSignal<NoSerialize<MotionValue>>();

  // Init: один раз на клиенте (после резюма mvRef пуст — пересоздание).
  // Cleanup ЗДЕСЬ: таска без track не перезапускается — destroy только unmount.
  useVisibleTask$(({ cleanup }) => {
    // Гард от двойного прогона init-таски. При канонической семантике Qwik
    // (cleanup перед каждым re-run) он поведенчески эквивалентен безусловной
    // ветке (эквивалентный мутант) — оставлен как защита от неопределённого
    // re-visible поведения стратегий intersection-observer.
    if (mvRef.value === undefined) {
      const mv = new MotionValue({
        initial: value.value,
        spring,
        requestFrame,
      });
      mv.onChange((v) => {
        value.value = v;
      });
      mvRef.value = noSerialize(mv);
    }
    cleanup(() => {
      mvRef.value?.destroy();
      mvRef.value = undefined; // гейт для reduced-записей после unmount
    });
  });

  // Драйвер: трекает цель, передаёт ядру (или снапает при reduced).
  useVisibleTask$(({ track }) => {
    const t = track(() => target.value);
    const mv = mvRef.value;
    if (mv === undefined) return; // до init/после unmount — запись не проходит
    if (t === value.value) return; // первый прогон и эхо собственного снапа
    if (prefersReducedMotion()) {
      // Снап пишет в сигнал в обход ядра — валидация зеркалит mv.setTarget.
      if (!Number.isFinite(t)) {
        throw new MotionParamError(`useSpring: target должен быть конечным, получено ${t}`);
      }
      value.value = t; // характер: снап ('fade' — CSS потребителя)
      void reducedMotionMode;
    } else {
      mv.setTarget(t);
    }
  });

  return { value, target };
}
