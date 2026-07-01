/**
 * test/timeline-settle-contract.test.ts
 * Класс: А (unit/regression) — settle()/tick() API-контракт после merge-gate ревью PR #15.
 *
 * Закрывает 3 находки CodeRabbit на src/timeline/index.ts (commit a6b8a1f):
 *
 * 1. `time`/`progress` после settle(true) (explicit complete()/reduced-motion)
 *    должны читаться как totalDuration/1, а не застрявшее предыдущее `_vt`
 *    (баг: settle() эмитил snap-to-end, но не продвигал `_vt`).
 * 2. `_resolve()` обязан выполниться, даже если пользовательский onStep
 *    бросает исключение внутри settle() — иначе `await timeline` зависает.
 * 3. Ре-энтрантный guard `_tickActive` обязан сброситься даже если onStep
 *    бросает исключение внутри tick() — иначе повторная/дублирующая доставка
 *    кадра от адверсариального scheduler'а навсегда проглатывается (freeze).
 *
 * ── RED PROOF ──────────────────────────────────────────────────────────────
 * Тест 1/2: убрать `if (snapToEnd) _vt = _totalDuration;` из settle() →
 *   `time`/`progress` после complete() без предшествующего тика читаются
 *   как 0 → RED.
 * Тест 3: заменить `try { emit(emitT); } finally { _resolve(); }` на просто
 *   `emit(emitT); _resolve();` → при throwing onStep `_resolve()` не
 *   вызывается → `await tl` (в отдельном `.then` перехвате) никогда не
 *   разрешается → тест таймаутит → RED.
 * Тест 4: убрать `try { ... } finally { _tickActive = false; }` из tick() →
 *   после throw второй вызов того же callback'а (адверсариальная повторная
 *   доставка) молча проглатывается guard'ом → второй onStep не вызывается →
 *   RED.
 */

import { describe, expect, it } from 'vitest';
import { createTimeline } from '../src/timeline/index.js';

function noReduceMedia(): (query: string) => { matches: boolean } {
  return () => ({ matches: false });
}

function reduceMedia(): (query: string) => { matches: boolean } {
  return () => ({ matches: true });
}

function noRaf(): (cb: (ts?: number) => void) => number {
  return (_cb) => 0;
}

// ─── 1. explicit complete() до первого тика: time/progress контракт ─────────

describe('timeline settle-contract: time/progress после snap-to-end', () => {
  it('complete() до первого тика: time===totalDuration, progress===1', () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 5 }],
      matchMedia: noReduceMedia(),
      requestFrame: noRaf(),
    });

    // До первого тика _vt=0 — без фикса это осталось бы так после complete().
    expect(tl.time).toBe(0);
    tl.complete();

    expect(tl.time, 'time должен продвинуться к totalDuration после snap').toBe(
      tl.totalDuration,
    );
    expect(tl.progress, 'progress должен читаться как 1 после natural complete').toBe(1);
  });

  it('reduced-motion snap: time===totalDuration, progress===1 сразу в конструкторе', () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 50, duration: 3 }],
      matchMedia: reduceMedia(),
      requestFrame: noRaf(),
    });

    expect(tl.time).toBe(tl.totalDuration);
    expect(tl.progress).toBe(1);
  });
});

// ─── 2. onStep throws внутри settle(): promise обязан разрешиться ───────────

describe('timeline settle-contract: throwing onStep не блокирует resolve', () => {
  it('complete() с throwing onStep: promise всё равно разрешается', async () => {
    const tl = createTimeline({
      segments: [{ from: 0, to: 100, duration: 1 }],
      onStep: () => {
        throw new Error('boom — user callback throws');
      },
      matchMedia: noReduceMedia(),
      requestFrame: noRaf(),
    });

    // complete() пробрасывает исключение из пользовательского onStep —
    // это ожидаемо (ошибка не должна тихо проглатываться). Но _resolve()
    // ОБЯЗАН быть вызван до этого, иначе `await tl` ниже зависнет навсегда.
    expect(() => tl.complete()).toThrow('boom');

    // Промис должен быть уже разрешён (finally выполнился до throw) —
    // await не должен зависнуть.
    await tl;
  });
});

