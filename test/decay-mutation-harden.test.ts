/**
 * test/decay-mutation-harden.test.ts — S40: закалка mutation-покрытия decay.ts.
 *
 * Baseline Stryker: decay.ts = 63.55% (37 выживших). decay — ЧИСТАЯ closed-form
 * математика (не stateful, нет frame-loop/MAX_FRAMES) → оракулы прямые: значение
 * value/velocity/rest/isSettled в конкретных точках. Никакой cap-маскировки.
 *
 * Модель: amplitude = power·velocity·timeConstant; rest = from + amplitude;
 *   value(t) = from + amplitude·(1 − e^(−t/tc)); velocity(t) = (amp/tc)·e^(−t/tc).
 *
 * Закрываемые КЛАССЫ (формулы value/velocity уже убиты differential-тестом):
 *   D1 overflow/clampAmplitude/rest (131,132,181): 0 существующего покрытия —
 *      огромная velocity → amplitude/rest переполняются → ±MAX_VALUE по знаку.
 *   D2 accept-пути knobs (163 power, 167/169 timeConstant, 173/175 restDelta):
 *      undefined→дефолт, валидный→используется, невалидный(NaN/∞/≤0)→дефолт.
 *   D3 сообщения ошибок (153,157): называют невалидный параметр.
 *   D4 matchMedia (110 typeof, 112 query-строка): reduced-motion CHARACTER-switch.
 *
 * Эквиваленты/недостижимые (199,205,213,219,220,110-if(false)) — в блоке внизу.
 */

import { describe, expect, it } from 'vitest';
import { createDecay } from '../src/decay.js';
import { MotionParamError } from '../src/index.js';

const MAX = Number.MAX_VALUE;

// ─── D1 — overflow: amplitude/rest → ±MAX_VALUE по знаку (строки 131, 132, 181) ──

describe('D1 overflow clampAmplitude + rest (строки 131, 132, 181)', () => {
  it('положительное переполнение amplitude → rest = +MAX_VALUE, value/velocity конечны', () => {
    // amplitude = 1·1e308·10 = 1e309 → Infinity → clampAmplitude → +MAX_VALUE (132 знак).
    // Мутант 131 `if(isFinite)` убран → вернул бы Infinity; 132 `>0`→знак/true? → -MAX.
    const d = createDecay({ from: 0, velocity: 1e308, power: 1, timeConstant: 10 });
    expect(d.rest).toBe(MAX);
    expect(Number.isFinite(d.valueAt(1))).toBe(true);
    expect(Number.isFinite(d.velocityAt(1))).toBe(true);
    expect(Number.isFinite(d.valueAt(1e9))).toBe(true);
    // Мутант 131 `if(true)` (clampAmplitude без клампа) → amplitude=Infinity →
    // valueAt = finiteOr(Inf·decayFactor=Inf) = rest = MAX на ЛЮБОМ t. Здоровый:
    // amplitude=MAX (конечно) → valueAt(1) = MAX·(1−e^(−0.1)) < MAX. Оракул кусает.
    expect(d.valueAt(1)).toBeLessThan(d.rest);
  });

  it('отрицательное переполнение amplitude → rest = −MAX_VALUE (132 знак/unary)', () => {
    const d = createDecay({ from: 0, velocity: -1e308, power: 1, timeConstant: 10 });
    expect(d.rest).toBe(-MAX);
  });

  it('переполнение суммы from+amplitude → rest клампится (181 fallback + знак)', () => {
    // amplitude = 1·1e308·1 = 1e308 (конечно); from+amp = 2e308 = Infinity →
    // finiteOr(Infinity, amp>0?MAX:−MAX) = +MAX (181). Мутант знака 181:43 → −MAX.
    const dp = createDecay({ from: 1e308, velocity: 1e308, power: 1, timeConstant: 1 });
    expect(dp.rest).toBe(MAX);
    // Отрицательная сторона: from+amp = −2e308 = −Infinity → −MAX (181:78 unary).
    const dn = createDecay({ from: -1e308, velocity: -1e308, power: 1, timeConstant: 1 });
    expect(dn.rest).toBe(-MAX);
  });
});

