import { expect, test } from './fixtures/harness';

// Решение x'' + 20x' + 100(x − target) = 0 не использует солвер пакета.
function criticalPosition(from: number, to: number, velocity: number, seconds: number): number {
  const displacement = from - to;
  return to + (displacement + (velocity + 10 * displacement) * seconds) * Math.exp(-10 * seconds);
}

// Бюджет компиляции 1/400 прогресса, ×2 на реконструкцию и 0.1px на matrix().
const reconstructionBudget = (amplitude: number): number => 2 * amplitude / 400 + 0.1;

for (const firstMs of [40, 120, 260]) {
  for (const tweenMs of [40, 160, 280]) {
    test(`независимый контракт native→JS→native: ${firstMs}/${tweenMs} мс`, async ({ page }) => {
      const result = await page.evaluate(async ({ firstMs, tweenMs }) => {
        const { animate } = await import('/dist/animate/index.js');
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;width:10px;height:10px;transform:translateX(0px)';
        document.body.appendChild(el);
        const hostAnimate = el.animate.bind(el);
        let effectCreations = 0;
        el.animate = (...args: Parameters<Element['animate']>) => {
          effectCreations++;
          return hostAnimate(...args);
        };
        const read = () => new DOMMatrixReadOnly(getComputedStyle(el).transform).e;
        const callbacks: Array<(ts?: number) => void> = [];
        const timers: Array<{ callback: () => void; cancelCalls: number }> = [];
        let completed = 0;
        const common = {
          matchMedia: () => ({ matches: false }),
          onComplete: () => { completed++; },
        };
        const nativeOptions = {
          ...common,
          spring: { mass: 1, stiffness: 100, damping: 20 },
          now: () => 0,
          setTimer: (callback: () => void) => {
            const timer = { callback, cancelCalls: 0 };
            timers.push(timer);
            return () => { timer.cancelCalls++; };
          },
        };
        const first = animate(el, { x: [0, 200] }, nativeOptions);
        const counts = [el.getAnimations().length];
        const initialEffect = el.getAnimations()[0]!;
        initialEffect.pause();
        initialEffect.currentTime = firstMs;
        const beforeMain = read();

        const middle = animate(el, { x: 300 }, {
          ...common,
          duration: 400,
          ease: (t: number) => t,
          requestFrame: (callback) => callbacks.push(callback),
        });
        const mainImmediate = read();
        middle.pause();
        middle.seek(0);
        counts.push(el.getAnimations().length);
        const mainStart = read();
        middle.seek(tweenMs);
        const mainEnd = read();

        const last = animate(el, { x: 450 }, nativeOptions);
        const nativeImmediate = read();
        counts.push(el.getAnimations().length);
        const finalEffect = el.getAnimations()[0]!;
        finalEffect.pause();
        finalEffect.currentTime = 0;
        const nativeStart = read();
        const samples = [0, 100, 200].map((ms) => {
          finalEffect.currentTime = ms;
          return { ms, x: read() };
        });

        // Терминальные владельцы и уже поставленные callbacks не воскресают.
        const beforeStale = read();
        const ownedState = () => ({
          x: read(),
          inlineStyle: el.getAttribute('style'),
          scheduledCallbacks: callbacks.length,
          timers: timers.map(({ cancelCalls }) => cancelCalls),
          effectCreations,
          effects: el.getAnimations().map((effect) => ({
            sameEffect: effect === finalEffect,
            currentTime: effect.currentTime,
            startTime: effect.startTime,
            playbackRate: effect.playbackRate,
            playState: effect.playState,
            pending: effect.pending,
            timing: effect.effect!.getTiming(),
            keyframes: (effect.effect as KeyframeEffect).getKeyframes(),
          })),
        });
        const ownedBeforeStale = ownedState();
        const staleStates: ReturnType<typeof ownedState>[] = [];
        const observeStale = () => staleStates.push(ownedState());
        for (const stale of [first, middle]) {
          stale.play();
          observeStale();
          stale.seek(300);
          observeStale();
          stale.cancel();
          observeStale();
        }
        for (const callback of [...callbacks]) {
          callback(10_000);
          observeStale();
        }
        // Отменённый таймер мог уже попасть в очередь браузера до отмены.
        for (const timer of timers.filter(({ cancelCalls }) => cancelCalls > 0)) {
          timer.callback();
          observeStale();
        }
        const afterStale = read();
        const sameEffect = el.getAnimations().length === 1 && el.getAnimations()[0] === finalEffect;
        last.cancel();
        counts.push(el.getAnimations().length);
        const cancelled = read();
        const ownedAfterCancel = ownedState();
        const cancelledStates: ReturnType<typeof ownedState>[] = [];
        for (const callback of [...callbacks]) {
          callback(20_000);
          cancelledStates.push(ownedState());
        }
        for (const timer of [...timers]) {
          timer.callback();
          cancelledStates.push(ownedState());
        }
        const afterCancel = read();
        await Promise.all([first.finished, middle.finished, last.finished]);
        el.remove();
        return {
          beforeMain, mainImmediate, mainStart, mainEnd, nativeImmediate, nativeStart, samples,
          counts, completed, beforeStale, afterStale, sameEffect, cancelled, afterCancel,
          staleStates, cancelledStates, effectCreations, ownedBeforeStale, ownedAfterCancel,
        };
      }, { firstMs, tweenMs });

      const handoff = criticalPosition(0, 200, 0, firstMs / 1000);
      const firstBudget = reconstructionBudget(200);
      const fraction = tweenMs / 400;
      const tweenEnd = handoff + (300 - handoff) * fraction;
      const velocity = (300 - handoff) / 0.4;
      const tweenBudget = (1 - fraction) * firstBudget + 0.1;
      const velocityBudget = firstBudget / 0.4;
      const lastBudget = reconstructionBudget(Math.abs(450 - tweenEnd) + tweenBudget);

      expect(Math.abs(result.beforeMain - handoff)).toBeLessThanOrEqual(firstBudget);
      expect(Math.abs(result.mainStart - handoff)).toBeLessThanOrEqual(firstBudget);
      expect(Math.abs(result.mainImmediate - result.beforeMain)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(result.mainStart - result.beforeMain)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(result.mainEnd - tweenEnd)).toBeLessThanOrEqual(tweenBudget);
      expect(Math.abs(result.nativeStart - result.mainEnd)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(result.nativeImmediate - result.mainEnd)).toBeLessThanOrEqual(0.05);
      for (const sample of result.samples) {
        const seconds = sample.ms / 1000;
        const decay = Math.exp(-10 * seconds);
        const budget = tweenBudget * (1 + 10 * seconds) * decay + velocityBudget * seconds * decay + lastBudget;
        const expected = criticalPosition(tweenEnd, 450, velocity, seconds);
        expect(Math.abs(sample.x - expected), `t=${sample.ms}, x=${sample.x}, expected=${expected}, budget=${budget}`)
          .toBeLessThanOrEqual(budget);
        if (sample.ms > 0) {
          // Контрпример v=0 обязан отличаться сильнее допуска: тест чувствителен к потере скорости.
          const resetVelocity = criticalPosition(tweenEnd, 450, 0, seconds);
          expect(Math.abs(expected - resetVelocity)).toBeGreaterThan(2 * budget);
        }
      }
      expect(result.counts).toEqual([1, 0, 1, 0]);
      expect(result.sameEffect).toBe(true);
      expect(result.effectCreations).toBe(2);
      expect(result.ownedBeforeStale.timers).toEqual([1, 0]);
      expect(result.ownedAfterCancel.timers).toEqual([1, 1]);
      expect(result.staleStates.length).toBeGreaterThanOrEqual(6);
      for (const state of result.staleStates) {
        expect(state).toEqual(result.ownedBeforeStale);
      }
      for (const state of result.cancelledStates) {
        expect(state).toEqual(result.ownedAfterCancel);
      }
      expect(result.afterStale).toBe(result.beforeStale);
      expect(result.afterCancel).toBe(result.cancelled);
      expect(result.completed).toBe(0);
    });
  }
}
