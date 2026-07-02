/**
 * test/motion-value-mutation-harden.test.ts — S39: закалка mutation-покрытия
 * ядра MotionValue (src/motion-value.ts).
 *
 * Baseline-замер Stryker: motion-value.ts = 64.97% (56 выживших). Первая волна
 * подняла до 72.32%; эта версия — до цели ≥80% через bounded-оракулы (≪ MAX_FRAMES).
 *
 * КРИТИЧНО (урок 1-й волны): MAX_FRAMES=2000 форс-снапает значение в цель на
 * строке 338 (converged). Оракул `drainAll()` докручивает туда → финал = цель
 * даже при мутации арифметики/clamp → мутант ВЫЖИВАЕТ. Поэтому оракулы направления
 * и границ проверяют ПРОМЕЖУТОЧНОЕ состояние на ОГРАНИЧЕННОМ окне кадров (≪ 2000),
 * где здоровый код уже у цели (STD сходится ~38, ζ=0.2 ~174), а мутант ещё застрял.
 *
 * Виртуальный клок инжектируется (manual rAF-очередь + ручной drain, handle>0 →
 * requestFrame-путь) → детерминизм: реального времени/rAF/setTimeout нет.
 *
 * Что каждый класс кусает — в описании describe. Выжившие-эквиваленты (не гоняются,
 * Goodhart) — в блоке `документированные эквиваленты…` внизу с обоснованием реальности.
 */

import { describe, expect, it, vi } from 'vitest';
import { MotionValue, type MotionValueOptions } from '../src/index.js';
import { MotionParamError } from '../src/index.js';

// ─── Хелперы ──────────────────────────────────────────────────────────────

/** STD: ζ≈0.707 (underdamped, слабый овершут), сходится ~38 кадров 0→100. */
const STD_SPRING: MotionValueOptions['spring'] = { mass: 1, stiffness: 200, damping: 20 };
/** Осцилляторная ζ=0.2 (пол демпфирования): 0→100 сходится ~174 кадра,
 *  но в 0.5% от цели уже с ~12-го кадра — зазор держит velocity-критерий. */
const OSC_SPRING: MotionValueOptions['spring'] = { mass: 1, stiffness: 100, damping: 4 };

function makeClock() {
  const q: Array<(ts?: number) => void> = [];
  let handle = 0;
  let t = 0;
  const requestFrame = (cb: (ts?: number) => void): number => {
    q.push(cb);
    return ++handle; // > 0 → requestFrame-путь ядра
  };
  const drain = (n = 1, dtMs = 1000 / 60): void => {
    for (let i = 0; i < n && q.length > 0; i++) {
      t += dtMs;
      q.shift()!(t);
    }
  };
  const drainAll = (max = 5000): void => {
    let i = 0;
    while (q.length > 0 && i++ < max) drain(1);
  };
  const step = (ts: number): void => {
    if (q.length > 0) q.shift()!(ts);
  };
  return { requestFrame, drain, drainAll, step, pending: (): number => q.length };
}

/** Сколько кадров до остановки цикла (running→false), окно ≤ max. */
function framesToSettle(spring: MotionValueOptions['spring'], from: number, to: number, max = 5000): number {
  const clock = makeClock();
  const mv = new MotionValue({ initial: from, spring, requestFrame: clock.requestFrame });
  mv.setTarget(to);
  let f = 0;
  while (clock.pending() > 0 && f < max) {
    clock.drain(1);
    f++;
  }
  return f;
}

/** Собирает все эмиссии onChange (первая — немедленная на подписке). */
function collect(mv: MotionValue): number[] {
  const out: number[] = [];
  mv.onChange((v) => out.push(v));
  return out;
}

// ─── T1 — направление range: target − from (строки 202→ин-тик 315) ──────────────