// ─── D2 — accept-пути knobs (163 power, 167/169 tc, 173/175 restDelta) ──────────

describe('D2 accept-путь power (строка 163)', () => {
  it('валидный power используется: rest = from + power·velocity·tc', () => {
    // power=2: rest = 0 + 2·100·0.35 = 70. Дефолт power=0.8 дал бы 28.
    const d = createDecay({ from: 0, velocity: 100, power: 2 });
    expect(d.rest).toBeCloseTo(70, 6); // мутант «всегда дефолт» дал бы 28
  });
  it('power=undefined → дефолт 0.8: rest = 28', () => {
    const d = createDecay({ from: 0, velocity: 100 });
    expect(d.rest).toBeCloseTo(28, 6);
  });
  it('power=NaN → дефолт (не протекает NaN в amplitude)', () => {
    // Мутант, убравший isFinite-проверку, использовал бы NaN → amplitude=NaN →
    // clampAmplitude(NaN) → −MAX (NaN>0 false). rest конечен и = 28 (дефолт).
    const d = createDecay({ from: 0, velocity: 100, power: NaN });
    expect(d.rest).toBeCloseTo(28, 6);
  });
  it('power=Infinity → дефолт (не протекает ∞)', () => {
    const d = createDecay({ from: 0, velocity: 100, power: Infinity });
    expect(d.rest).toBeCloseTo(28, 6);
  });
});

describe('D2 accept-путь timeConstant (строки 167, 169)', () => {
  it('валидный timeConstant используется: rest и скорость затухания зависят от него', () => {
    // tc=1: rest = 0.8·100·1 = 80. Дефолт tc=0.35 дал бы 28.
    const d = createDecay({ from: 0, velocity: 100, timeConstant: 1 });
    expect(d.rest).toBeCloseTo(80, 6);
  });
  it('timeConstant=0 → невалиден (>0) → дефолт 0.35: rest=28 (не 0)', () => {
    // Мутант 169 `>0`→`>=0` принял бы tc=0 → amplitude=0.8·100·0=0 → rest=from=0.
    // Здоровый дефолтит → rest=28. Оракул rest≈28 кусает.
    const d = createDecay({ from: 0, velocity: 100, timeConstant: 0 });
    expect(d.rest).toBeCloseTo(28, 6); // мутант дал бы 0
  });
  it('timeConstant<0 → невалиден → дефолт', () => {
    const d = createDecay({ from: 0, velocity: 100, timeConstant: -5 });
    expect(d.rest).toBeCloseTo(28, 6);
  });
  it('timeConstant=NaN/Infinity → дефолт', () => {
    expect(createDecay({ from: 0, velocity: 100, timeConstant: NaN }).rest).toBeCloseTo(28, 6);
    expect(createDecay({ from: 0, velocity: 100, timeConstant: Infinity }).rest).toBeCloseTo(28, 6);
  });
});

describe('D2 accept-путь restDelta (строки 173, 175)', () => {
  it('большой restDelta принят: isSettledAt раньше даёт true', () => {
    // velocityAt(0) = amp/tc = (0.8·100·0.35)/0.35 = 80. restDelta=1000 → |80|<=1000 → true.
    // Дефолт restDelta=0.5 → 80<=0.5 false. Оракул кусает defaulting-мутантов.
    const d = createDecay({ from: 0, velocity: 100, restDelta: 1000 });
    expect(d.isSettledAt(0)).toBe(true); // мутант «дефолт» дал бы false
  });
  it('restDelta=0 принят (граница >=0): не settled пока velocity>0 (кусает 175 >=0→>0)', () => {
    // restDelta=0 валиден (>=0). Мутант 175 `>=0`→`>0` ОТВЕРГ бы 0 → дефолт 0.5.
    // Дискриминатор — t, где velocity ∈ (0, 0.5): velocityAt(2)=80·e^(−2/0.35)≈0.26.
    // Здоровый (restDelta=0): 0.26<=0 → false. Мутант (дефолт 0.5): 0.26<=0.5 → true.
    const d = createDecay({ from: 0, velocity: 100, restDelta: 0 });
    expect(d.isSettledAt(0)).toBe(false); // velocity=80 > 0
    expect(d.isSettledAt(2)).toBe(false); // velocity≈0.26 > 0 (мутант >0 дал бы true)
  });
  it('restDelta<0 → невалиден → дефолт 0.5 (не «никогда не settled»)', () => {
    // Мутант 175 `>=0`→`>0`/знак принял бы -1 → isSettledAt: |vel|<=-1 всегда false →
    // НИКОГДА не settled. Здоровый дефолтит 0.5 → на большом t (velocity→0) settled=true.
    const d = createDecay({ from: 0, velocity: 100, restDelta: -1 });
    expect(d.isSettledAt(100)).toBe(true); // на t=100 velocity≈0 <= 0.5 → true
  });
  it('restDelta=NaN → дефолт', () => {
    const d = createDecay({ from: 0, velocity: 100, restDelta: NaN });
    expect(d.isSettledAt(100)).toBe(true);
  });
});

