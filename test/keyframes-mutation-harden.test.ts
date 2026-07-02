/**
 * test/keyframes-mutation-harden.test.ts — S34: закалка mutation-покрытия keyframes.
 *
 * Stryker (S33) вскрыл 49.5% на keyframes: выжившие — целые КЛАССЫ, не заплатки:
 * (1) валидация без ПОЗИТИВНОГО контр-теста (мутант `if(true)`/всегда-throw
 *     выживает — ни один тест не подавал keyframes() ВАЛИДНЫЕ явные times/easing[]
 *     и не проверял, что они ПРИНЯТЫ; дифф-тесты зовут sampleKeyframes напрямую,
 *     минуя compileKeyframes) + текст сообщений (throw проверялся без контента);
 * (2) направление yoyo `cycleIndex % 2` — пинилось лишь на 2-м цикле (нужен 3-й);
 * (3) lastCycleEndValue / progress / seek-clamp — точность значений не пиналась.
 *
 * Метод: differential/boundary по КЛАССАМ. Оракулы — литералы (не self-consistent).
 * RED-proof — в докблоках групп; каждый убивает конкретный выживший мутант.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyframes, sampleKeyframes, type EasingFn, type KeyframesOptions } from '../src/keyframes/index.js';
import { MotionParamError } from '../src/errors.js';

const linear: EasingFn = (t) => t;

/** rAF-заглушка: ненулевой handle, колбэк НИКОГДА не зовётся → цикл не тикает.
 *  seek() эмитит computeAt синхронно, вне продвижения времени. */
const frozenRaf = (): number => 1;

/** Проба computeAt при виртуальном времени vt через seek + захват onStep. */
function probeAt(opts: Omit<KeyframesOptions, 'requestFrame' | 'onStep'>, vt: number): number {
  let last = Number.NaN;
  const kf = keyframes({ ...opts, requestFrame: frozenRaf, onStep: (v) => { last = v; } });
  kf.seek(vt);
  return last;
}

/** Дренирующий клок: ts=undefined → dt=1/60 c за тик; гоняет до settle. */
function runToEnd(opts: Omit<KeyframesOptions, 'requestFrame' | 'onStep'>): number {
  const q: Array<(ts?: number) => void> = [];
  const raf = (cb: (ts?: number) => void): number => { q.push(cb); return 1; };
  let last = Number.NaN;
  keyframes({ ...opts, requestFrame: raf, onStep: (v) => { last = v; } });
  let guard = 0;
  while (q.length > 0 && guard++ < 200_000) {
    const cb = q.shift()!;
    cb();
  }
  return last;
}

