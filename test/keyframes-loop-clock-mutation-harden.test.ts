/**
 * test/keyframes-loop-clock-mutation-harden.test.ts — S44: закалка mutation-покрытия
 * frame-loop/clock keyframes (78.13% → выше; break=76, эрозия у границы).
 *
 * Stryker (scoped rerun по src/keyframes/index.ts на b1491b9) вскрыл 88 survived +
 * 10 no-coverage. Убиваемые — целые КЛАССЫ (не заплатки под мутант):
 *
 * (1) ЗАКОН КЛОКА: dt = (ts − prevTs)/1000; кадр без ts → FIXED_DT_S; dt<=0 →
 *     FIXED_DT_S; недренированный undefined-ts кадр НЕ трогает prevTs; play() на
 *     играющем — no-op (не сбрасывает prevTs). Оракул — ТОЧНАЯ сумма виртуального
 *     времени при смешанном ts-профиле с ненулевым стартом (ts=500; урок: нулевые
 *     старты нейтрализуют мутации). Убивает L420 (true/false/===), L421 (false,
 *     +, *1000), L426 (true, <), L497 (false).
 * (2) ГРАНИЦА NATURAL-COMPLETE: _vt >= totalDuration — settle РОВНО на кадре
 *     попадания (x+x=2x в FP точно). Оракул — счётчик заявок кадров у инжект-
 *     клока (наблюдаемая граница seam). Убивает L430 (>=→>).
 * (3) MAX_FRAMES-CAP ДОСТИЖИМ: repeat=Infinity не завершается естественно →
 *     обязан settle ровно на кадре 100 000 конечным значением (CSS-safety).
 *     Убивает L412 (++→--), L413 (false, >=→>, block).
 * (4) POST-SETTLE ДИСЦИПЛИНА: после settle НИЧЕГО не эмитится и не планируется;
 *     seek/complete/cancel после settle не двигают время; seek(NaN) — no-op;
 *     seek(Infinity) ≡ complete (настоящий settle, не только снап значения).
 *     Убивает L401 (false, block, если покрыт), L508, L509, L510 (false, block), L521.
 * (5) ФОЛЛБЕК ПЕРМАНЕНТЕН: handle=0 → движок навсегда на setTimeout; инжект-клок
 *     после этого НЕ вызывается (счётчик вызовов — наблюдаемый контракт seam).
 *     Убивает L441, L445 (false, block), L446, L465.
 * (6) SINGLE-FLIGHT ensureLoop: pause→play при невыстрелившем кадре не создаёт
 *     второй параллельный цикл (счётчик заявок). Убивает L461 (false, || -варианты), L462.
 * (7) НЕЕДИНИЧНЫЙ cycleLen: local = vt − cycleIndex*cycleLen — при duration≠1
 *     умножение отличимо от деления (урок «0,0»: cycleLen=1 нейтрализует).
 *     Убивает L370, L490.
 * (8) ENDPOINT-ТОЧНОСТЬ sampleKeyframes: p<=times[0] → values[0], p>=times[last]
 *     → values[last] ТОЧНО, минуя easing (патологичный ease(0)≠0/ease(1)≠1 —
 *     контраст). Убивает L188 (<=→<, false), L189 (>=→>, false, n+1).
 * (9) СООБЩЕНИЕ ВАЛИДАЦИИ НАЗЫВАЕТ ФАКТ: получённая длина/значение в тексте
 *     ошибки. Убивает L237 (?., && ), L269 (n+1).
 * (10) КАНОНИЧЕСКИЙ MEDIA-QUERY: reduced-motion запрашивается строкой
 *     '(prefers-reduced-motion: reduce)'. Убивает L152 (''-мутант).
 * (11) DEFAULT-rAF SEAM (no-coverage L344–347): без инжекта requestFrame движок
 *     берёт глобальный requestAnimationFrame, а при его отсутствии (Node/SSR) —
 *     setTimeout, и анимация ДОХОДИТ до финала.
 *
 * RED-proof: каждый пункт написан против конкретных ВЫЖИВШИХ мутантов baseline-
 * прогона (78.13%) — «красный против мутанта» доказывается повторным scoped
 * Stryker-прогоном (survived → killed), см. PR. Runtime-код не менялся.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyframes, sampleKeyframes, type EasingFn } from '../src/keyframes/index.js';
import { MotionParamError } from '../src/errors.js';

const FIXED_DT_S = 1 / 60;

/** Ручная rAF-очередь со счётчиком заявок: ненулевой handle, кадры дренируем сами. */
function makeQueueClock() {
  const q: Array<(ts?: number) => void> = [];
  let requests = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    q.push(cb);
    requests++;
    return 1;
  };
  return {
    q,
    requestFrame,
    requests: () => requests,
    fire(ts?: number): void {
      const cb = q.shift();
      if (cb) cb(ts);
    },
  };
}