describe('T1 range = target − from, не target + from (строка 315)', () => {
  it('отрицательный range (50→10) реально движется к цели в ограниченном окне', () => {
    // Мутант `range = target + from` (315): range=60>0 → lo=from=50, hi=target=10 →
    // clamp[50,10]=Math.max(50,·)=50 → значение ЗАСТРЕВАЕТ на 50 (до MAX_FRAMES=2000).
    // Окно 45 кадров (STD сходится ~38): здоровый код у 10, мутант всё ещё 50.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 50, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(10);
    clock.drain(45);
    expect(mv.value).toBeLessThan(30); // прошло середину к 10 (мутант дал бы 50)
    expect(mv.value).toBeCloseTo(10, 2);
  });

  it('положительный range (10→50): промежуточные значения в [10,50], доезжает', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 10, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const seen = collect(mv);
    mv.setTarget(50);
    clock.drain(80);
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(v).toBeLessThanOrEqual(50 + 1e-9);
    }
    expect(mv.value).toBeCloseTo(50, 2);
  });
});

// ─── T2 — degenerate-range: |range|<1e-10 → немедленная сходимость (строка 334) ──

describe('T2 degenerate range → немедленная сходимость (строка 334)', () => {
  it('крошечный range (0 → 1e-11) сходится за 1 кадр, без многокадрового прогона', () => {
    // Мутант `(false) ||` (334): не короткозамыкает вырожденный range → прогон крутит
    // кадры (до MAX_FRAMES), очередь не опустевает за один тик.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(1e-11); // |range|=1e-11 < 1e-10
    expect(clock.pending()).toBe(1);
    clock.drain(1);
    expect(mv.value).toBe(1e-11);
    expect(clock.pending()).toBe(0); // сошёлся → не перепланировал
  });
});

// ─── T3 — сходимость требует И положение, И скорость (строки 335, 336) ──────────

describe('T3 сходимость требует И положение, И скорость (строки 335, 336)', () => {
  it('осцилляторная ζ=0.2: цикл живёт, пока скорость велика (не преждевременный снап)', () => {
    // ζ=0.2 (0→100): полная сходимость ~174 кадра держится velocity-критерием (336).
    // Замеренные мутанты, роняющие его:
    //   336 `< THRESH` → `true`  : сходимость по одному положению → 89 кадров (замер)
    //   336 `→ false`            : порог-ветка мертва → сходимость только по MAX_FRAMES → 2000
    //   335:23 Math.max→Math.min : знаменатель 1e-10 → отношение огромно → 2000
    //   335/336 `*` вместо `/`   : критерий в разы строже → сильно > 174
    // Окно [130, 400]: здоровый код 174 внутри; 89/2000 — снаружи (обе стороны кусаются).
    const n = framesToSettle(OSC_SPRING, 0, 100);
    expect(n).toBeGreaterThanOrEqual(130); // < 130 = velocity-критерий уронен (мутант 89)
    expect(n).toBeLessThanOrEqual(400); // > 400 = сходимость только по MAX_FRAMES (мутант 2000)
    // И действительно доезжает.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: OSC_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drainAll();
    expect(mv.value).toBeCloseTo(100, 3);
  });
});

// ─── T4 — clamp по знаку range (строки 348, 349) ───────────────────────────────

describe('T4 clamp-границы по знаку range: монотонный прогресс (строки 348, 349)', () => {
  it('90→10: старт близко к 90, к 15-му кадру ушёл к 10 (оба Conditional-мутанта клампа)', () => {
    // Замеры диверсий (STD 90→10): здоровый f3=82.9, f15=10.2.
    //   348 `lo = true ? from : target`  → clamp[90,90] → застревает: f3=90, f15=90.
    //   349 `hi = true ? target : from`  → clamp[10,10] → мгновенный снап: f3=10, f15=10.
    // Двойной оракул f3>70 И f15<70 кусает ОБА (стуча по противоположным сторонам).
    const clock = makeClock();
    const mv = new MotionValue({ initial: 90, spring: STD_SPRING, requestFrame: clock.requestFrame });
    const seen = collect(mv);
    mv.setTarget(10);
    clock.drain(3);
    expect(mv.value).toBeGreaterThan(70); // ещё у старта (мутант 349 снапнул бы в 10)
    clock.drain(12); // всего 15 кадров
    expect(mv.value).toBeLessThan(70); // ушёл к 10 (мутант 348 застрял бы на 90)
    clock.drainAll();
    expect(mv.value).toBeCloseTo(10, 2);
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(v).toBeLessThanOrEqual(90 + 1e-9);
    }
  });
});