// ─── КЛАСС 1: валидация принимает валидное + сообщение называет поле ──────────
// Убивает: `if(true)`/`if(false)`/`===`↔`!==` мутанты условий валидации
// (нужен ПОЗИТИВНЫЙ путь) + мутации текста сообщений `...` → `` (нужен контент).
describe('keyframes валидация: валидное ПРИНЯТО + сообщение называет поле', () => {
  it('валидные явные times (length===n, [0..1], ascending) ПРИНЯТЫ (kill if(true) на times-блоке)', () => {
    // Ни один прежний тест не подавал keyframes() валидные явные times →
    // мутант `if (opts.times.length !== n)` → `if (true)` (всегда throw) выживал.
    expect(() =>
      keyframes({ values: [0, 50, 100], times: [0, 0.3, 1], requestFrame: frozenRaf }),
    ).not.toThrow();
    // и результат корректен на этих явных times:
    expect(probeAt({ values: [0, 100], times: [0, 1], duration: 1 }, 0.5)).toBeCloseTo(50, 6);
  });

  it('валидный easing[] по числу сегментов ПРИНЯТ (kill if(true) на easing-блоке)', () => {
    expect(() =>
      keyframes({ values: [0, 50, 100], easing: [linear, linear], requestFrame: frozenRaf }),
    ).not.toThrow();
  });

  it('валидный duration>0, repeat>=0, repeatDelay>=0 ПРИНЯТЫ', () => {
    expect(() =>
      keyframes({ values: [0, 1], duration: 2, repeat: 3, repeatDelay: 0.5, repeatType: 'reverse', requestFrame: frozenRaf }),
    ).not.toThrow();
    expect(() =>
      keyframes({ values: [0, 1], repeat: Infinity, requestFrame: frozenRaf }),
    ).not.toThrow();
  });

  const cases: Array<[string, KeyframesOptions, RegExp]> = [
    ['values<2', { values: [0] }, /values/],
    ['values non-finite', { values: [0, NaN] }, /values\[1\]|конечным/],
    ['times length', { values: [0, 1, 2], times: [0, 1] }, /times\.length|совпадать/],
    ['times non-finite', { values: [0, 1], times: [0, NaN] }, /times\[1\]|конечным/],
    ['times[0]!==0', { values: [0, 1], times: [0.1, 1] }, /times\[0\]/],
    ['times[last]!==1', { values: [0, 1], times: [0, 0.9] }, /times\[last\]|последн|=\s*1/],
    ['times non-ascending', { values: [0, 1, 2], times: [0, 0.8, 0.5] }, /ascending|неубыва/],
    ['easing[] length', { values: [0, 1, 2], easing: [linear] }, /easing|сегмент/],
    ['duration<=0', { values: [0, 1], duration: 0 }, /duration|положительн/],
    ['repeat negative', { values: [0, 1], repeat: -1 }, /repeat/],
    ['repeat non-integer', { values: [0, 1], repeat: 1.5 }, /repeat|цел/],
    ['bad repeatType', { values: [0, 1], repeatType: 'zzz' as unknown as 'loop' }, /repeatType/],
    ['repeatDelay negative', { values: [0, 1], repeatDelay: -1 }, /repeatDelay/],
  ];
  for (const [name, opts, msgRe] of cases) {
    it(`невалидное «${name}» → throw с сообщением, называющим поле (kill text-мутанта)`, () => {
      let err: unknown;
      try {
        keyframes({ ...opts, requestFrame: frozenRaf });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MotionParamError);
      expect((err as Error).message).toMatch(msgRe);
      expect((err as Error).message.length).toBeGreaterThan(0); // kill `...`→``
    });
  }
});

// ─── КЛАСС 2: sampleKeyframes границы и клампы (literal-оракул) ───────────────
describe('sampleKeyframes границы: p=NaN/±Infinity, точные стыки, нулевой сегмент', () => {
  const V = [10, 20, 40];
  const T = [0, 0.5, 1];
  const E = [linear, linear];

  it('p=NaN → pClamped=0 → values[0] (kill ternary-веток 186)', () => {
    expect(sampleKeyframes(V, T, E, NaN)).toBe(10);
  });
  it('p=+Infinity → 1 → values[last]', () => {
    expect(sampleKeyframes(V, T, E, Infinity)).toBe(40);
  });
  it('p=-Infinity → 0 → values[0]', () => {
    expect(sampleKeyframes(V, T, E, -Infinity)).toBe(10);
  });
  it('p ровно на внутреннем стыке t=0.5 → values[1] (границы сегмент-поиска)', () => {
    expect(sampleKeyframes(V, T, E, 0.5)).toBe(20);
  });
  it('p чуть ниже стыка → в первом сегменте (лерп), не во втором', () => {
    // 0.25 в сегменте [0,0.5]: 10 + (20-10)*(0.25/0.5) = 15
    expect(sampleKeyframes(V, T, E, 0.25)).toBeCloseTo(15, 9);
  });
  it('p чуть выше стыка → во втором сегменте', () => {
    // 0.75 в [0.5,1]: 20 + (40-20)*((0.75-0.5)/0.5) = 30
    expect(sampleKeyframes(V, T, E, 0.75)).toBeCloseTo(30, 9);
  });
  it('плато times (дубликат) → стык отдаёт старт правого сегмента, без NaN', () => {
    // times [0, 0.5, 0.5, 1]: поиск на p=0.5 выбирает сегмент [0.5,1] (i=2) —
    // нулевой сегмент [0.5,0.5] пропускается конструктивно; результат конечный.
    const vals = [0, 10, 20, 30];
    const tms = [0, 0.5, 0.5, 1];
    const eas = [linear, linear, linear];
    expect(sampleKeyframes(vals, tms, eas, 0.5)).toBe(20); // старт сегмента [0.5,1] = values[2]
    expect(sampleKeyframes(vals, tms, eas, 0.75)).toBeCloseTo(25, 9); // 20+(30-20)*0.5
  });
  it('нелинейный easing применён посегментно (kill "забыть easing")', () => {
    const quad: EasingFn = (t) => t * t;
    // сегмент [0,1] один: 0→100, p=0.5, quad(0.5)=0.25 → 25
    expect(sampleKeyframes([0, 100], [0, 1], [quad], 0.5)).toBeCloseTo(25, 9);
  });
  it('per-segment easings[i] — правильный индекс сегмента (не easings[0] везде)', () => {
    const quad: EasingFn = (t) => t * t;
    // seg0 linear, seg1 quad; p=0.75 во втором: local=0.5, quad=0.25 → 20+(40-20)*0.25=25
    expect(sampleKeyframes(V, T, [linear, quad], 0.75)).toBeCloseTo(25, 9);
  });
});

