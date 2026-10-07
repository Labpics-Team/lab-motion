import { expect, test } from './fixtures/harness';

test('переназначенное живое значение достигает цели к независимому сроку без оставшихся кадров', async ({ page }) => {
  const frameStepMs = 16;
  const interruptAtMs = 700;
  const target = 300;
  const minReturnFrom = 490;
  const maxReturnVelocity = 1000;

  // Для m=1,k=170,c=26 независимая оценка следует из уравнения движения:
  // отклонение z удовлетворяет z'' + 26z' + 170z = 0 (корни -13 ± i).
  // Первый release: x(t)=600-exp(-13t)(340cos(t)+3420sin(t)),
  // v(t)=exp(-13t)(1000cos(t)+44800sin(t)). При t=0.164 s получаем
  // 490 < x < 600 и 0 < v < 1000; эти предпосылки ниже проверяются на потребителе.
  // После retarget в 300: u=v/(x-300) <= 1000/190. Огибающие |z|/|z(0)|
  // и |z'|/|z(0)| ограничены exp(-13t) * hypot(1,13+u) и
  // exp(-13t) * hypot(u,170+13u). Допуски: 0.005 и 0.005/s соответственно.
  const maxNormalizedVelocity = maxReturnVelocity / (minReturnFrom - target);
  const positionBoundSec = Math.log(Math.hypot(1, 13 + maxNormalizedVelocity) / 0.005) / 13;
  const velocityBoundSec = Math.log(Math.hypot(maxNormalizedVelocity, 170 + 13 * maxNormalizedVelocity) / 0.005) / 13;
  const settleBoundMs = Math.max(positionBoundSec, velocityBoundSec) * 1000;
  // Первый callback может только закрепить timestamp. Затем нужен кадр строго
  // за границей огибающей: runtime использует строгое сравнение с порогом.
  const terminalAtMs = interruptAtMs + frameStepMs
    + (Math.floor(settleBoundMs / frameStepMs) + 1) * frameStepMs;
  expect(terminalAtMs).toBe(1548);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const result = await page.evaluate(async ({ frameStepMs, interruptAtMs, terminalAtMs }) => {
    const { MotionValue } = await import('/dist/index.js');
    let now = 520;
    let handle = 0;
    let queue: Array<(timestamp?: number) => void> = [];
    const advanceTo = (deadline: number): void => {
      while (now < deadline) {
        now = Math.min(deadline, now + frameStepMs);
        const batch = queue;
        queue = [];
        for (const callback of batch) callback(now);
      }
    };
    const motion = new MotionValue({
      initial: 260, initialVelocity: 1000, clamp: false,
      spring: { mass: 1, stiffness: 170, damping: 26 },
      requestFrame: (callback) => {
        queue.push(callback);
        return ++handle;
      },
    });
    try {
      const snapshot = () => ({ value: motion.value, velocity: motion.velocity });
      motion.setTarget(600);
      const release = snapshot();
      advanceTo(520 + frameStepMs);
      const movementBefore = snapshot();
      advanceTo(520 + frameStepMs * 2);
      const movementAfter = snapshot();
      advanceTo(interruptAtMs);
      const beforeInterrupt = snapshot();
      motion.setTarget(300);
      const afterInterrupt = snapshot();
      advanceTo(interruptAtMs + frameStepMs);
      const replacementStart = snapshot();
      advanceTo(terminalAtMs);
      return {
        release,
        movementBefore,
        movementAfter,
        beforeInterrupt,
        afterInterrupt,
        replacementStart,
        terminal: { state: snapshot(), pending: queue.length, atMs: now },
      };
    } finally {
      // Состояние и очередь сняты до cleanup; после deadline кадры не исполняются.
      motion.destroy();
    }
  }, { frameStepMs, interruptAtMs, terminalAtMs });

  expect(result.release).toMatchObject({ value: 260, velocity: 1000 });
  expect(result.movementBefore.velocity).toBeCloseTo(1000, 9);
  expect(result.movementAfter.value).toBeGreaterThan(result.movementBefore.value);
  expect(result.beforeInterrupt.value).toBeGreaterThanOrEqual(minReturnFrom);
  expect(result.beforeInterrupt.value).toBeLessThan(600);
  expect(result.beforeInterrupt.velocity).toBeGreaterThan(0);
  expect(result.beforeInterrupt.velocity).toBeLessThanOrEqual(maxReturnVelocity);
  expect(result.afterInterrupt).toMatchObject({
    value: result.beforeInterrupt.value,
    velocity: result.beforeInterrupt.velocity,
  });
  // Тот же clock продвигает новую траекторию уже на первом кадре после retarget.
  // Решение z'' + 26z' + 170z = 0 проверяет и позицию, и унаследованный импульс.
  const dt = frameStepMs / 1000;
  const z = result.afterInterrupt.value - target;
  const v = result.afterInterrupt.velocity;
  const attenuation = Math.exp(-13 * dt);
  const expectedValue = target + attenuation * (z * Math.cos(dt) + (v + 13 * z) * Math.sin(dt));
  const expectedVelocity = attenuation * (v * Math.cos(dt) - (170 * z + 13 * v) * Math.sin(dt));
  expect(result.replacementStart.value).toBeCloseTo(expectedValue, 9);
  expect(result.replacementStart.velocity).toBeCloseTo(expectedVelocity, 9);
  expect(result.terminal).toEqual({
    state: { value: target, velocity: 0 },
    pending: 0,
    atMs: terminalAtMs,
  });
});