// ─── T5 — no-op в покое + setTarget после destroy (строки 195, 187) ─────────────

describe('T5 setTarget: no-op в покое (195) и no-op после destroy (187)', () => {
  it('покоящийся MV: setTarget(текущее значение) не планирует кадр (195)', () => {
    // Мутант 195 `if (false)` / снятие блока: снап-guard не срабатывает → запуск цикла.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 7, spring: STD_SPRING, requestFrame: clock.requestFrame });
    expect(clock.pending()).toBe(0);
    mv.setTarget(7);
    expect(clock.pending()).toBe(0);
    expect(mv.value).toBe(7);
  });

  it('setTarget после destroy() — no-op: НЕ планирует кадр (строка 187)', () => {
    // Мутант 187 `if (false) return`: убирает destroyed-барьер → setTarget после
    // destroy запускает цикл (планирует кадр). Оракул: pending остаётся 0.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.destroy();
    mv.setTarget(100);
    expect(clock.pending()).toBe(0); // мутант дал бы 1
    expect(mv.value).toBe(0);
  });
});

// ─── T6 — double-loop guard: setTarget в полёте = один цикл (строка 218) ─────────

describe('T6 setTarget во время полёта не плодит второй цикл (строка 218)', () => {
  it('второй setTarget в полёте: очередь держит РОВНО один кадр (нет удвоения)', () => {
    // Мутант 218 `if (true)`: планирует первый кадр даже когда цикл уже бежит →
    // два живых цикла → удвоение тик-рейта.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(3);
    expect(clock.pending()).toBe(1);
    mv.setTarget(200);
    expect(clock.pending()).toBe(1); // мутант дал бы 2
    clock.drain(1);
    expect(clock.pending()).toBe(1);
  });
});

// ─── T7 — snapTo после destroy — no-op (строка 264) ─────────────────────────────

describe('T7 snapTo после destroy — no-op (строка 264)', () => {
  it('destroy(), затем snapTo(x): без эмиссий, значение не меняется', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 3, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let emits = 0;
    mv.onChange(() => { emits += 1; });
    const before = emits;
    mv.destroy();
    mv.snapTo(999);
    expect(emits).toBe(before);
    expect(mv.value).toBe(3);
  });
});

// ─── T8 — snapTo идемпотентность vs прерывание: три конъюнкта (строка 273) ───────

describe('T8 snapTo: конъюнкты guard-а идемпотентности (строка 273)', () => {
  it('в покое ровно на target: snapTo(target) — no-op БЕЗ emit', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 5, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let emits = 0;
    mv.onChange(() => { emits += 1; });
    const before = emits;
    mv.snapTo(5);
    expect(emits).toBe(before);
    expect(clock.pending()).toBe(0);
  });

  it('после stop@40 (running=false, value=40, _target=100): snapTo(100) НЕ no-op — снапает', () => {
    // Конъюнкт `this._value === target` (273:27): value(40)≠target(100) → guard=false →
    // snapTo снапает в 100. Мутант `... && true && ...` → все конъюнкты true → no-op →
    // значение застряло бы на 40. Также кусает 273:9 LogicalOperator (|| вместо &&).
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(3); // value в (0,100), running=true, _target=100
    mv.stop(); // running=false, value≈mid, _target=100 (не тронут)
    const mid = mv.value;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    mv.snapTo(100);
    expect(mv.value).toBe(100); // мутант 273:27/273:9 оставил бы mid
  });

  it('после stop@40: snapTo(40) НЕ no-op — прерывает (эмитит), т.к. _target(100)≠40', () => {
    // Конъюнкт `this._target === target` (273:53): _target(100)≠target(40) → guard=false →
    // snapTo эмитит. Мутант `... && true` → no-op → БЕЗ emit.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(3);
    mv.stop();
    const mid = mv.value;
    let emits = 0;
    mv.onChange(() => { emits += 1; }); // +1 немедленная (текущее mid)
    const before = emits;
    mv.snapTo(mid); // target === value(mid), НО _target(100) ≠ mid → не no-op → emit
    expect(emits).toBeGreaterThan(before); // мутант 273:53 не эмитил бы
  });
});