// ─── КЛАСС 3: computeAt направление yoyo через ≥3 цикла (kill `% 2`) ─────────
describe('keyframes computeAt: направление loop/reverse/mirror по циклам', () => {
  const opts = { values: [0, 100], duration: 1, repeat: 5 } as const;

  it("loop: КАЖДЫЙ цикл вперёд (phase 0.25 → 25 во всех циклах)", () => {
    // loop: forward всегда true. phase 0.25 в цикле k → sample(0.25)=25.
    for (const cyc of [0, 1, 2, 3]) {
      expect(probeAt({ ...opts, repeatType: 'loop' }, cyc * 1 + 0.25)).toBeCloseTo(25, 6);
    }
  });

  it("reverse: чётный цикл вперёд, нечётный назад (25 / 75 / 25 / 75) — kill %2", () => {
    // cycle 0 forward: sample(0.25)=25; cycle1 backward: sample(1-0.25=0.75)=75;
    // cycle2 forward: 25; cycle3 backward: 75. Нужен ≥3-й цикл, чтобы %2 кусался.
    expect(probeAt({ ...opts, repeatType: 'reverse' }, 0.25)).toBeCloseTo(25, 6);
    expect(probeAt({ ...opts, repeatType: 'reverse' }, 1.25)).toBeCloseTo(75, 6);
    expect(probeAt({ ...opts, repeatType: 'reverse' }, 2.25)).toBeCloseTo(25, 6);
    expect(probeAt({ ...opts, repeatType: 'reverse' }, 3.25)).toBeCloseTo(75, 6);
  });

  it("mirror ≡ reverse по направлению (alias)", () => {
    expect(probeAt({ ...opts, repeatType: 'mirror' }, 1.25)).toBeCloseTo(75, 6);
    expect(probeAt({ ...opts, repeatType: 'mirror' }, 2.25)).toBeCloseTo(25, 6);
  });

  it('repeatDelay: значение УДЕРЖИВАЕТСЯ на конце цикла в паузе (phaseP=1)', () => {
    // duration=1, delay=0.5, loop: в окне [1,1.5) local>duration → phaseP=1 → sample(1)=100
    const held = probeAt({ values: [0, 100], duration: 1, repeat: 3, repeatDelay: 0.5, repeatType: 'loop' }, 1.25);
    expect(held).toBeCloseTo(100, 6);
  });
});

