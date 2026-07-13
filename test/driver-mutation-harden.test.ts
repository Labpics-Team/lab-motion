/**
 * test/driver-mutation-harden.test.ts — S44: закалка mutation-покрытия driver.ts.
 *
 * Baseline Stryker: 44.26% (ниже break=76, 94 выживших + 71 no-cov). driver —
 * scrubbable playback-driver (timeScale/seek/play/pause/reverse/complete/cancel/
 * thenable/reduced/overflow). Инжектируемый клок (handle>0 → requestFrame-путь) →
 * детерминизм. Робастные оракулы: эндпоинты, settle-поведение, promise, монотонность.
 *
 * СТАТУС: ЧАСТИЧНАЯ закалка (волны 1+2) 44.26%→61.49% — thenable покрыт с нуля,
 * no-cov 71→22 (почти устранён), +48 мутантов убито. driver — сложный ~5-волновой
 * stateful-модуль; ПОКА НЕ в Stryker-scope (ниже break=76). Остаток: часть killable
 * (convergence-порог 278/279 как в motion-value; setTimeout-fallback 382; reverse-
 * внутренности 344/351; progress-getter 429 — phase-2b), часть ЭКВИВАЛЕНТЫ (блок внизу).
 *
 * Закрываемые КЛАССЫ (много no-cov путей — методы вообще без тестов):
 *   D1 thenable (476/481/482): await резолвится на settle (natural/complete/cancel/stop).
 *   D2 complete/cancel/stop: complete→to, cancel/stop→текущее; идемпотентны.
 *   D3 seek: computeAt(t) эмит; t<0→0, NaN→игнор, +∞→complete.
 *   D4 reverse/timeScale: reverse→from; timeScale NaN→игнор; сеттер.
 *   D5 play/pause: pause стопит loop; play возобновляет.
 *   D6 progress-getter: settled at to→1, at from→0, mid→computeProgress.
 *   D7 convergence/degenerate: from===to→instant, overflow→instant, reduced→instant.
 *   D8 dt-guards/GLOBAL_CAP: dt<=0→FIXED_DT; timeScale=0/NaN → cap-settle.
 *   D9 initialTimeScale NaN→1.0.
 */

import { describe, expect, it } from 'vitest';
import { createDriver, type DriverOptions } from '../src/driver.js';
import { MotionParamError } from '../src/index.js';

const STD_SPRING = { mass: 1, stiffness: 100, damping: 20 }; // ω0=10, ζ=1 критич.

function media(reduce: boolean): (q: string) => MediaQueryList {
  return (): MediaQueryList => ({ matches: reduce } as MediaQueryList);
}

/** Инжектируемый клок: handle>0 (requestFrame-путь), ручной drain с ts. */
function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  let handle = 1;
  let ts = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    q.push(cb);
    return handle++;
  };
  const drain = (n = 1, dtMs = 1000 / 60): void => {
    for (let i = 0; i < n && q.length > 0; i++) {
      ts += dtMs;
      q.shift()!(ts);
    }
  };
  const drainAll = (max = 6000): void => {
    let i = 0;
    while (q.length > 0 && i++ < max) drain(1);
  };
  return { requestFrame, drain, drainAll, pending: (): number => q.length };
}

/** Собрать driver с клоком + сборщиком onStep. */
function mk(over: Partial<DriverOptions> = {}) {
  const clock = makeClock();
  const emitted: number[] = [];
  const c = createDriver({
    from: 0, to: 100, spring: STD_SPRING, matchMedia: media(false),
    onStep: (v) => emitted.push(v), requestFrame: clock.requestFrame,
    ...over,
  });
  return { c, clock, emitted };
}

// ─── D1 — thenable: await резолвится на settle (строки 476/481/482, no-cov) ──────

describe('D1 thenable: await резолвится на завершении (476/481/482)', () => {
  it('естественная сходимость: await резолвится, значение ≈ to', async () => {
    const { c, clock, emitted } = mk();
    clock.drainAll();
    await c; // thenable
    expect(emitted.at(-1)).toBeCloseTo(100, 3);
  });
  it('complete(): await резолвится немедленно, последний эмит = to', async () => {
    const { c, emitted } = mk();
    c.complete();
    await c;
    expect(emitted.at(-1)).toBe(100);
  });
  it('cancel(): await резолвится, промис завершается (then вызывается)', async () => {
    const { c } = mk();
    let resolved = false;
    const p = c.then(() => { resolved = true; });
    c.cancel();
    await p;
    expect(resolved).toBe(true);
  });
});