// ─── T9 — сообщения ошибок называют параметр (строки 136, 190, 267) ─────────────

describe('T9 сообщения ошибок называют невалидный параметр (136, 190, 267)', () => {
  it('constructor: не-конечный initial → сообщение содержит "initial"', () => {
    expect(() => new MotionValue({ initial: NaN, spring: STD_SPRING })).toThrow(/initial/);
  });
  it('setTarget: не-конечный target → сообщение содержит "target"', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: makeClock().requestFrame });
    expect(() => mv.setTarget(Infinity)).toThrow(/target/);
  });
  it('snapTo: не-конечный target → сообщение содержит "snapTo"', () => {
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: makeClock().requestFrame });
    expect(() => mv.snapTo(NaN)).toThrow(/snapTo/);
  });
});

// ─── T10 — tick-guard после stop: устаревший кадр не эмитит (строка 301/300) ─────

describe('T10 stop() глушит уже запланированный кадр', () => {
  it('stop() при живом кадре: слив НЕ эмитит и НЕ перепланирует', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(2);
    expect(clock.pending()).toBe(1);
    let emits = 0;
    mv.onChange(() => { emits += 1; });
    const before = emits;
    mv.stop();
    clock.drainAll();
    expect(emits).toBe(before);
    expect(clock.pending()).toBe(0);
  });
});

// ─── T11 — timestamp-путь elapsed: (ts − startTs)/1000 (строки 306, 308) ────────

describe('T11 timestamp-путь: elapsed = (ts − startTs)/1000 (306, 308)', () => {
  it('большой ts-скачок (1s) продвигает пружину далеко — кусает 306 (if false → fixed-dt)', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.step(1000); // startTs=1000, elapsed=0
    clock.step(2000); // elapsed=1.0s → сошлась
    expect(mv.value).toBeGreaterThan(90);
  });

  it('малый ts-шаг оставляет пружину в начале — кусает 308 ((ts+startTs))', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.step(1000);
    clock.step(1000 + 1000 / 60); // elapsed≈0.0167s → едва стартовала
    expect(mv.value).toBeLessThan(50); // мутант + дал бы ≈100
    expect(mv.value).toBeGreaterThanOrEqual(0);
  });
});

// ─── T12 — post-emit re-entrancy: stop/setTarget из onChange (строка 374) ───────