// ─── КЛАСС 4: конец последнего цикла / progress / seek-clamp / complete ──────
describe('keyframes: финал последнего цикла, progress, seek-clamp, complete/cancel', () => {
  it('reverse repeat=1 (2 цикла, последний НЕЧЁТНЫЙ) → финал values[0] (kill %2 в lastCycleEndValue)', () => {
    expect(runToEnd({ values: [0, 100], duration: 1, repeat: 1, repeatType: 'reverse' })).toBe(0);
  });
  it('reverse repeat=2 (3 цикла, последний ЧЁТНЫЙ) → финал values[last]', () => {
    expect(runToEnd({ values: [0, 100], duration: 1, repeat: 2, repeatType: 'reverse' })).toBe(100);
  });
  it('loop repeat=1 → финал всегда values[last]', () => {
    expect(runToEnd({ values: [0, 100], duration: 1, repeat: 1, repeatType: 'loop' })).toBe(100);
  });

  it('progress: 0 в начале, ~0.5 в середине, 1 после settle', () => {
    const seen: number[] = [];
    const kf = keyframes({ values: [0, 100], duration: 1, requestFrame: frozenRaf, onStep: (v) => seen.push(v) });
    expect(kf.progress).toBe(0);
    kf.seek(0.5);
    expect(kf.progress).toBeCloseTo(0.5, 6);
    kf.complete();
    expect(kf.progress).toBe(1); // kill `if(_settled) return 1`
  });

  it('seek клампит: отрицательное → 0, за totalDuration (конечный) → totalDuration', () => {
    const kf = keyframes({ values: [0, 100], duration: 2, requestFrame: frozenRaf });
    kf.seek(-5);
    expect(kf.time).toBe(0); // нижний кламп
    kf.seek(999);
    expect(kf.time).toBe(2); // верхний кламп = totalDuration (kill upper=MAX_VALUE ветки на конечном)
  });

  it('complete() → мгновенно последнее значение и progress=1', () => {
    expect(probeAtComplete({ values: [7, 42], duration: 1 })).toBe(42);
  });

  it('cancel() фиксирует ТЕКУЩЕЕ значение (computeAt vt), не последнее', () => {
    const seen: number[] = [];
    const kf = keyframes({ values: [0, 100], duration: 1, requestFrame: frozenRaf, onStep: (v) => seen.push(v) });
    kf.seek(0.5); // текущее ~50
    kf.cancel();
    expect(seen[seen.length - 1]).toBeCloseTo(50, 6); // не 100
  });
});

/** complete() и захват последнего onStep. */
function probeAtComplete(opts: Omit<KeyframesOptions, 'requestFrame' | 'onStep'>): number {
  let last = Number.NaN;
  const kf = keyframes({ ...opts, requestFrame: frozenRaf, onStep: (v) => { last = v; } });
  kf.complete();
  return last;
}

// ─── КЛАСС 7: реальный frame-loop через setTimeout-фоллбек (handle=0) ────────
// Легитимные поведения (не таймер-театр): SSR/Node-фоллбек, pause/play, dt-гард.
describe('keyframes frame-loop: setTimeout-фоллбек, pause/play, dt-гард', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('handle=0 (нет rAF) → setTimeout-фоллбек доводит анимацию до финала (kill 441/464)', () => {
    vi.useFakeTimers();
    let last = Number.NaN;
    keyframes({ values: [0, 100], duration: 0.5, requestFrame: () => 0, onStep: (v) => { last = v; } });
    vi.runAllTimers(); // прогоняет setTimeout-цепочку тиков до settle
    expect(last).toBe(100);
  });

  it('pause прекращает эмиссии, play возобновляет (kill ensureLoop/tick _paused ветки)', () => {
    // Ручная rAF-очередь (ненулевой handle) — контролируем ЧИСЛО кадров точно;
    // duration велика, чтобы не сеттлить за несколько тиков.
    const q: Array<(ts?: number) => void> = [];
    const raf = (cb: (ts?: number) => void): number => { q.push(cb); return 1; };
    const seen: number[] = [];
    const kf = keyframes({ values: [0, 100], duration: 10, requestFrame: raf, onStep: (v) => seen.push(v) });
    for (let i = 0; i < 3 && q.length > 0; i++) { const cb = q.shift()!; cb(); }
    const afterPlay = seen.length;
    expect(afterPlay).toBeGreaterThan(0); // цикл реально тикал
    kf.pause();
    while (q.length > 0) { const cb = q.shift()!; cb(); } // на паузе tick не эмитит и не перезаявляет
    expect(seen.length).toBe(afterPlay); // ноль новых эмиссий
    kf.play(); // ensureLoop заново ставит кадр
    for (let i = 0; i < 2 && q.length > 0; i++) { const cb = q.shift()!; cb(); }
    expect(seen.length).toBeGreaterThan(afterPlay); // возобновилось
    kf.cancel();
  });

  it('dt<=0 (ts идёт назад) не ломает прогресс — используется FIXED_DT_S (kill 426)', () => {
    vi.useFakeTimers();
    const q: Array<(ts?: number) => void> = [];
    // requestFrame возвращает ненулевой handle → путь rAF, но мы сами зовём cb с ts.
    let last = Number.NaN;
    keyframes({
      values: [0, 100],
      duration: 0.5,
      requestFrame: (cb) => { q.push(cb); return 1; },
      onStep: (v) => { last = v; },
    });
    let ts = 1000;
    let guard = 0;
    while (q.length > 0 && guard++ < 5000) {
      ts -= 5; // ts УБЫВАЕТ → dt<=0 → должен подставиться FIXED_DT_S и всё равно прогрессировать
      const cb = q.shift()!;
      cb(ts);
    }
    expect(last).toBe(100); // несмотря на убывающий ts, дошло до финала
  });

  it('complete() из уже settled — no-op (второй вызов не бросает и не меняет) (kill 401 _settled-гард)', () => {
    const seen: number[] = [];
    const kf = keyframes({ values: [0, 100], duration: 1, requestFrame: frozenRaf, onStep: (v) => seen.push(v) });
    kf.complete();
    const n = seen.length;
    kf.complete(); // повторный — должен быть no-op
    kf.cancel(); // тоже no-op после settle
    expect(seen.length).toBe(n);
  });
});

