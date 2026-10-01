/**
 * internal/binding-value.ts — MotionValue, пред-подключённый к ОБЩЕМУ кадру.
 *
 * Единый источник для всех биндингов (react/svelte/vue/…): без инжектированного
 * requestFrame значение садится на разделяемый цикл `asRequestFrame()` — один
 * rAF на ВСЕ живые значения приложения (закрывает D11 по умолчанию, как shared
 * ticker у Framer Motion / GSAP / anime.js). Инжектированный клок (тесты,
 * кастомный планировщик) выигрывает — детерминизм биндинг-тестов не затронут.
 *
 * ⚠️ ТОЛЬКО для биндингов. Ядро (index.ts и его граф) НЕ импортирует этот файл:
 * иначе ./frame втянулся бы в core-бандл и нарушил инвариант «ядро не знает про
 * ./frame» (инверсия зависимости PR #40). Связь frame появляется лишь в том
 * субпуте-биндинге, который реально импортирует хелпер.
 */

import { asRequestFrame } from '../frame/index.js';
import { MotionValue, type MotionValueOptions } from '../motion-value.js';

/** Создаёт MotionValue на общем кадре, если requestFrame не инжектирован. */
export function createBoundValue(opts: MotionValueOptions): MotionValue {
  return new MotionValue({
    ...opts,
    requestFrame: opts.requestFrame ?? asRequestFrame(),
  });
}