describe('T12 post-emit guard: stop+setTarget из onChange не удваивает цикл (строка 374)', () => {
  it('stop() затем setTarget() из onChange: устаревший кадр НЕ перепланируется поверх нового', () => {
    // ЭТО убивает 374 (в отличие от простого stop, где !running доминирует).
    // Из onChange зовём stop() (gen++, running=false) ЗАТЕМ setTarget (running=true,
    // новый первый кадр, НОВАЯ generation). Старый тик на пост-emit барьере 374:
    //   `gen(old) !== generation(new)` = true → return (старый кадр НЕ перепланируется).
    // Мутант `false || !running || destroyed` = F||F||F = F → старый ТОЖЕ планирует →
    // два кадра (старый+новый) → удвоение. Оракул: ровно один кадр в очереди.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let fired = false;
    mv.onChange(() => {
      if (!fired && mv.value > 0) {
        fired = true;
        mv.stop();          // gen++, running=false
        mv.setTarget(200);  // running=true снова, новый первый кадр (новая gen)
      }
    });
    mv.setTarget(100);
    clock.drain(2); // кадр 2 эмитит (value>0) → колбэк stop()+setTarget()
    expect(clock.pending()).toBe(1); // РОВНО один (мутант дал бы 2)
  });

  it('простой stop() из onChange: мёртвый ран не перепланируется (нет лишнего кадра)', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let stopped = false;
    mv.onChange(() => {
      if (!stopped && mv.value > 0) { stopped = true; mv.stop(); }
    });
    mv.setTarget(100);
    clock.drain(2);
    expect(clock.pending()).toBe(0);
  });
});

// ─── T13 — smooth-pickup: непрерывность значения на ретаргете (строка 206) ──────

describe('T13 smooth-pickup: значение непрерывно на ретаргете в полёте', () => {
  it('ретаргет в полёте: без скачка значения (характеризация непрерывности)', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(6);
    const vBefore = mv.value;
    expect(vBefore).toBeGreaterThan(0);
    expect(vBefore).toBeLessThan(100);
    mv.setTarget(200);
    clock.drain(1);
    expect(Math.abs(mv.value - vBefore)).toBeLessThan(20); // плавно, без разрыва
    clock.drainAll();
    expect(mv.value).toBeCloseTo(200, 2);
  });
});

// ─── T14 — default requestFrame: rAF ↔ setTimeout-фоллбек (строки 149, 150) ─────

describe('T14 default requestFrame: глобальный rAF ↔ setTimeout-фоллбек (150)', () => {
  it('без инжектированного requestFrame + глобальный rAF есть → используется он', () => {
    // Мутант 150 `if (false)`: пропускает rAF-ветку → setTimeout, глобальный не зван.
    const orig = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    let called = 0;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
      (cb: (ts?: number) => void): number => { called += 1; void cb; return 42; };
    try {
      const mv = new MotionValue({ initial: 0, spring: STD_SPRING }); // без requestFrame
      mv.setTarget(100);
      expect(called).toBeGreaterThan(0); // rAF-ветка исполнена
      mv.destroy();
    } finally {
      if (orig === undefined) delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      else (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = orig;
    }
  });

  it('без глобального rAF → setTimeout-фоллбек, setTarget НЕ бросает', () => {
    // Мутант 150 `if (true)` / строковые: пытается вызвать undefined requestAnimationFrame
    // → бросок. Здоровый код в отсутствие rAF идёт по setTimeout. Fake-timers держат
    // отложенный колбэк под контролем (без утечки реального таймера).
    const orig = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    vi.useFakeTimers();
    try {
      const mv = new MotionValue({ initial: 0, spring: STD_SPRING }); // без requestFrame
      expect(() => mv.setTarget(100)).not.toThrow();
      mv.destroy();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      if (orig !== undefined) (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = orig;
    }
  });
});

// ─── T15 — finite-net RV-ветка: overflow не рождает осцилляцию эмиссий (356, 359, 360) ──

describe('T15 finite-net: overflow rawVelocity → чистая сходимость, не осцилляция (356)', () => {
  it('range=1e308: сходится за единицы эмиссий (не 175-кадровая осцилляция вокруг цели)', () => {
    // Замер диверсии: здоровый код ловит overflow rawVelocity сетью (356) → снап в
    // target за 4 эмиссии. Мутанты сети (356 `if(false)` / `||→&&` / пустой блок 356:74;
    // 359/360 не-стоп в теле) → сеть не срабатывает → 175 эмиссий (rawValue осциллирует
    // вокруг 1e308, пока не поймает другой критерий). Оракул на СЧЁТЧИК эмиссий: per-
    // emission finiteness не кусает (clampedValue всегда конечен), а число эмиссий — да.
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: OSC_SPRING, requestFrame: clock.requestFrame });
    let emits = 0;
    mv.onChange((v) => { emits += 1; expect(Number.isFinite(v)).toBe(true); });
    mv.setTarget(1e308);
    clock.drainAll();
    expect(mv.value).toBe(1e308);
    expect(emits).toBeLessThan(20); // здоровый 4; мутант сети ~175
  });
});