/** Замороженный rAF: ненулевой handle, колбэк никогда не зовётся. */
const frozenRaf = (): number => 1;

// ─── (1) Закон клока: точная сумма виртуального времени ──────────────────────

describe('keyframes clock-law: dt из ts-профиля суммируется точно', () => {
  it('смешанный профиль [ts=500, ts=700, ts=700 (dup), undefined, ts=1200] → time = 3·FIXED + 0.2 + 0.5', () => {
    const clock = makeQueueClock();
    let last = Number.NaN;
    const kf = keyframes({
      values: [10, 30],
      duration: 10,
      requestFrame: clock.requestFrame,
      onStep: (v) => { last = v; },
    });
    clock.fire(500);      // первый ts-кадр: prevTs не было → FIXED_DT_S
    clock.fire(700);      // dt = 200/1000 = 0.2
    clock.fire(700);      // дубликат ts → dt=0 → FIXED_DT_S (закон dt<=0)
    clock.fire(undefined); // кадр без ts → FIXED_DT_S; prevTs ОСТАЁТСЯ 700
    clock.fire(1200);     // dt = (1200−700)/1000 = 0.5 — не от undefined-кадра
    const expected = 3 * FIXED_DT_S + 0.2 + 0.5;
    expect(kf.time).toBeCloseTo(expected, 9);
    expect(Number.isFinite(kf.time)).toBe(true);
    // Значение согласовано со временем: 10 + 20·(time/10)
    expect(last).toBeCloseTo(10 + 20 * (expected / 10), 9);
    kf.cancel();
  });

  it('play() на уже играющей анимации — no-op: не сбрасывает prevTs (dt следующего кадра из ts-разницы)', () => {
    const clock = makeQueueClock();
    const kf = keyframes({ values: [10, 30], duration: 10, requestFrame: clock.requestFrame });
    clock.fire(500);  // FIXED_DT_S
    clock.fire(1000); // dt = 0.5
    kf.play();        // не на паузе → полный no-op
    clock.fire(1500); // dt обязан быть 0.5 (prevTs=1000 сохранён), не FIXED_DT_S
    expect(kf.time).toBeCloseTo(FIXED_DT_S + 0.5 + 0.5, 9);
    kf.cancel();
  });
});

// ─── (2) Граница natural-complete: >= ровно на кадре попадания ───────────────

describe('keyframes natural-complete: settle ровно при _vt === totalDuration', () => {
  it('duration = 2·FIXED_DT_S → settle на 2-м кадре: ровно 2 заявки кадров, progress=1, финал values[last]', () => {
    const clock = makeQueueClock();
    let last = Number.NaN;
    const kf = keyframes({
      values: [3, 9],
      duration: 2 * FIXED_DT_S, // x+x = 2x в FP точно → _vt попадает РОВНО в totalDuration
      requestFrame: clock.requestFrame,
      onStep: (v) => { last = v; },
    });
    let guard = 0;
    while (clock.q.length > 0 && guard++ < 10) clock.fire(undefined);
    expect(clock.requests()).toBe(2); // ensureLoop + кадр 1; кадр 2 сеттлит и НЕ планирует
    expect(kf.progress).toBe(1);
    expect(last).toBe(9);
  });
});

