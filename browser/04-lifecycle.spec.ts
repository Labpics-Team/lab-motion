/**
 * 04-lifecycle.spec.ts — матрица #102, пункт (4): cancel / finish / retarget +
 * stale-finish (устаревшее завершение перехваченного прогона).
 *
 * Детерминизм: все временные швы ./animate (now/setTimer) и CompositorSpring
 * инжектируются и шагаются вручную из теста — ноль sleep, ноль замера стены.
 * Нативный WAAPI-finish проверяется через Animation.finish()/finished (события,
 * не тайминг). Сверка C¹-непрерывности ретаргета — с readCompositorSpring.
 */

import { expect, test } from './fixtures/harness';

test('cancel(): finished резолвится, onComplete НЕ зовётся, значение удержано', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div');
    document.body.appendChild(el);

    let clock = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    let completed = false;

    const controls = animate(
      el,
      { x: 300 },
      {
        spring: { mass: 1, stiffness: 120, damping: 14 },
        now: () => clock,
        setTimer: (cb, _ms) => {
          const id = nextTimer++;
          timers.set(id, cb);
          return () => timers.delete(id);
        },
        onComplete: () => {
          completed = true;
        },
      },
    );

    // Физический старт юнита — один queueMicrotask на вызов (lazy-commit R3b):
    // дожидаемся коммита, прежде чем читать getAnimations.
    await Promise.resolve();
    // Юнит R2 host-время не читает (инжектированный now — единственный
    // авторитет); effect двигается для наблюдаемой середины полёта, иначе
    // cancel до первого браузерного кадра корректно удержал бы исходный `none`.
    clock = 120;
    const animation = el.getAnimations()[0];
    if (animation === undefined) throw new Error('WAAPI effect не создан');
    animation.currentTime = clock;
    controls.cancel();
    await controls.finished; // резолвится синхронно на cancel

    const heldTransform = el.style.transform; // инлайн-фиксация ДО cancel
    // Стянуть возможные оставшиеся таймеры — стоп не должен «до-завершиться».
    for (const cb of [...timers.values()]) cb();

    el.remove();
    return { completed, heldTransform, remainingTimers: timers.size };
  });

  expect(r.completed).toBe(false); // cancel — не естественное завершение
  expect(r.heldTransform).toMatch(/translate/); // значение удержано инлайном, не сброшено
  expect(r.remainingTimers).toBe(0);
});

test('естественное завершение: setTimer-шов → onComplete один раз, finished резолвится', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div');
    document.body.appendChild(el);

    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    let completeCount = 0;
    let clock = 0;

    const controls = animate(
      el,
      { x: 100 },
      {
        spring: { mass: 1, stiffness: 200, damping: 20 },
        now: () => clock,
        setTimer: (cb) => {
          const id = nextTimer++;
          timers.set(id, cb);
          return () => timers.delete(id);
        },
        onComplete: () => {
          completeCount++;
        },
      },
    );

    // Физический старт (и постановка settle-таймера) — на microtask (R3b).
    await Promise.resolve();
    // Дать пружине «осесть»: инжектированные часы — единственный авторитет
    // завершения (юнит не читает native currentTime); двигаем их за дедлайн
    // и выстреливаем запланированный settle-таймер.
    clock = 1e9;
    for (const cb of [...timers.values()]) cb();
    await controls.finished;

    const finalTransform = getComputedStyle(el).transform;
    el.remove();
    return { completeCount, finalTransform };
  });

  expect(r.completeCount).toBe(1); // ровно один раз
  expect(r.finalTransform).not.toBe('none'); // финал применён (fill:both держит)
});