// ─── T16 — v0-нормализация: деление на range, не умножение (строка 206:52) ──────

describe('T16 smooth-pickup: v0 = velocity / range, не * range (строка 206:52)', () => {
  it('ретаргет в полёте не раздувает число кадров сходимости (замер: 44 vs мутант 105)', () => {
    // Мутант `currentVelocity * range` (206:52): нормализованная v0 раздута на range² →
    // огромная скорость в солвер → лишняя осцилляция/перелёт → сходимость за БОЛЬШЕ
    // кадров. Замер эмиссий: здоровый 44, мутант 105. Оракул: < 70 (первая пост-ретаргет
    // эмиссия у обоих = 38.6, т.к. первый тик elapsed=0 → дискриминатор = число эмиссий).
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    let emits = 0;
    mv.onChange(() => { emits += 1; });
    mv.setTarget(100);
    clock.drain(6); // набрали скорость
    mv.setTarget(200); // ретаргет с переносом скорости
    clock.drainAll();
    expect(mv.value).toBeCloseTo(200, 2);
    expect(emits).toBeLessThan(70); // здоровый 44; мутант * дал бы 105
  });
});

// ─── T17 — recovery после overflow-снапа: MotionValue не кирпичится (359, 360) ──

describe('T17 overflow-снап оставляет MotionValue возобновляемым (359, 360)', () => {
  it('после снапа сети (1e308) setTarget(0) возобновляет анимацию к новой цели', () => {
    // Сеть (356) при overflow снапает в target и ставит _running=false, _tickActive=false —
    // чтобы последующий setTarget возобновил цикл. Мутанты тела сети (359 `_running=true`,
    // 360 `_tickActive=true`) оставляют флаг взведённым → возобновлённый цикл мёртв
    // (setTarget не стартует по 218 / первый тик глохнет на _tickActive-guard 302). Замер
    // диверсии: здоровый afterResume=0, оба мутанта = 1e308 (застряли).
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: OSC_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(1e308); // сеть срабатывает (overflow rawVelocity) → снап в 1e308
    clock.drainAll();
    expect(mv.value).toBe(1e308);
    mv.setTarget(0); // возобновление
    clock.drainAll();
    expect(mv.value).toBeLessThan(1e307); // ушёл к 0 (мутанты 359/360 застряли бы на 1e308)
  });
});

