import { STOPPED } from './model.js';
import type { Playback } from './types.js';

/** Отмена до запуска не создаёт Run, целей или кадровых ресурсов. */
export const stoppedMotion: Playback = /* @__PURE__ */ Object.freeze({
  state: 'stopped', duration: 0, finished: Promise.resolve(STOPPED),
  pause() {}, play() {}, seek() {}, stop() {}, finish() {},
});
/** Мутация остаётся отдельной способностью даже после освобождения области. */
export const stoppedLayout: Playback = /* @__PURE__ */ Object.freeze({ ...stoppedMotion });