// ─── КЛАСС 5: progress многоцикловый + repeatDelay + кламп за концом ─────────
describe('keyframes progress: цикловая математика (kill 489-491)', () => {
  it('progress отражает ФАЗУ внутри цикла, а не глобальный прогресс (cycleIndex>0)', () => {
    // repeat=2, duration=1, delay=0 → totalCycles=3, cycleLen=1.
    const kf = keyframes({ values: [0, 100], duration: 1, repeat: 2, requestFrame: frozenRaf });
    kf.seek(1.5); // цикл 1, local=0.5
    expect(kf.progress).toBeCloseTo(0.5, 6); // kill Math.max(0,cycleIndex)*cycleLen (490)
    kf.seek(2.25); // цикл 2, local=0.25
    expect(kf.progress).toBeCloseTo(0.25, 6);
  });

  it('progress=1 в окне repeatDelay (local>duration → 1) (kill 491)', () => {
    // duration=1, delay=1 → cycleLen=2. vt=1.5: cycleIndex=0, local=1.5>duration → p=1.
    const kf = keyframes({ values: [0, 100], duration: 1, repeat: 1, repeatDelay: 1, requestFrame: frozenRaf });
    kf.seek(1.5);
    expect(kf.progress).toBe(1);
  });

  it('progress клампит cycleIndex за концом конечной анимации (kill 489)', () => {
    const kf = keyframes({ values: [0, 100], duration: 1, repeat: 2, requestFrame: frozenRaf });
    kf.seek(999); // клампится к totalDuration=3; cycleIndex 3>=totalCycles 3 → clamp к 2
    expect(kf.progress).toBe(1);
  });
});