// ─── 3. tickActive-guard: throw не оставляет реентрантный флаг залипшим ─────

describe('timeline settle-contract: tickActive guard освобождается после throw', () => {
  it('throw в onStep во время нормального тика не блокирует повторную доставку кадра', () => {
    let calls = 0;
    let shouldThrow = false;
    const capturedCallbacks: Array<(ts?: number) => void> = [];

    // Адверсариальный scheduler: захватывает callback и позволяет тесту
    // вызывать его напрямую (эмулирует повторную/дублирующую доставку
    // кадра одним и тем же injected requestFrame — тот же класс риска,
    // что в test/drive-double-tick-guard.test.ts для drive()).
    const capturingClock = (cb: (ts?: number) => void): number => {
      capturedCallbacks.push(cb);
      return capturedCallbacks.length; // ненулевой handle — без setTimeout-fallback
    };

    createTimeline({
      segments: [{ from: 0, to: 100, duration: 100 }], // длинная — не завершится за 2 кадра
      onStep: () => {
        calls++;
        if (shouldThrow) throw new Error('boom — mid-tick throw');
      },
      matchMedia: noReduceMedia(),
      requestFrame: capturingClock,
    });

    // Первый кадр (bootstrap ensureLoop) заскейлен, но ещё НЕ вызван.
    expect(capturedCallbacks.length).toBe(1);
    const firstTick = capturedCallbacks[0]!;

    // Вызываем первый tick вручную — не бросает, реальный прогресс.
    firstTick(16);
    expect(calls).toBe(1);

    // tick() должен был запланировать следующий кадр (реальный reschedule).
    expect(capturedCallbacks.length).toBe(2);
    const secondTick = capturedCallbacks[1]!;

    // Второй тик — включаем throw.
    shouldThrow = true;
    expect(() => secondTick(32)).toThrow('boom — mid-tick throw');
    expect(calls).toBe(2);

    // Адверсариальная повторная доставка ТОГО ЖЕ callback'а (эмулирует
    // дублирующий вызов от нестабильного scheduler'а). Без finally-фикса
    // `_tickActive` остался бы true навсегда → `if (_tickActive) return;`
    // молча проглотил бы этот вызов → calls не увеличился бы.
    shouldThrow = false;
    secondTick(48);
    expect(calls, 'повторная доставка не должна быть молча проглочена залипшим guard').toBe(3);
  });
});

// ─── 4. endTime overflow (накопленный offset) не должен ломать ВЕСЬ timeline ─

describe('timeline settle-contract: endTime-overflow изолирован от нормальных сегментов', () => {
  it('overflow startTime+duration одного сегмента не коллапсирует totalDuration ВСЕХ сегментов в 0', () => {
    const MAX = Number.MAX_VALUE;
    const normalSteps: number[] = [];

    const tl = createTimeline({
      segments: [
        // Нормальный сегмент — должен честно тянуться 1 секунду.
        { from: 0, to: 100, duration: 1, onStep: (v) => normalSteps.push(v) },
        // offset у второго сегмента переполняет endTime (startTime≈MAX,
        // +duration → Infinity) даже при конечных from/to/duration.
        { from: 0, to: 10, duration: 1, offset: MAX },
      ],
      matchMedia: noReduceMedia(),
      requestFrame: noRaf(),
    });

    // Раньше (баг): endTime=Infinity → prevEndTime=Infinity → totalDuration
    // = Infinity → paranoia-clamp к 0 → ВЕСЬ таймлайн (вкл. нормальный
    // первый сегмент) мгновенно settle(true) при duration=1s без единого
    // промежуточного тика.
    expect(tl.totalDuration, 'totalDuration обязан остаться конечным, не 0').toBeGreaterThan(0);
    expect(Number.isFinite(tl.totalDuration)).toBe(true);

    // Нормальный сегмент должен честно эмитить промежуточное значение при
    // seek на середину его собственной длительности — НЕ мгновенный snap.
    tl.seek(0.5);
    const mid = normalSteps.at(-1);
    expect(mid, 'нормальный сегмент должен tween-ить, а не мгновенно settle').toBeCloseTo(50);

    tl.cancel();
  });
});