// ─── Документированные ЭКВИВАЛЕНТНЫЕ / НЕДОСТИЖИМЫЕ / ЗАМАСКИРОВАННЫЕ мутанты ────
//
// Выжившие, НЕ убиваемые поведенчески — не меняют наблюдаемого поведения (Goodhart:
// score не гоняется до 100% театром). Каждый — с обоснованием реальности; стражи-
// ассерты фиксируют инвариант, на котором стоит эквивалентность (характеризация:
// если инвариант сдвинется — покраснеют, заставив пересмотреть классификацию).
//
//   • 195:35 (velocity-конъюнкт снап-guard): value===target достижимо ТОЛЬКО в
//     сходимости (clamp не даёт value достичь target раньше), где скорость уже ~0 →
//     ветка `|velocity|<1e-10` неотличима. Недостижимая комбинация.
//   • 202:19 (setTarget: range=target−value для v0) / 206:26 (guard Math.abs(range)>1e-10):
//     влияют на нормализованную v0 в setTarget (не на тик-range 315, что убит T1). Различие
//     СУБКРИТИЧНО наблюдаемо (Δ~1 эмиссия на промежуточном кадре, замер QA: 44 vs 45), НЕ
//     «нет различия» — но пинуется лишь хрупким exact-value/snapshot-оракулом на точный
//     транзиент (characterization-запашок, ломается от любого рефактора солвера). Оставлены
//     документированными ОСОЗНАННО: сигнал на 2 порядка слабее убитых (T16 206:52 = 44 vs 105).
//     (206:52 `/`→`*` — УБИТ T16 по счётчику эмиссий; не эквивалент.)
//   • 247:5 / 274:5 (_generation ++ ↔ --): generation сравнивается ТОЛЬКО через
//     `!==` (строки 300, 374), не на порядок → любое изменение инвалидирует кадр.
//   • 232:21 (_running=false→true в destroy): замаскирован — destroy ставит и
//     _destroyed=true, тик-барьер 301 глохнет по _destroyed независимо от _running.
//     (359/360 в теле finite-net — УБИТЫ T17 по recovery-после-overflow; не эквиваленты.)
//   • 113:42 (_useTimeoutFallback=false→true): перезаписывается в setTarget (215)
//     до первого чтения.
//   • 301:9 / 302:9 / 303:24 (tick-guard/_tickActive): избыточно-защитные. stop/snapTo
//     бампят generation → устаревший кадр ловится стражем 300 (не 301). destroy НЕ бампит
//     generation — его кадр глохнет через _listeners.clear() (пустой _emit) + reschedule-
//     guard 374 (`!_running`), а не через 301. single-flight _tickActive недостижим в
//     requestFrame-пути (нет синхронной ре-энтранси; клок сливает по одному кадру).
//   • 313:5 / 332:7 (frameCount++ / MAX_FRAMES-терм): MAX_FRAMES=2000 — предохранитель,
//     недостижимый для ВАЛИДНЫХ пружин (валидатор ω0≥2, ζ∈[0.2,4] гарантирует
//     сходимость по порогу задолго до 2000; замер: ζ=0.2 сходится за 174).
//   • 334:8 / 335:8 / 336:9 (Equality `<`↔`<=`): границы порога — различие лишь в
//     точке строгого равенства (мера-0), не наблюдаемо.
//   • 348:16 / 349:16 (Equality `>=`↔`>`): эквивалентны при range===0, а этот случай
//     недостижим — absRange<1e-10 короткозамыкает сходимость (строка 334) ДО clamp.
//   • 356 finite-net: НЕ эквивалент как целое — условие/тело/359/360 УБИТЫ T15 (счётчик
//     эмиссий при overflow: 4 vs 175) и T17 (recovery после overflow-снапа). Единственная
//     defensive-неубиваемость — под-операнд `!Number.isFinite(clampedValue)`: clamp к
//     конечным [from,target] всегда конечен, потому этот операнд ВСЕГДА false (проверено:
//     удаление только его оставляет T15 зелёным — RV-операнд ловит всё). Stryker не
//     генерит его отдельным выжившим мутантом (мутации 356 — if/logical — убиты T15).
describe('документированные эквиваленты/недостижимые (обоснование, не театр)', () => {
  it('gen++ vs gen-- (247,274): любое изменение generation инвалидирует устаревший кадр', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(2);
    let emits = 0;
    mv.onChange(() => { emits += 1; });
    const before = emits;
    mv.stop();
    clock.drainAll();
    expect(emits).toBe(before); // глохнет при ЛЮБОМ знаке изменения gen
  });

  it('_running замаскирован _destroyed (232,301): после destroy тик не проходит по destroyed-ветке', () => {
    const clock = makeClock();
    const mv = new MotionValue({ initial: 0, spring: STD_SPRING, requestFrame: clock.requestFrame });
    mv.setTarget(100);
    clock.drain(2);
    let emits = 0;
    mv.onChange(() => { emits += 1; });
    const before = emits;
    mv.destroy();
    clock.drainAll();
    expect(emits).toBe(before);
  });
});