// ─── D3 — сообщения ошибок называют параметр (строки 153, 157) ──────────────────

describe('D3 сообщения ошибок называют невалидный параметр (153, 157)', () => {
  it('from не конечен → MotionParamError с "from"', () => {
    expect(() => createDecay({ from: NaN, velocity: 0 })).toThrow(MotionParamError);
    expect(() => createDecay({ from: Infinity, velocity: 0 })).toThrow(/from/);
  });
  it('velocity не конечна → MotionParamError с "velocity"', () => {
    expect(() => createDecay({ from: 0, velocity: NaN })).toThrow(/velocity/);
    expect(() => createDecay({ from: 0, velocity: -Infinity })).toThrow(/velocity/);
  });
});

// ─── D4 — matchMedia / reduced-motion CHARACTER-switch (строки 110, 112) ─────────

describe('D4 matchMedia reduced-motion (строки 110, 112)', () => {
  const mql = (matches: boolean): MediaQueryList => ({ matches } as MediaQueryList);

  it('matchMedia(reduce)=true → reduced: valueAt=rest, velocityAt=0, isSettledAt=true', () => {
    // Мутант 110 `if(true)` (всегда non-function) → reduced всегда false. Здесь valid
    // функция вернула true → reduced=true. Оракул на reduced-поведение кусает 110.
    const d = createDecay({ from: 0, velocity: 100, matchMedia: () => mql(true) });
    expect(d.reduced).toBe(true);
    expect(d.valueAt(0)).toBe(d.rest);
    expect(d.valueAt(999)).toBe(d.rest);
    expect(d.velocityAt(5)).toBe(0);
    expect(d.isSettledAt(0)).toBe(true);
  });

  it('query-строка точна: mock матчит ТОЛЬКО "(prefers-reduced-motion: reduce)" (112)', () => {
    // Мутант 112 `''`: matchMedia('') → mock видит q≠точный запрос → matches=false →
    // reduced=false. Здоровый шлёт точный запрос → matches=true → reduced=true.
    const d = createDecay({
      from: 0,
      velocity: 100,
      matchMedia: (q) => mql(q === '(prefers-reduced-motion: reduce)'),
    });
    expect(d.reduced).toBe(true); // мутант '' дал бы false
  });

  it('matchMedia=undefined → reduced=false (SSR): анимируется нормально', () => {
    const d = createDecay({ from: 0, velocity: 100 });
    expect(d.reduced).toBe(false);
    expect(d.valueAt(0)).toBeCloseTo(0, 6); // старт = from, не rest
  });

  it('matchMedia бросает → graceful reduced=false (catch-ветка, строки 113-115)', () => {
    // Покрывает try/catch в prefersReducedMotion: бросающий matchMedia не роняет
    // createDecay, трактуется как «нет предпочтения». Мутант `return false`→`true`
    // в catch дал бы reduced=true. Закрывает класс «хрупкий matchMedia не ломает движок».
    const d = createDecay({
      from: 0,
      velocity: 100,
      matchMedia: () => { throw new Error('matchMedia недоступен'); },
    });
    expect(d.reduced).toBe(false);
    expect(d.valueAt(0)).toBeCloseTo(0, 6); // анимируется (не снапнут в rest)
  });
});

