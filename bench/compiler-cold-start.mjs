/**
 * Диагностический бенч компиляторного среза (#208) против собранного dist.
 *
 * Меряет РАНТАЙМОВУЮ работу, которую build-time lowering убирает: nano.animate
 * пересчитывает springLinear() (замкнутая форма + ~118 узлов linear()) на
 * КАЖДЫЙ вызов; animateCompiled читает precomputed-литерал и сразу зовёт WAAPI.
 * element.animate заглушён (одинаков для обоих путей) — изолируем именно
 * элиминированное вычисление. Это НЕ CI-гейт (структурную элиминацию из бандла
 * запечатывают scripts/compiler-acceptance.mjs и browser/17-compiler-nano);
 * тут — воспроизводимая величина per-call выигрыша, публикуемая как факт.
 */

import { performance } from 'node:perf_hooks';

// Минимальный DOM-шов: element.animate одинаков для обоих путей, поэтому его
// стоимость в дельту не входит. finished-Promise никогда не резолвится — бенч
// меряет синхронную стоимость вызова, не ждёт завершения.
const fakeAnimation = () => ({
  finished: Promise.resolve(),
  addEventListener() {},
  commitStyles() {},
  cancel() {},
});
let sink = 0;
function fakeElement() {
  return {
    animate(frame, options) {
      sink += options.duration + (options.easing ? options.easing.length : 0);
      return fakeAnimation();
    },
  };
}
globalThis.matchMedia = () => ({ matches: false });

const { animate } = await import('../dist/nano/index.js');
const { animateCompiled } = await import('../dist/compiler/runtime/index.js');

// Артефакт, который инъектирует компилятор, — ровно то, что nano вычисляет в
// рантайме: снимаем duration/easing одним прогоном uncompiled через шов.
let captured;
animate(
  { animate(frame, options) { captured = options; return fakeAnimation(); } },
  { opacity: 0.5 },
);
const ARTIFACT = { o: 0.5, d: captured.duration, e: captured.easing };

function median(values) {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

function measure(label, run, iterations, samples = 9) {
  for (let i = 0; i < Math.min(iterations, 50); i++) sink += run(i);
  const values = [];
  for (let sample = 0; sample < samples; sample++) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) sink += run(i);
    values.push(((performance.now() - started) * 1e6) / iterations);
  }
  return median(values);
}

const element = fakeElement();
const uncompiled = measure(
  'nano.animate (springLinear рантайм)',
  () => animate(element, { opacity: 0.5 }).length,
  50_000,
);
const compiled = measure(
  'animateCompiled (precomputed)',
  () => animateCompiled(element, ARTIFACT).length,
  50_000,
);

console.log(`nano.animate (springLinear рантайм)   ${uncompiled.toFixed(1).padStart(9)} ns/op`);
console.log(`animateCompiled (precomputed)         ${compiled.toFixed(1).padStart(9)} ns/op`);
console.log(
  `per-call выигрыш lowering              ${(uncompiled - compiled).toFixed(1).padStart(9)} ns/op ` +
  `(×${(uncompiled / compiled).toFixed(1)})`,
);
console.log(`sink=${Number.isFinite(sink) ? 'ok' : 'NaN'}`);