// ─── (3) MAX_FRAMES-cap достижим при repeat=Infinity ─────────────────────────

describe('keyframes safety-cap: бесконечная анимация обязана остановиться на кадре MAX_FRAMES', () => {
  it('repeat=Infinity → settle ровно на кадре 100 000, значение конечно (CSS-safety)', () => {
    const clock = makeQueueClock();
    let last = Number.NaN;
    const kf = keyframes({
      values: [5, 15],
      duration: 1,
      repeat: Infinity,
      requestFrame: clock.requestFrame,
      onStep: (v) => { last = v; },
    });
    let guard = 0;
    while (clock.q.length > 0 && guard++ < 100_050) clock.fire(undefined);
    expect(clock.requests()).toBe(100_000); // ровно MAX_FRAMES заявок: cap на кадре 100 000
    expect(kf.progress).toBe(1);            // settled
    expect(Number.isFinite(last)).toBe(true);
  });
});

// ─── (4) Post-settle дисциплина ──────────────────────────────────────────────

describe('keyframes post-settle: ни эмиссий, ни планирования, ни движения времени', () => {
  it('отложенный кадр, выстреливший ПОСЛЕ cancel() в середине (_vt < totalDuration), не эмитит и не планирует', () => {
    // Именно cancel() mid-run: complete() ставит _vt = totalDuration, и мутант
    // `if (false)` на _settled-гарде тика глотается веткой natural-complete
    // без наблюдаемых следов. При _vt < totalDuration мутант обязан эмитнуть
    // и заявить новый кадр — оба следа ловим.
    const clock = makeQueueClock();
    const seen: number[] = [];
    const kf = keyframes({
      values: [7, 42],
      duration: 10,
      requestFrame: clock.requestFrame,
      onStep: (v) => seen.push(v),
    });
    expect(clock.requests()).toBe(1); // заявка от ensureLoop висит в очереди
    kf.seek(0.4);
    kf.cancel(); // settle на позиции 0.4, далеко от totalDuration=10
    const emitted = seen.length;
    clock.fire(undefined);       // «застрявший» кадр стреляет после settle
    expect(seen.length).toBe(emitted); // ноль новых эмиссий
    expect(clock.requests()).toBe(1);  // ноль новых заявок
    expect(kf.time).toBe(0.4);         // время пригвождено
  });

  it('отложенный кадр после complete() тоже нем (граничный случай _vt === totalDuration)', () => {
    const clock = makeQueueClock();
    const seen: number[] = [];
    keyframes({
      values: [7, 42],
      duration: 10,
      requestFrame: clock.requestFrame,
      onStep: (v) => seen.push(v),
    }).complete();
    const emitted = seen.length;
    clock.fire(undefined);
    expect(seen.length).toBe(emitted);
    expect(clock.requests()).toBe(1);
  });

  it('seek() после settle — no-op: время пригвождено к totalDuration', () => {
    const kf = keyframes({ values: [7, 42], duration: 1, requestFrame: frozenRaf });
    kf.complete();
    expect(kf.time).toBe(1);
    kf.seek(0.3);
    expect(kf.time).toBe(1); // не сдвинулось
  });

  it('seek(NaN) mid-run — полный no-op: время не меняется, эмиссий нет, время конечно', () => {
    const seen: number[] = [];
    const kf = keyframes({ values: [7, 42], duration: 1, requestFrame: frozenRaf, onStep: (v) => seen.push(v) });
    kf.seek(0.4);
    const emitted = seen.length;
    kf.seek(NaN);
    expect(kf.time).toBe(0.4);
    expect(Number.isFinite(kf.time)).toBe(true);
    expect(seen.length).toBe(emitted);
    kf.cancel();
  });

  it('seek(Infinity) — НАСТОЯЩИЙ settle (последующий seek не двигает время)', () => {
    const kf = keyframes({ values: [7, 42], duration: 1, requestFrame: frozenRaf });
    kf.seek(Infinity);
    expect(kf.progress).toBe(1);
    kf.seek(0.5); // после settle обязан быть no-op
    expect(kf.time).toBe(1); // мутант без complete()-ветки дал бы 0.5
  });

  it('complete() после cancel() не двигает время (первый settle побеждает)', () => {
    const kf = keyframes({ values: [7, 42], duration: 1, requestFrame: frozenRaf });
    kf.seek(0.5);
    kf.cancel();
    expect(kf.time).toBe(0.5);
    kf.complete(); // no-op: settled
    expect(kf.time).toBe(0.5); // мутант сдвинул бы к totalDuration=1
  });
});