test('stale-finish: перехват (supersede) снимает таймер старого прогона', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { animate } = await import('/dist/animate/index.js');
    const el = document.createElement('div');
    document.body.appendChild(el);

    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const completes: string[] = [];
    let clock = 0;

    const mkOpts = (tag: string) => ({
      spring: { mass: 1, stiffness: 150, damping: 16 },
      now: () => clock,
      setTimer: (cb: () => void) => {
        const id = nextTimer++;
        timers.set(id, cb);
        return () => timers.delete(id);
      },
      onComplete: () => completes.push(tag),
    });

    // Первый прогон на канале x (microtask-коммит R3b ставит его таймер).
    const first = animate(el, { x: 100 }, mkOpts('first'));
    await Promise.resolve();
    const timersAfterFirst = timers.size;
    // Второй animate на ТОМ ЖЕ элементе/канале — перехватывает первый (supersede).
    const second = animate(el, { x: 250 }, mkOpts('second'));
    await Promise.resolve();
    const timersAfterSecond = timers.size;

    // Выстрелить ВСЕ оставшиеся таймеры за дедлайном по инжектированным часам:
    // старый (перехваченный) не должен ожить.
    clock = 1e9;
    for (const cb of [...timers.values()]) cb();
    await Promise.allSettled([first.finished, second.finished]);

    el.remove();
    return { completes, timersAfterFirst, timersAfterSecond };
  });

  // Перехваченный первый прогон НЕ завершается естественно (onComplete не зовётся);
  // stale-таймер снят supersede'ом — второй прогон завершается ровно один раз.
  expect(r.completes).toEqual(['second']);
  // supersede снял таймер первого до постановки второго (в реестре — один живой).
  expect(r.timersAfterSecond).toBeLessThanOrEqual(r.timersAfterFirst);
});

test('нативный WAAPI: finish() резолвит finished; cancel() отвергает — без утечки', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    // finish(): finished резолвится. Промис берём ДО finish() — семантика WAAPI:
    // finish() резолвит ТЕКУЩИЙ finished-промис (после — тот же, уже resolved).
    const a1 = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, fill: 'both' });
    const p1 = a1.finished;
    a1.finish();
    let finishedResolved = false;
    await p1.then(() => {
      finishedResolved = true;
    });

    // cancel(): finished ОТВЕРГАЕТСЯ (AbortError). КРИТИЧНО: промис берём ДО
    // cancel() — по спеке WAAPI cancel() отвергает ТЕКУЩИЙ промис и заводит
    // НОВЫЙ pending (доступ к .finished ПОСЛЕ cancel вернул бы вечно-висящий).
    // Это и есть класс «stale-finish» на нативном уровне.
    const a2 = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, fill: 'both' });
    const p2 = a2.finished;
    a2.cancel();
    let rejected = false;
    await p2.catch(() => {
      rejected = true;
    });

    el.remove();
    return { finishedResolved, rejected };
  });

  expect(r.finishedResolved).toBe(true);
  expect(r.rejected).toBe(true);
});

test('retarget: C¹-снимок совпадает с readCompositorSpring в момент перехвата', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const compositor = await import('/dist/compositor/index.js');
    const spring = { mass: 1, stiffness: 170, damping: 13 };
    const from = 0;
    const to = 200;

    const el = document.createElement('div');
    el.style.position = 'absolute';
    document.body.appendChild(el);

    let clock = 0;
    const cs = new compositor.CompositorSpring({
      spring,
      property: 'transform',
      from,
      to,
      target: el,
      now: () => clock,
      format: (v: number) => `translateX(${v}px)`,
    });
    cs.start();
    const tier = cs.tier;

    const elapsedMs = 90;
    // НАБЛЮДАЕМОЕ значение движка на 90 мс: пауза нативной Animation + явный
    // currentTime (виртуальные часы document.timeline). Это НЕЗАВИСИМЫЙ оракул —
    // скомпилированный linear()-путь (compileSpringPlan), НЕ readCompositorSpring:
    // мутация солвера разведёт наблюдаемое и снимок ретаргета (не тавтология).
    const anim = el.getAnimations()[0];
    let observed = NaN;
    if (anim !== undefined) {
      anim.pause();
      anim.currentTime = elapsedMs;
      const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
      observed = m ? Number(m[1].split(',')[4]) : 0;
      anim.play();
    }

    // Продвигаем виртуальные часы на 90 мс и перехватываем на новую цель.
    clock = elapsedMs;
    cs.retarget(-50);
    const valueAtRetarget = cs.value; // = from' нового прогона = снимок позиции

    cs.destroy();
    el.remove();
    return { tier, observed, valueAtRetarget, amplitude: Math.abs(to - from) };
  });

  expect(r.tier).toBe('compositor');
  // Позиция на стыке ретаргета непрерывна (C⁰) И совпадает с НАБЛЮДАЕМЫМ у движка
  // значением: снимок ретаргета (readCompositorSpring) сверяется с реальной
  // отрисованной позицией скомпилированной linear()-анимации (независимый путь).
  // Допуск — reconstruction-budget A/400 ×2 + 0.1px matrix-округление (как spec 03).
  expect(Number.isFinite(r.observed)).toBe(true);
  const budget = (r.amplitude / 400) * 2 + 0.1;
  expect(Math.abs(r.valueAtRetarget - r.observed)).toBeLessThanOrEqual(budget);
});