// ─── КЛАСС 6: easing-функция, clampFinite defensive, complete на Infinity ────
describe('keyframes: одиночный easing, CSS-safety при патологичном easing, complete∞', () => {
  it('easing как одиночная ФУНКЦИЯ применяется ко всем сегментам (kill typeof-function 288)', () => {
    const quad: EasingFn = (t) => t * t;
    // values [0,100,200] два сегмента, единый quad. vt=0.25 (duration 1): phase 0.25,
    // effectiveP=0.25 в сегменте [0,0.5]: local=0.5, quad(0.5)=0.25 → 0+(100-0)*0.25=25.
    expect(probeAt({ values: [0, 100, 200], duration: 1, easing: quad }, 0.25)).toBeCloseTo(25, 6);
    // vs linear дал бы 0+100*0.5=50 — доказывает, что quad РЕАЛЬНО применён.
    expect(probeAt({ values: [0, 100, 200], duration: 1, easing: linear }, 0.25)).toBeCloseTo(50, 6);
  });

  it('clampFinite: easing→+∞ даёт +MAX, →−∞ даёт −MAX, →NaN даёт 0 (kill 139/140)', () => {
    // range=1 делает ±MAX НАБЛЮДАЕМЫМ (raw=0+1*±MAX конечно), а не схлопнутым в v1.
    const inf: EasingFn = () => Infinity;
    const ninf: EasingFn = () => -Infinity;
    const nan: EasingFn = () => Number.NaN;
    expect(sampleKeyframes([0, 1], [0, 1], [inf], 0.5)).toBe(Number.MAX_VALUE);
    expect(sampleKeyframes([0, 1], [0, 1], [ninf], 0.5)).toBe(-Number.MAX_VALUE);
    expect(sampleKeyframes([0, 1], [0, 1], [nan], 0.5)).toBe(0);
  });

  it('complete() на Infinity-длительности НЕ трогает _vt (kill 523)', () => {
    const kf = keyframes({ values: [0, 100], duration: 1, repeat: Infinity, requestFrame: frozenRaf });
    kf.seek(5);
    kf.complete();
    expect(kf.time).toBe(5); // осталось 5, не totalDuration (=Infinity)
    expect(kf.progress).toBe(1); // settled
  });

  it('точные концы: p=0 → values[0], p=1 → values[last] (kill return-веток 188/189)', () => {
    expect(sampleKeyframes([7, 20, 99], [0, 0.5, 1], [linear, linear], 0)).toBe(7);
    expect(sampleKeyframes([7, 20, 99], [0, 0.5, 1], [linear, linear], 1)).toBe(99);
  });

  it('seek(конечное) НЕ сеттлит — можно сикать повторно (kill t===Infinity→иное на 510)', () => {
    const kf = keyframes({ values: [0, 100], duration: 4, requestFrame: frozenRaf });
    kf.seek(1);
    expect(kf.progress).toBeLessThan(1); // не завершено
    kf.seek(3); // повторный seek работает (не no-op после settle)
    expect(kf.time).toBe(3);
    expect(kf.progress).toBeLessThan(1);
  });

  it('times с РАВНЫМИ соседями (неубывающие) ПРИНЯТЫ; строго убывающие — throw (kill < vs <= на 261)', () => {
    // t[i] === t[i-1] допустимо (неубывающие); t[i] < t[i-1] — нет.
    expect(() => keyframes({ values: [0, 1, 2], times: [0, 0.5, 1], requestFrame: frozenRaf })).not.toThrow();
    expect(() => keyframes({ values: [0, 1, 2, 3], times: [0, 0.5, 0.5, 1], requestFrame: frozenRaf })).not.toThrow();
    expect(() => keyframes({ values: [0, 1, 2], times: [0, 0.6, 0.5] as unknown as number[], requestFrame: frozenRaf })).toThrow(/ascending|неубыва/);
  });

  it('авто-распределение times равными долями i/(n-1) (kill 275)', () => {
    // 3 values без times → авто [0, 0.5, 1]. Проба на vt=0.25 (duration 1) в сегменте [0,0.5].
    // [0,100,200], seg0 linear: local=0.25/0.5=0.5 → 0+(100-0)*0.5=50.
    expect(probeAt({ values: [0, 100, 200], duration: 1 }, 0.25)).toBeCloseTo(50, 6);
    // vt=0.75 в сегменте [0.5,1]: local=0.5 → 100+(200-100)*0.5=150.
    expect(probeAt({ values: [0, 100, 200], duration: 1 }, 0.75)).toBeCloseTo(150, 6);
  });

  it('ts-based тик: dt из реальных timestamp (kill dt-ветки 420-422)', () => {
    // Клок с ЯВНЫМИ ts: dt=(ts-lastTs)/1000. Прогон до конца, финал = values[last].
    const q: Array<(ts?: number) => void> = [];
    const raf = (cb: (ts?: number) => void): number => { q.push(cb); return 1; };
    let last = Number.NaN;
    keyframes({ values: [0, 100], duration: 1, requestFrame: raf, onStep: (v) => { last = v; } });
    let ts = 0;
    let guard = 0;
    while (q.length > 0 && guard++ < 10_000) {
      ts += 100; // +0.1s за кадр
      const cb = q.shift()!;
      cb(ts);
    }
    expect(last).toBe(100); // дошло до финала через ts-путь
  });
});
