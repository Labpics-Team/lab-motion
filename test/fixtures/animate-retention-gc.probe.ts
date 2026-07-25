/**
 * animate-retention-gc.probe.ts — удержанный AnimateControls не должен держать
 * ЦЕЛЬ после завершения прогона.
 *
 * СЦЕНАРИЙ ПОТРЕБИТЕЛЯ. Реестр контролов ради последующего cancel() —
 * стандартная практика в SPA и списках:
 *
 *   registry.set(id, animate(el, { x: 100 }));   // контрол живёт дольше кадра
 *
 * После естественного финиша (или cancel()) юнит остаётся в замыкании
 * `animate()`, потому что его держат методы возвращённых controls. Значит
 * освободить ЦЕЛЬ обязан сам юнит — иначе каждый завершившийся прогон
 * пришпиливает свой DOM-узел вместе со всем detached-поддеревом.
 *
 * Аудит 2026-07-25 нашёл, что compositor-ветка (WaapiUnit, дефолт для
 * spring + transform/opacity в браузере) этого не делала: MainUnit._finish
 * обнуляет `_o`, а WaapiUnit._finish — нет.
 *
 * Проба гоняет ОБЕ ветки и оба способа завершения. Запускается под
 * `node --expose-gc` из test/animate-retention-gc.test.ts.
 */

import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { animate } from '../../src/animate/index.js';
import { createWaapiDouble } from '../support/waapi-double.js';

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.equal(typeof forceGc, 'function');

const SPRING = { mass: 1, stiffness: 170, damping: 26 } as const;

/**
 * Цель прогона. Для compositor-ветки берётся ОБЩИЙ spec-faithful двойник WAAPI
 * (test/support/waapi-double.ts, сверенный с настоящими движками), потому что
 * естественный финиш здесь приходит из `onfinish` анимации, а не из кадра.
 */
function makeTarget(compositor: boolean): {
  el: Record<string, unknown>;
  advance?: (ms: number) => void;
} {
  // Балласт делает удержание видимым и в heapUsed, а не только в WeakRef:
  // имитирует detached-поддерево реального узла.
  const ballast = Array.from({ length: 20_000 }, (_, i) => ({ i }));
  if (compositor) {
    const double = createWaapiDouble();
    (double.el as unknown as Record<string, unknown>)['ballast'] = ballast;
    return {
      el: double.el as unknown as Record<string, unknown>,
      advance: (ms) => double.advance(ms),
    };
  }
  const inline = new Map<string, string>();
  return {
    el: {
      ballast,
      style: {
        setProperty(name: string, value: string): void { inline.set(name, value); },
        getPropertyValue(name: string): string { return inline.get(name) ?? ''; },
      },
    },
  };
}

/** Один прогон: вернуть WeakRef на цель, удержав controls в «реестре». */
const registry: unknown[] = [];
const settlement: { name: string; done: () => boolean }[] = [];
function run(compositor: boolean, cancelIt: boolean): WeakRef<object> {
  let made: ReturnType<typeof makeTarget> | undefined = makeTarget(compositor);
  const weak = new WeakRef(made.el as object);
  const queue: Array<(ts?: number) => void> = [];
  // Compositor-ветка узнаёт о конце прогона таймером: без ручного таймера
  // прогон просто НЕ завершается, и удержание цели было бы законным.
  const timers: Array<{ cb: () => void; cancelled: boolean }> = [];
  const controls = animate(made.el as never, { x: 100 }, {
    spring: SPRING,
    requestFrame: (cb: (ts?: number) => void) => queue.push(cb),
    setTimer: (cb: () => void) => {
      const rec = { cb, cancelled: false };
      timers.push(rec);
      return () => { rec.cancelled = true; };
    },
    now: () => 0,
    matchMedia: (() => ({ matches: false })) as never,
  });
  if (cancelIt) {
    controls.cancel();
  } else {
    // Естественное завершение: compositor — по onfinish двойника, main — кадрами.
    made.advance?.(60_000);
    for (const t of timers) if (!t.cancelled) t.cb();
    for (let i = 0; i < 4000 && queue.length > 0; i++) {
      try { queue.shift()!(); } catch { /* колбэки хоста */ }
    }
  }
  // Прогон ОБЯЗАН завершиться: удержание живой анимацией было бы законным,
  // и проба без этой проверки могла бы «пройти» на незавершённом юните.
  let resolved = false;
  void controls.finished.then(() => { resolved = true; });
  settlement.push({ name: `${compositor ? 'compositor' : 'main'} ${cancelIt ? 'cancel' : 'natural'}`, done: () => resolved });
  registry.push(controls); // контрол ЖИВЁТ — как в реальном приложении
  made = undefined;
  return weak;
}

const cases: [name: string, weak: WeakRef<object>][] = [
  ['compositor natural', run(true, false)],
  ['compositor cancel', run(true, true)],
  ['main natural', run(false, false)],
  ['main cancel', run(false, true)],
];

for (let i = 0; i < 50; i++) {
  await setImmediate();
  forceGc!();
}

const unfinished = settlement.filter((s) => !s.done()).map((s) => s.name);
assert.deepEqual(unfinished, [], `прогон не завершился: ${unfinished.join(', ')}`);
const held = cases.filter(([, weak]) => weak.deref() !== undefined).map(([name]) => name);
assert.equal(registry.length, 4);
assert.deepEqual(held, [], `цель удержана после завершения: ${held.join(', ')}`);
console.log('animate-retention: PASS');
