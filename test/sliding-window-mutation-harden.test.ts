/**
 * test/sliding-window-mutation-harden.test.ts — S42: закалка mutation-покрытия
 * internal/sliding-window.ts (общий трим окна для оценщиков скорости).
 *
 * Baseline Stryker: 70.83% (6 выживших). Крошечный чистый модуль (trimSlidingWindow)
 * → оракулы прямые на выходном массиве. Правило: ≥2 сэмплов в окне → мерим по окну;
 * <2 → держим последнюю пару (честная средняя через разрыв, не ложный ноль).
 *
 * Закрываемые КЛАССЫ:
 *   S1 пустой вход (18: if(n===0)) — без n===0-гарда samples[-1].t бросок.
 *   S2 граница cutoff (21:19: `.t < cutoff` строгое) — сэмпл ровно на cutoff остаётся.
 *   S3 sparse-фоллбек (22:33: Math.max, не min) — при <2 в окне держим ПОСЛЕДНЮЮ ПАРУ.
 *   S4 общая корректность: ≥2 в окне → старьё долой.
 *
 * Единственный истинный эквивалент — 22:16 (`>=2`↔`>2`) — в блоке внизу с обоснованием.
 * (21:10 `k<n`-guard — НЕ эквивалент: OOB-защита, УБИТ S5 отрицательным window.)
 */

import { describe, expect, it } from 'vitest';
import {
  advanceSlidingWindow,
  trimSlidingWindow,
  type TimedSample,
} from '../src/internal/sliding-window.js';

/** Массив таймстемпов → сэмплы. */
const s = (...ts: number[]): TimedSample[] => ts.map((t) => ({ t }));
/** Извлечь таймстемпы результата. */
const ts = (arr: readonly TimedSample[]): number[] => arr.map((x) => x.t);

// ─── S1 — пустой вход (строка 18) ───────────────────────────────────────────────

describe('S1 пустой вход (строка 18: if n===0)', () => {
  it('trimSlidingWindow([], w) → [] (без гарда samples[-1].t бросил бы)', () => {
    // Мутант 18 `if(false)`: n=0 → пропуск раннего return → cutoff=samples[-1].t →
    // undefined.t → TypeError. Оракул на пустой результат кусает.
    expect(trimSlidingWindow([], 1)).toEqual([]);
  });
});

// ─── S2 — граница cutoff строгая (строка 21:19) ─────────────────────────────────

describe('S2 граница cutoff: `.t < cutoff` строгое (строка 21:19)', () => {
  it('сэмпл ровно на cutoff ОСТАЁТСЯ (t=0..4, window=2 → cutoff=2 → держим t≥2)', () => {
    // cutoff = 4-2 = 2. Здоровый: t=2 НЕ < 2 → k останавливается на 2 → from=2 →
    // [2,3,4] (граничный t=2 в окне). Мутант `<=`: t=2 <= 2 → k=3 → from=3 → [3,4]
    // (граничный t=2 выброшен). Оракул на присутствие t=2 кусает.
    expect(ts(trimSlidingWindow(s(0, 1, 2, 3, 4), 2))).toEqual([2, 3, 4]);
  });
});

// ─── S3 — sparse-фоллбек держит ПОСЛЕДНЮЮ ПАРУ (строка 22:33 Math.max) ───────────

describe('S3 sparse (<2 в окне) → последняя пара, не всё (строка 22:33)', () => {
  it('редкие события: только последний в окне → держим ПОСЛЕДНИЕ ДВА', () => {
    // s(0,1,10), window=1 → cutoff=9. k: 0<9,1<9 → k=2 (t=10 не <9). n-k=1 <2 →
    // from = Math.max(0, n-2)=max(0,1)=1 → [1,10] (последняя пара для честной скорости).
    // Мутант 22:33 Math.min: from=min(0,1)=0 → [0,1,10] (всё старьё). Оракул на длину=2.
    const r = trimSlidingWindow(s(0, 1, 10), 1);
    expect(ts(r)).toEqual([1, 10]); // ровно последняя пара (мутант min дал бы [0,1,10])
  });
  it('одиночный сэмпл: n=1 → возвращается он сам (from=max(0,-1)=0)', () => {
    expect(ts(trimSlidingWindow(s(5), 1))).toEqual([5]);
  });
});

// ─── S4 — общая корректность окна ───────────────────────────────────────────────

describe('S4 общая корректность: ≥2 в окне → старьё долой', () => {
  it('плотные события: держим только то, что в окне', () => {
    // s(0,1,2,3), window=1.5 → cutoff=1.5. k: 0<1.5,1<1.5 → k=2 (t=2 не <1.5). n-k=2 →
    // from=2 → [2,3] (в пределах 1.5 от t=3).
    expect(ts(trimSlidingWindow(s(0, 1, 2, 3), 1.5))).toEqual([2, 3]);
  });
  it('исходный массив НЕ мутируется (slice, не splice)', () => {
    const input = s(0, 1, 2, 3);
    trimSlidingWindow(input, 1.5);
    expect(input.length).toBe(4); // исходник цел
  });
});