// ─── (5) Фоллбек перманентен: после handle=0 инжект-клок больше не зовётся ───

describe('keyframes setTimeout-фоллбек: переход одноразовый и окончательный', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requestFrame всегда 0 → ровно ОДИН вызов инжект-клока за всю анимацию', () => {
    vi.useFakeTimers();
    let calls = 0;
    let last = Number.NaN;
    keyframes({
      values: [2, 8],
      duration: 0.2,
      requestFrame: () => { calls++; return 0; },
      onStep: (v) => { last = v; },
    });
    vi.runAllTimers();
    expect(last).toBe(8);    // дошло до финала на чистом setTimeout
    expect(calls).toBe(1);   // только ensureLoop; тики фоллбека клок не трогают
  });

  it('handle=0 ВНУТРИ тика (клок «испортился» на 3-м вызове) → фоллбек доводит до финала, клок больше не зовётся', () => {
    vi.useFakeTimers();
    const q: Array<(ts?: number) => void> = [];
    let calls = 0;
    let last = Number.NaN;
    keyframes({
      values: [2, 8],
      duration: 0.1, // ~6 тиков: после перехода на фоллбек остаётся НЕСКОЛЬКО тиков —
      //               мутант, не запомнивший переход, звал бы клок на каждом из них
      requestFrame: (cb) => {
        calls++;
        if (calls <= 2) { q.push(cb); return 1; } // живой rAF: ensureLoop + хвост тика 1
        return 0;                                  // хвост тика 2 → фоллбек
      },
      onStep: (v) => { last = v; },
    });
    q.shift()!(); // тик 1 (хвост: заявка №2, handle=1)
    q.shift()!(); // тик 2 (хвост: заявка №3 → handle=0 → фоллбек + setTimeout)
    vi.runAllTimers(); // тики 3..N через setTimeout → settle
    expect(last).toBe(8);
    expect(calls).toBe(3); // после handle=0 инжект-клок НЕ вызывался ни разу
  });
});

// ─── (6) ensureLoop single-flight ────────────────────────────────────────────

describe('keyframes ensureLoop: pause→play при невыстрелившем кадре не дублирует цикл', () => {
  it('заявленный, но не выстреливший кадр жив → play() не заявляет второй', () => {
    const clock = makeQueueClock();
    const kf = keyframes({ values: [10, 30], duration: 10, requestFrame: clock.requestFrame });
    expect(clock.requests()).toBe(1);
    kf.pause();
    kf.play(); // кадр из construction всё ещё в очереди → второй цикл запрещён
    expect(clock.requests()).toBe(1);
    kf.cancel();
  });
});

// ─── (7) Неединичный cycleLen: local = vt − cycleIndex·cycleLen ──────────────

describe('keyframes multi-cycle: цикловая арифметика при duration≠1', () => {
  it('duration=2, repeat=2, vt=2.5 → цикл 1, фаза 0.25 → значение и progress', () => {
    const seen: number[] = [];
    const kf = keyframes({
      values: [10, 50],
      duration: 2,
      repeat: 2,
      requestFrame: frozenRaf,
      onStep: (v) => seen.push(v),
    });
    kf.seek(2.5); // cycleIndex=1, local = 2.5 − 1·2 = 0.5, фаза 0.25
    expect(seen[seen.length - 1]).toBeCloseTo(10 + 40 * 0.25, 9); // 20; мутант ÷cycleLen дал бы 50
    expect(kf.progress).toBeCloseTo(0.25, 9);
    kf.cancel();
  });
});