// ─── D2 — complete/cancel/stop (строки 470-485) ─────────────────────────────────

describe('D2 complete/cancel/stop', () => {
  it('complete() → snap в to, эмит to', () => {
    const { c, emitted } = mk();
    c.complete();
    expect(emitted.at(-1)).toBe(100);
    expect(c.progress).toBe(1);
  });
  it('cancel() в промежутке → эмит текущего значения (не to)', () => {
    const { c, clock, emitted } = mk();
    clock.drain(3); // продвинулись, значение в (0,100)
    const mid = emitted.at(-1)!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    c.cancel();
    expect(emitted.at(-1)).toBeCloseTo(mid, 5); // snap на текущем, не 100
  });
  it('complete/cancel идемпотентны: повторный вызов — no-op', () => {
    const { c, emitted } = mk();
    c.complete();
    const n = emitted.length;
    c.complete(); c.cancel(); c.stop();
    expect(emitted.length).toBe(n); // без новых эмитов
  });
  it('stop() = alias cancel: эмит текущего, промис резолвится', async () => {
    const { c, clock, emitted } = mk();
    clock.drain(2);
    c.stop();
    await c;
    expect(emitted.at(-1)).toBeLessThan(100);
  });
});

// ─── D3 — seek (строки 454-468) ─────────────────────────────────────────────────

describe('D3 seek: scrub виртуального времени', () => {
  it('seek(t) эмитирует позицию при t; прогресс растёт с t', () => {
    const { c, emitted } = mk();
    c.seek(0.05);
    const p1 = c.progress;
    c.seek(0.2);
    const p2 = c.progress;
    expect(p2).toBeGreaterThan(p1); // дальше по времени → больше прогресс
    expect(emitted.length).toBeGreaterThanOrEqual(2);
  });
  it('seek(отрицательное) → clamp к 0 (from)', () => {
    const { c, emitted } = mk();
    c.seek(-5);
    expect(emitted.at(-1)).toBe(0); // from
    expect(c.time).toBe(0);
  });
  it('seek(NaN) → игнорируется (без эмита, без смены времени)', () => {
    const { c, emitted } = mk();
    c.seek(0.1);
    const n = emitted.length;
    const t0 = c.time;
    c.seek(NaN);
    expect(emitted.length).toBe(n);
    expect(c.time).toBe(t0);
  });
  it('seek(+Infinity) → complete (snap в to)', () => {
    const { c, emitted } = mk();
    c.seek(Infinity);
    expect(emitted.at(-1)).toBe(100);
    expect(c.progress).toBe(1);
  });
});

// ─── D4 — reverse / timeScale (строки 341-357, 419-424, 450) ────────────────────

describe('D4 reverse / timeScale', () => {
  it('reverse() инвертирует знак timeScale', () => {
    const { c } = mk({ initialTimeScale: 2 });
    c.reverse();
    expect(c.timeScale).toBe(-2);
  });
  it('reverse-путь: timeScale<0 → сходится в from (_vt clamp 0)', () => {
    const { c, clock, emitted } = mk({ initialTimeScale: 1 });
    clock.drain(3); // продвинулись вперёд
    c.reverse(); // теперь назад
    clock.drainAll();
    expect(emitted.at(-1)).toBe(0); // settle(from)
    expect(c.progress).toBe(0);
  });
  it('timeScale сеттер: NaN игнорируется, конечное принимается', () => {
    const { c } = mk();
    c.timeScale = 3;
    expect(c.timeScale).toBe(3);
    c.timeScale = NaN;
    expect(c.timeScale).toBe(3); // не изменилось
  });
});

// ─── D5 — play / pause (строки 437-448, 302-310) ────────────────────────────────