// ─── S5 — враждебный отрицательный window: guard k<n защищает от OOB (строка 21:10) ──

describe('S5 отрицательный window: k<n-guard отсекает OOB-чтение (строка 21:10)', () => {
  it('trimSlidingWindow(s(0,1,2,3), -1) → [2,3] без броска (нота QA)', () => {
    // При window<0: cutoff = 3−(−1) = 4 → ВСЕ сэмплы < cutoff → k доходит до n=4.
    // Здоровый `k<n`: k=4 → 4<4 ложь → стоп → from=max(0,n−2)=2 → [2,3] (последняя пара).
    // Мутанты 21:10 `k<n`→`true`/`<=n`: k=4 → читают samples[4]=undefined → `.t` бросок.
    // Guard k<n — НЕ мёртвый (нота QA-ревью): это OOB-защита, load-bearing на этом входе.
    expect(ts(trimSlidingWindow(s(0, 1, 2, 3), -1))).toEqual([2, 3]);
  });
  it('NaN window: тоже без OOB-броска', () => {
    // cutoff = 3−NaN = NaN → samples[k].t < NaN всегда ложь → k=0 → from=n−2=2 (n≥2).
    expect(() => trimSlidingWindow(s(0, 1, 2, 3), NaN)).not.toThrow();
  });
});

// ─── Документированные ЭКВИВАЛЕНТНЫЕ / НЕДОСТИЖИМЫЕ мутанты ──────────────────────
//
// Не гоняются (Goodhart):
//   • 22:16 (`n - k >= 2` → `> 2`): различие только при n−k РОВНО 2, но там k===n−2
//     (по определению n−k=2), поэтому обе ветки дают from=k=Math.max(0,n−2)=n−2 —
//     ОДИНАКОВЫЙ slice. При n−k>2 обе ветки → from=k; при n−k<2 обе → else. Эквивалент.
//     (QA-differential по 13 враждебным входам — ноль расхождений, подтверждено.)
//   ПРИМЕЧАНИЕ: 21:10 (`k<n`-guard) РАНЬШЕ числился здесь как «недостижимый при
//   window≥0», но НЕ эквивалент — это OOB-защита, load-bearing при window<0 (нота QA):
//   без неё цикл читает samples[n]=undefined.t → бросок. УБИТ S5. Реальные потребители
//   (gestures/index.ts, scroll/index.ts) клампят window>0 до вызова, потому Stryker и
//   видел его выжившим — но юнит-контракт «hostile window не роняет» теперь запинён.
describe('документированные эквиваленты sliding-window (обоснование, не театр)', () => {
  it('n−k=2 ⟹ k=n−2: from совпадает у >=2 и >2 (обоснование 22:16)', () => {
    // Характеризация: при ровно 2 в окне from=k И from=max(0,n−2) дают один индекс.
    // s(0,1,2,3), window=1.5 → k=2, n=4, n−k=2, max(0,n−2)=2=k.
    const r = trimSlidingWindow(s(0, 1, 2, 3), 1.5);
    expect(ts(r)).toEqual([2, 3]); // from=2 при обоих порогах
  });
  it('последний сэмпл всегда в окне при window≥0 (характеризация окна)', () => {
    expect(ts(trimSlidingWindow(s(0, 100), 1))).toEqual([0, 100]); // <2 в окне → пара
    expect(ts(trimSlidingWindow(s(0, 1, 2), 1000))).toEqual([0, 1, 2]); // всё в окне
  });
});

describe('allocation-free cursor — дифференциальный пин', () => {
  it('на плотном и редком потоке даёт тот же логический срез, что чистый оракул', () => {
    for (const stream of [
      [0, 0.01, 0.02, 0.03, 0.2, 0.21],
      [0, 1, 10, 10.01, 20],
    ]) {
      const samples: TimedSample[] = [];
      let start = 0;
      for (const t of stream) {
        samples.push({ t });
        start = advanceSlidingWindow(samples, start, 0.1);
        expect(ts(samples.slice(start))).toEqual(ts(trimSlidingWindow(samples.slice(0), 0.1)));
      }
    }
  });

  it('при накопленном префиксе не возвращает уже вытесненные сэмплы', () => {
    const samples = s(0, 1, 10);
    const start = advanceSlidingWindow(samples, 0, 1);
    expect(ts(samples.slice(start))).toEqual([1, 10]);
    samples.push({ t: 10.5 });
    expect(ts(samples.slice(advanceSlidingWindow(samples, start, 1)))).toEqual([10, 10.5]);
  });
});
