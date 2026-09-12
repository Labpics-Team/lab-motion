import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { animate, type AnimateControls } from '../../src/animate/index.js';

const forceGc = (globalThis as { gc?: () => void }).gc;
assert.equal(typeof forceGc, 'function', '--expose-gc обязателен');

const retained: AnimateControls[] = [];
const pending = new Set<() => void>();
const refs: Array<{ name: string; weak: WeakRef<object> }> = [];
const style = { getPropertyValue: (): string => '', setProperty(): void {} };
const timer = (cb: () => void): (() => void) => {
  const fire = (): void => { pending.delete(fire); cb(); };
  pending.add(fire);
  return (): void => { pending.delete(fire); };
};
const target = () => ({ style, animate: () => ({ currentTime: 100, cancel(): void {} }) });

type Outcome = 'cancel' | 'natural' | 'synchronous' | 'reduced';
function setup(outcome: Outcome, capture: boolean): AnimateControls {
  const el = target();
  const elements = [el, target(), target()];
  for (const [index, value] of elements.entries()) {
    refs.push({ name: `${outcome}/${capture}/${index}`, weak: new WeakRef(value) });
  }
  const onComplete = capture ? (): void => { void el.style; } : undefined;
  const controls = animate(elements, { x: [0, 100], opacity: [0, 1] }, {
    now: () => 0,
    setTimer: outcome === 'synchronous' ? (cb) => { cb(); return () => {}; } : timer,
    matchMedia: () => ({ matches: outcome === 'reduced' }),
    onComplete,
  });
  if (outcome === 'cancel') controls.cancel();
  if (outcome === 'natural') for (const fire of [...pending]) fire();
  retained.push(controls);
  return controls;
}
for (const outcome of ['cancel', 'natural', 'synchronous', 'reduced'] as const) {
  for (const capture of [false, true]) await setup(outcome, capture).finished;
}
// Главный поток использует другого владельца и отложенное опустошение rAF, но тот же
// закон завершения. Очередь стенда не должна удерживать снятый пакет.
async function setupMain(natural: boolean, capture: boolean): Promise<void> {
  const el = target();
  refs.push({ name: `main/${natural}/${capture}`, weak: new WeakRef(el) });
  let queue: Array<(ts?: number) => void> = [];
  const requestFrame = (cb: (ts?: number) => void): number => queue.push(cb);
  const controls = animate(el, { x: [0, 100] }, {
    duration: 10,
    requestFrame,
    onComplete: capture ? (): void => { void el.style; } : undefined,
  });
  retained.push(controls);
  if (!natural) controls.cancel();
  for (const time of [0, 20, 40]) {
    const current = queue;
    queue = [];
    for (const cb of current) cb(time);
  }
  await controls.finished;
  assert.equal(queue.length, 0, 'сам стенд удержал завершённые rAF');
}
for (const natural of [false, true]) {
  for (const capture of [false, true]) await setupMain(natural, capture);
}
assert.equal(pending.size, 0, 'сам стенд удержал завершённые таймеры');

// Положительный контроль: GC не должен стирать достижимую цель активного владельца.
const active = (() => {
  const el = target();
  const weak = new WeakRef(el);
  const controls = animate(el, { x: 100 }, { now: () => 0, setTimer: timer });
  controls.pause();
  return { weak, controls };
})();

async function collect(): Promise<void> {
  for (let i = 0; i < 50; i++) { await setImmediate(); forceGc!(); }
}
await collect();
assert.notEqual(active.weak.deref(), undefined, 'потерян живой paused owner');
for (const { name, weak } of refs) {
  assert.equal(weak.deref(), undefined, `terminal controls удерживают ${name}`);
}
assert.equal(retained.length, 12);
for (const controls of retained) {
  // Завершённый объект управления сохраняет API, но его методы ничего не делают.
  controls.play(); controls.pause(); controls.seek(50); controls.cancel(); controls.stop();
  await controls.finished;
}
active.controls.cancel();
await active.controls.finished;
await collect();
assert.equal(active.weak.deref(), undefined, 'отмена paused owner не сняла удержание');
assert.equal(pending.size, 0);
console.log('animate-terminal-retention: PASS');