// ─── Документированные ЭКВИВАЛЕНТНЫЕ / НЕДОСТИЖИМЫЕ мутанты ──────────────────────
//
// Не гоняются (Goodhart). decay — closed-form, потому ряд защитных short-circuit'ов
// даёт тот же результат, что и формула без них:
//   • 199:9 (clampT `t<=0`→`t<0`): при t=0 обе ветки дают 0 (`<=0`→return 0; `<0`→
//     0<0 false→return t=0). Для t<0 обе дают 0. Эквивалент (различие только в точке
//     t=0, где обе возвращают 0).
//   • 205:9 (valueAt `ct===Infinity`→rest): short-circuit. Без него ct=∞ →
//     decayFactor=1−e^(−∞/tc)=1−0=1 → raw=from+amp = rest. Тот же результат. Эквивалент.
//   • 213:9 (velocityAt `ct===Infinity`→0): без него (amp/tc)·e^(−∞/tc)=(amp/tc)·0=0.
//     Тот же результат. Эквивалент.
//   • 219:9 (isSettledAt `amplitude===0`→true): при amp=0 velocityAt=0 → 0<=restDelta
//     (restDelta>=0 валидирован) → true. Тот же результат. Эквивалент.
//   • 220:12 (isSettledAt `<=restDelta`→`<`): различие только при |velocity|==restDelta
//     ровно (мера-0 в непрерывной экспоненте; недостижимо детерминированной точкой).
//   • 110-if(false) (пропуск typeof-guard): non-function matchMedia → вызов бросает →
//     catch → false; тот же результат, что guard-return false. Эквивалент (if(true)
//     убит D4 reduced-тестом; if(false) — нет).
//   • 113:11 (catch BlockStatement — удаление тела `return false`): пустой catch →
//     prefersReducedMotion возвращает undefined → `if(reduced)` falsy → reduced=false,
//     тот же результат, что `return false`. Эквивалент (Boolean `false`→`true` в catch
//     УБИТ D4 throwing-matchMedia тестом; удаление тела — undefined, тоже falsy).
//   • 132:10 / 181:43 (`ampRaw>0`→`>=0` в clampAmplitude/rest-fallback): достижимы
//     ТОЛЬКО при ±Infinity (ampRaw=0 конечно → 131 возвращает раньше; from+amp=0 конечно
//     → finiteOr возвращает раньше). `>0` и `>=0` совпадают на ±Inf. Эквивалент.
//   • 163:5 / 167:5 / 173:5 (`options.knob !== undefined` в accept-guard): ИЗБЫТОЧЕН с
//     `Number.isFinite(knob)` — isFinite(undefined)=false и так дефолтит. `!==undefined`→
//     true даёт тот же результат (isFinite ловит undefined). Эквивалент.
//   • 173:5 LogicalOperator `(A&&B)` → `(A||B)` (A=!==undefined, B=isFinite): при A=false
//     (undefined) B=isFinite(undefined)=false тоже → `A||B`=false, как `A&&B`. Различия нет
//     (A false ⟹ B false). Эквивалент. (Второй Logical `||C` — УБИТ D2 restDelta=-1.)
describe('документированные эквиваленты decay (обоснование, не театр)', () => {
  it('clampT/Infinity-short-circuit: valueAt(∞)=rest, velocityAt(∞)=0 без спец-ветки (205,213)', () => {
    // Характеризация: результат в пределе t→∞ совпадает со short-circuit.
    const d = createDecay({ from: 10, velocity: 100 });
    expect(d.valueAt(Infinity)).toBe(d.rest);
    expect(d.velocityAt(Infinity)).toBe(0);
    expect(d.valueAt(0)).toBeCloseTo(10, 6); // t<=0 → from
    expect(d.valueAt(-5)).toBeCloseTo(10, 6);
  });
  it('isSettledAt при amplitude=0 (velocity=0) → true в любой точке (219)', () => {
    const d = createDecay({ from: 5, velocity: 0 }); // amp=0
    expect(d.isSettledAt(0)).toBe(true);
    expect(d.rest).toBeCloseTo(5, 6); // rest=from при amp=0
  });
});