describe('D5 play / pause', () => {
  it('pause() останавливает loop: drain не даёт новых эмитов после паузы', () => {
    const { c, clock, emitted } = mk();
    clock.drain(2);
    c.pause();
    clock.drainAll(); // tick видит _paused → останавливает loop
    const n = emitted.length;
    clock.drainAll();
    expect(emitted.length).toBe(n); // очередь пуста, новых нет
  });
  it('play() после pause возобновляет и доезжает до to', () => {
    const { c, clock, emitted } = mk();
    clock.drain(2);
    c.pause();
    clock.drainAll();
    c.play(); // возобновление
    clock.drainAll();
    expect(emitted.at(-1)).toBeCloseTo(100, 2);
  });
  it('play() когда уже играет — no-op (не плодит второй loop)', () => {
    const { c, clock } = mk();
    clock.drain(1);
    const before = clock.pending();
    c.play(); // уже играет
    expect(clock.pending()).toBe(before); // без лишнего кадра
  });
});

// ─── D6 — progress-getter (строки 426-435) ──────────────────────────────────────

describe('D6 progress-getter', () => {
  it('settled at to → progress=1; settled at from (reverse) → progress=0', () => {
    const { c } = mk();
    c.complete();
    expect(c.progress).toBe(1);
    const r = mk({ initialTimeScale: 1 });
    r.clock.drain(3);
    r.c.reverse();
    r.clock.drainAll();
    expect(r.c.progress).toBe(0);
  });
  it('cancel в промежутке → progress из _vt (не 0/1)', () => {
    const { c, clock } = mk();
    clock.drain(3);
    c.cancel();
    const p = c.progress;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

// ─── D7 — degenerate / overflow / reduced: мгновенный settle (226-227, 395-403) ─

describe('D7 мгновенный settle: degenerate/overflow/reduced', () => {
  it('from===to → settle(to) сразу, progress=1', () => {
    const { c, emitted } = mk({ from: 42, to: 42 });
    expect(emitted).toEqual([42]);
    expect(c.progress).toBe(1);
  });
  it('overflow |from|+|to|>MAX → settle(to) сразу', () => {
    const { c, emitted } = mk({ from: -1e308, to: 1e308 });
    expect(emitted.at(-1)).toBe(1e308);
    expect(c.progress).toBe(1);
  });
  it('reduced-motion → settle(to) сразу (CHARACTER-switch, не hard-off)', () => {
    const { c, emitted } = mk({ matchMedia: media(true) });
    expect(emitted).toEqual([100]); // сразу to, один эмит
    expect(c.progress).toBe(1);
  });
});

// ─── D8 — dt-guards / GLOBAL_CAP / валидация (152-158, 318, 334) ─────────────────

describe('D8 dt-guards / GLOBAL_CAP / валидация', () => {
  it('не-конечные from/to → MotionParamError с именем параметра', () => {
    expect(() => mk({ from: NaN })).toThrow(/^LM026$/);
    expect(() => mk({ to: Infinity })).toThrow(/^LM027$/);
  });
  it('невалидная пружина → MotionParamError (validateSpringParams)', () => {
    expect(() => mk({ spring: { mass: 0, stiffness: 100, damping: 20 } })).toThrow(MotionParamError);
  });
  it('timeScale=0 (заморожено) → крутит МНОГО кадров до GLOBAL_CAP (не ранний settle)', async () => {
    const { c, clock, emitted } = mk({ initialTimeScale: 0 });
    // _vt += dt*0 = 0 → computeAt(0)=from=0, эмитится ПОВТОРНО ~GLOBAL_CAP(=10000) раз → settle.
    // Мутант 349 `else if(true)`: timeScale=0 попал бы в reverse (_vt=0<=0) → settle(from)
    // на 1-м кадре. Оракул emitted.length>1000 доказывает, что крутилось много (не ранний settle).
    clock.drainAll(10500); // 10500 > GLOBAL_CAP=MAX_FRAMES*5=10000 → достигает cap
    expect(emitted.length).toBeGreaterThan(1000); // много кадров (мутант 349→true дал бы ~1)
    expect(clock.pending()).toBe(0); // loop остановлен cap-ом (не бесконечный)
    await c; // промис резолвится (cap-settle) — без cap-а await висел бы
  }, 20000);
});

// ─── D9 — initialTimeScale NaN → дефолт 1.0 (строки 186-189) ─────────────────────

describe('D9 initialTimeScale', () => {
  it('initialTimeScale=NaN → дефолт 1.0 (анимируется вперёд)', () => {
    const { c, clock, emitted } = mk({ initialTimeScale: NaN });
    expect(c.timeScale).toBe(1.0); // NaN → дефолт
    clock.drainAll();
    expect(emitted.at(-1)).toBeCloseTo(100, 2);
  });
  it('initialTimeScale=2 принят', () => {
    const { c } = mk({ initialTimeScale: 2 });
    expect(c.timeScale).toBe(2);
  });
});

// ─── E1 — matchMedia=undefined → reduce=false (строка 122) ──────────────────────

describe('E1 matchMedia undefined → reduce=false, анимируется (строка 122)', () => {
  it('undefined matchMedia: не бросает, анимируется (не мгновенный settle)', () => {
    // Мутант 122:48 `return true`: undefined→reduce=true→мгновенный settle (1 эмит).
    // Мутант 122:7 `if(false)`: пропуск guard → matchMedia('...') на undefined → бросок.
    // Здоровый: typeof≠function → false → анимация. Замер: afterDrain=60 эмитов, final=100.
    const clock = makeClock();
    const emitted: number[] = [];
    expect(() => createDriver({
      from: 0, to: 100, spring: STD_SPRING, matchMedia: undefined,
      onStep: (v) => emitted.push(v), requestFrame: clock.requestFrame,
    })).not.toThrow();
    clock.drainAll();
    expect(emitted.length).toBeGreaterThan(1); // анимировано (мутант дал бы 1)
    expect(emitted.at(-1)).toBeCloseTo(100, 2);
  });
});

// ─── E2 — negative range: clamp-границы lo/hi по знаку (строки 162, 163) ─────────

describe('E2 negative range (from>to): clamp-границы (строки 162,163)', () => {
  it('100→0: убывает через (0,100), сходится к 0', () => {
    // range=-100<0 → healthy lo=to=0, hi=from=100. Мутант 162 `true?` → lo=from=100 →
    // clamp[100,·] → значения застряли бы ≥100. Замер: на 5-м кадре ~79.68, финал 0.
    const { c, clock, emitted } = mk({ from: 100, to: 0 });
    clock.drain(5);
    const mid = emitted.at(-1)!;
    expect(mid).toBeLessThan(100); // ушло вниз (мутант дал бы ≥100)
    expect(mid).toBeGreaterThan(0);
    clock.drainAll();
    expect(emitted.at(-1)).toBeCloseTo(0, 2);
    for (const v of emitted) {
      expect(v).toBeGreaterThanOrEqual(0 - 1e-6);
      expect(v).toBeLessThanOrEqual(100 + 1e-6);
    }
  });
});

// ─── E3 — timeScale ±Infinity: forward/reverse sign-пути (строки 341, 349) ───────

describe('E3 timeScale ±Infinity: forward/reverse (строки 341, 349)', () => {
  it('+Infinity timeScale → мгновенная forward-сходимость к to (~1 кадр)', () => {
    // _vt += dt·(+∞) = +∞ → isConvergedAt(+∞)=true → settle(to). Замер: 1 кадр, final=100.
    const { c, clock, emitted } = mk({ initialTimeScale: Infinity });
    clock.drain(1);
    expect(emitted.at(-1)).toBe(100);
    expect(c.progress).toBe(1);
  });
  it('-Infinity timeScale → reverse-путь СЕТТЛИТ в from (pending=0, не только значение)', () => {
    // Значение 0 совпадает с computeAt(-Inf)=from СЛУЧАЙНО (нота QA) — потому оракул
    // на pending()===0 ДОКАЗЫВАЕТ факт settle через reverse-путь. Мутант 349 `else if(false)`:
    // ни forward, ни reverse → падает в emit+reschedule → НЕ сеттлит → pending>0 → краснеет.
    const { c, clock, emitted } = mk({ initialTimeScale: 1 });
    clock.drain(3); // вперёд
    c.timeScale = -Infinity;
    clock.drain(2);
    expect(emitted.at(-1)).toBe(0);
    expect(c.progress).toBe(0);
    expect(clock.pending()).toBe(0); // ДОКАЗАТЕЛЬСТВО settle (мутант 349→false не сеттлил бы)
  });
  it('ФИНИТНЫЙ отрицательный timeScale (-2) → reverse СЕТТЛИТ в from (349 Logical/false||)', () => {
    // Ключ: −2 конечно, потому под-условие `(!isFinite(-2) && -2<0)` = false → ветвление
    // держится ТОЛЬКО на первом дизъюнкте `_timeScale<0`. Мутанты 349:16 `A&&B` и `false||B`
    // для finite −2 дают false → НЕ reverse → не сеттлит в from. Оракул pending=0 + value=from.
    const { c, clock, emitted } = mk({ initialTimeScale: -2 });
    clock.drain(5); // reverse от _vt=0 → _vt<0 → settle(from)
    expect(emitted.at(-1)).toBe(0); // from
    expect(clock.pending()).toBe(0); // сеттлилось (мутант A&&B/false|| крутился бы форвардно)
  });
});

// ─── E4 — convergence-порог (строки 278, 279) ───────────────────────────────────

describe('E4 convergence требует И положение, И скорость (278, 279)', () => {
  it('STD критич.: сходимость через порог за ~60 кадров (не преждевременно)', () => {
    // ζ=1 монотонный подход → cv≠to → сходимость по threshold (277-280), не saturation-gate.
    // Замер: 60 кадров. Мутанты 278/279 (снять одно условие) → сходимость раньше;
    // 278 `*absRange` вместо `/` → критерий искажён → сильно позже/cap. Окно [40, 300].
    const clock = makeClock();
    let frames = 0;
    const c = createDriver({
      from: 0, to: 100, spring: STD_SPRING, matchMedia: media(false),
      onStep: () => {}, requestFrame: clock.requestFrame,
    });
    while (clock.pending() > 0 && frames < 6000) { clock.drain(1); frames++; }
    void c;
    expect(frames).toBeGreaterThanOrEqual(40); // < 40 = уронён критерий
    expect(frames).toBeLessThanOrEqual(300); // > 300 = искажённый критерий (*absRange)
  });
});

// ─── E5 — dt-guards: ts-путь и dt<=0 (строки 326, 334) ──────────────────────────

describe('E5 dt-guards: ts-based dt и dt<=0 защита (326, 334)', () => {
  /** Клок с ЯВНЫМ ts на каждый кадр. */
  function tsClock() {
    const q: Array<(ts?: number) => void> = [];
    let h = 1;
    return {
      requestFrame: (cb: (ts?: number) => void): number => { q.push(cb); return h++; },
      step: (ts: number): void => { if (q.length) q.shift()!(ts); },
      pending: (): number => q.length,
    };
  }
  it('большой ts-скачок → быстрая сходимость (326: ts-путь, не fixed-dt)', () => {
    // Мутант 326 `if(false)`: игнорирует ts → всегда fixed-dt. С большими ts-скачками
    // (0.5s/кадр) пружина сходится за единицы кадров, а fixed-dt (1/60s) — за ~60.
    const clock = tsClock();
    const emitted: number[] = [];
    createDriver({ from: 0, to: 100, spring: STD_SPRING, matchMedia: media(false),
      onStep: (v) => emitted.push(v), requestFrame: clock.requestFrame });
    clock.step(0);      // первый кадр: _lastRealTs=undefined → dt=FIXED_DT
    clock.step(500);    // dt=(500-0)/1000=0.5s → большой шаг
    clock.step(1000);   // ещё 0.5s → пружина уже сошлась
    expect(emitted.at(-1)).toBeCloseTo(100, 1); // сошлась быстро (fixed-dt дал бы ~2 кадра прогресса)
  });
  it('повторный ts (dt=0) → guard FIXED_DT: прогресс ПОСЛЕ первого кадра (334)', () => {
    // Первый кадр даёт value>0 через ветку `_lastRealTs===undefined→FIXED_DT` (не guard 334).
    // Дискриминатор 334: кадры 2+ с dt=0. Здоровый: guard→FIXED_DT→_vt растёт→value растёт.
    // Мутант 334 `if(false)`: dt=0 → _vt+=0 → застывает на value кадра 1. Оракул: последний
    // эмит СТРОГО БОЛЬШЕ первого (прогресс за пределами кадра 1).
    const clock = tsClock();
    const emitted: number[] = [];
    createDriver({ from: 0, to: 100, spring: STD_SPRING, matchMedia: media(false),
      onStep: (v) => emitted.push(v), requestFrame: clock.requestFrame });
    clock.step(100); // кадр 1: _lastRealTs=undefined → FIXED_DT → value=v1>0
    clock.step(100); // кадр 2: dt=0 → guard → FIXED_DT → value>v1
    clock.step(100); // кадр 3: dt=0 → guard → value ещё больше
    expect(emitted.at(-1)).toBeGreaterThan(emitted[0]); // прогресс через guard (мутант 334 застыл бы на v1)
  });
});

// ─── E6 — re-entrancy: settled/повторный tick (строки 302) ──────────────────────

describe('E6 re-entrancy guard settled (строка 302)', () => {
  it('complete() затем висящий кадр в очереди → без лишнего эмита', () => {
    // Мутант 302 `if(false)` (снять _settled-guard): устаревший кадр после complete
    // прошёл бы в тело → лишний эмит. Здоровый: _settled → return.
    const { c, clock, emitted } = mk();
    clock.drain(2); // кадр запланирован
    expect(clock.pending()).toBeGreaterThan(0);
    c.complete(); // settle
    const n = emitted.length;
    clock.drainAll(); // висящий кадр слит → _settled-guard глушит
    expect(emitted.length).toBe(n); // без новых эмитов
  });
});

// ─── Документированные ЭКВИВАЛЕНТНЫЕ мутанты (часть остатка; phase-2b — отдельно) ─
//
// Не гоняются (Goodhart). NB: остаток driver ещё содержит KILLABLE мутанты (phase-2b);
// здесь — только доказанные эквиваленты, чтобы не путать их с непокрытыми:
//   • 341:28 / 349:35 (под-условие `(!Number.isFinite(_timeScale) && _timeScale > 0)` /
//     `... < 0`): ИЗБЫТОЧНО с первым дизъюнктом `_timeScale > 0` / `< 0`. Для +Infinity:
//     `Inf > 0` = true → первый дизъюнкт уже истинен, второй не влияет (аналогично −Inf).
//     Мутанты этого под-условия (`(false)`, `||` вместо `&&`, снятие `!`) не меняют
//     ветвление → эквивалент. (Наблюдаемое поведение ±Infinity закрыто E3.)
//   • 248:9 / 264:9 (computeProgress/isConvergedAt `if(from===to || overflowRange)`):
//     эти degenerate-ветки НЕДОСТИЖИМЫ через публичный путь — driver сеттлит from===to
//     и overflow МГНОВЕННО в bootstrap (строки 395-403, settle() до frame-loop), поэтому
//     computeProgress/isConvergedAt вызываются только для НЕ-degenerate драйверов, где
//     `from===to`=false и `overflow`=false → мутация `if(false)`/`&&` даёт тот же проход.
//     Эквивалент (degenerate-поведение закрыто D7 через settle-путь, не эти функции).
describe('документированные эквиваленты driver (обоснование, не театр)', () => {
  it('±Infinity timeScale: ветвление определяется первым дизъюнктом >0/<0 (341/349)', () => {
    // Характеризация: +Inf → forward (settle to), −Inf → reverse (settle from).
    const a = mk({ initialTimeScale: Infinity }); a.clock.drain(1);
    expect(a.emitted.at(-1)).toBe(100);
    const b = mk({ initialTimeScale: 1 }); b.clock.drain(3); b.c.timeScale = -Infinity; b.clock.drain(2);
    expect(b.emitted.at(-1)).toBe(0);
  });
  it('degenerate сеттлится в bootstrap, не в computeProgress/isConvergedAt (248/264)', () => {
    // Характеризация: from===to и overflow дают мгновенный settle (один эмит), progress=1.
    expect(mk({ from: 5, to: 5 }).emitted).toEqual([5]);
    expect(mk({ from: -1e308, to: 1e308 }).emitted.at(-1)).toBe(1e308);
  });
});