// ─── (8) Endpoint-точность sampleKeyframes при патологичном easing ───────────

describe('sampleKeyframes endpoint-exactness: концы минуют easing', () => {
  const half: EasingFn = () => 0.5; // ease(0)≠0, ease(1)≠1 — контраст для границ

  it('p=0 (== times[0]) → values[0] ТОЧНО, easing не участвует', () => {
    expect(sampleKeyframes([0, 100], [0, 1], [half], 0)).toBe(0);
  });

  it('p=1 (== times[last]) → values[last] ТОЧНО, easing не участвует', () => {
    expect(sampleKeyframes([0, 100], [0, 1], [half], 1)).toBe(100);
  });

  it('контраст: внутри диапазона тот же easing РАБОТАЕТ (p=0.5 → 50 через ease=0.5)', () => {
    expect(sampleKeyframes([0, 100], [0, 1], [half], 0.5)).toBeCloseTo(50, 9);
  });
});

// ─── (9) Сообщения валидации называют фактическое значение ───────────────────

describe('keyframes валидация: сообщение цитирует полученное значение', () => {
  it('values=undefined → MotionParamError с «получено 0» (не TypeError)', () => {
    let err: unknown;
    try {
      keyframes({ values: undefined as unknown as number[], requestFrame: frozenRaf });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MotionParamError);
    expect((err as Error).message).toMatch(/получено 0/);
  });

  it('values=[7] → сообщение называет фактическую длину 1', () => {
    let err: unknown;
    try {
      keyframes({ values: [7], requestFrame: frozenRaf });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MotionParamError);
    expect((err as Error).message).toMatch(/получено 1/);
  });

  it('times[last]=0.9 → сообщение цитирует 0.9', () => {
    let err: unknown;
    try {
      keyframes({ values: [0, 1], times: [0, 0.9], requestFrame: frozenRaf });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MotionParamError);
    expect((err as Error).message).toContain('0.9');
  });
});

// ─── (10) Канонический reduced-motion media-query ────────────────────────────

describe('keyframes reduced-motion: запрашивается канонический CSS media-query', () => {
  it('matchMedia, совпадающий ТОЛЬКО на точной строке запроса → reduced-снап срабатывает', () => {
    const seen: number[] = [];
    keyframes({
      values: [7, 42],
      duration: 5,
      matchMedia: (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' }),
      requestFrame: frozenRaf,
      onStep: (v) => seen.push(v),
    });
    // Точный запрос → reduce=true → синхронный снап к values[last].
    expect(seen).toEqual([42]);
  });
});

// ─── (11) Default-rAF seam (no-coverage L344–347) ────────────────────────────

describe('keyframes default clock: без инжекта requestFrame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('глобальный requestAnimationFrame присутствует → движок берёт ЕГО (ровно 1 заявка)', () => {
    let rafCalls = 0;
    vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback): number => {
      rafCalls++;
      return 1; // ненулевой handle, кадр не стреляет — важна сама заявка
    });
    const kf = keyframes({ values: [1, 2], duration: 5 });
    expect(rafCalls).toBe(1);
    kf.cancel();
  });

  it('Node/SSR (rAF отсутствует) → setTimeout-ветка доводит анимацию до финала', async () => {
    // Реальные таймеры: короткая анимация завершается за десятки мс.
    expect(typeof requestAnimationFrame).toBe('undefined'); // предпосылка среды
    let last = Number.NaN;
    let kf: ReturnType<typeof keyframes>;
    expect(() => {
      kf = keyframes({ values: [4, 6], duration: 0.03, onStep: (v) => { last = v; } });
    }).not.toThrow();
    await kf!;
    expect(last).toBe(6);
  });
});
