/**
 * test/gestures-velocity-press.test.ts
 * Классы: А (unit state-machine) + В (property/fuzz finiteness) + Д (mutation-proof в комментариях).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Тесты написаны ДО реализации: на стабе (пустые машины состояний) падают
 * все поведенческие блоки — отсутствующее поведение, не ошибка компиляции.
 * Mutation-proof: убрать guard деления на ноль в velocity() → фузз-тест
 * «идентичные timestamps» ловит NaN → RED.
 */

import { describe, expect, it } from 'vitest';
import { createVelocityTracker, createPress } from '../src/gestures/index.js';

// ─── createVelocityTracker ────────────────────────────────────────────────────

describe('gestures/velocity: линейный поток', () => {
  it('равномерное движение 100px за 0.1s → vx=1000 px/s', () => {
    const vt = createVelocityTracker();
    for (let i = 0; i <= 10; i++) vt.push({ x: i * 10, y: 0, t: i * 0.01 });
    expect(vt.velocity().vx).toBeCloseTo(1000, 0);
    expect(vt.velocity().vy).toBeCloseTo(0, 5);
  });

  it('движение по y → vy, vx=0', () => {
    const vt = createVelocityTracker();
    for (let i = 0; i <= 10; i++) vt.push({ x: 0, y: -i * 5, t: i * 0.01 });
    expect(vt.velocity().vy).toBeCloseTo(-500, 0);
    expect(vt.velocity().vx).toBeCloseTo(0, 5);
  });

  it('окно: сэмплы старше window отбрасываются (скорость по последнему отрезку)', () => {
    const vt = createVelocityTracker(0.1);
    // Старый медленный отрезок (вне окна), затем быстрый
    vt.push({ x: 0, y: 0, t: 0 });
    vt.push({ x: 1, y: 0, t: 0.5 });     // медленно: 2 px/s
    vt.push({ x: 1, y: 0, t: 0.95 });
    vt.push({ x: 101, y: 0, t: 1.0 });   // быстро: 100px за 0.05s
    expect(vt.velocity().vx).toBeGreaterThan(500); // старый отрезок не размывает
  });

  it('0 или 1 сэмпл → нулевая скорость', () => {
    const vt = createVelocityTracker();
    expect(vt.velocity()).toEqual({ vx: 0, vy: 0 });
    vt.push({ x: 5, y: 5, t: 1 });
    expect(vt.velocity()).toEqual({ vx: 0, vy: 0 });
  });

  // Класс: разреженные события (реже окна) НЕ схлопываются в один сэмпл —
  // скорость через разрыв = честная средняя, а не ложный 0.
  it('сэмплы реже окна → скорость по разрыву, не 0', () => {
    const vt = createVelocityTracker(0.1);
    vt.push({ x: 0, y: 0, t: 0 });
    vt.push({ x: 750, y: 0, t: 0.5 }); // разрыв 0.5s > окна 0.1s
    expect(vt.velocity().vx).toBeCloseTo(1500, 0);
  });

  it('reset() → нулевая скорость', () => {
    const vt = createVelocityTracker();
    vt.push({ x: 0, y: 0, t: 0 });
    vt.push({ x: 10, y: 0, t: 0.01 });
    vt.reset();
    expect(vt.velocity()).toEqual({ vx: 0, vy: 0 });
  });

  // Класс: деление на ноль — идентичные timestamps НЕ дают NaN.
  it('идентичные timestamps → конечная скорость (0), не NaN', () => {
    const vt = createVelocityTracker();
    vt.push({ x: 0, y: 0, t: 1 });
    vt.push({ x: 100, y: 50, t: 1 });
    const v = vt.velocity();
    expect(Number.isFinite(v.vx)).toBe(true);
    expect(Number.isFinite(v.vy)).toBe(true);
  });

  // Класс В: fuzz finiteness — злые входы (NaN/∞/overflow-края) не дают NaN/∞.
  it('fuzz 2000 злых потоков → скорость всегда конечна', () => {
    let s = 12345;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const evil = [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, 0, -0, 1e-300];
    for (let run = 0; run < 2000; run++) {
      const vt = createVelocityTracker();
      const n = 2 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const pick = (): number => (rnd() < 0.3 ? evil[Math.floor(rnd() * evil.length)] : (rnd() - 0.5) * 1e4);
        vt.push({ x: pick(), y: pick(), t: rnd() < 0.2 ? evil[Math.floor(rnd() * evil.length)] : run + i * 0.01 });
      }
      const v = vt.velocity();
      expect(Number.isFinite(v.vx)).toBe(true);
      expect(Number.isFinite(v.vy)).toBe(true);
    }
  });
});

// ─── createPress ──────────────────────────────────────────────────────────────

function pressLog() {
  const log: string[] = [];
  return {
    log,
    opts: {
      onPressStart: () => log.push('start'),
      onPress: () => log.push('press'),
      onPressCancel: () => log.push('cancel'),
    },
  };
}

describe('gestures/press: pointer state machine', () => {
  it('down → up в пределах slop = press', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.pointerDown({ x: 10, y: 10, t: 0 });
    p.pointerUp({ x: 11, y: 11, t: 0.1 });
    expect(log).toEqual(['start', 'press']);
  });

  it('движение дальше slop (3px) → cancel, up после не даёт press', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.pointerDown({ x: 0, y: 0, t: 0 });
    p.pointerMove({ x: 10, y: 0, t: 0.05 });
    p.pointerUp({ x: 10, y: 0, t: 0.1 });
    expect(log).toEqual(['start', 'cancel']);
  });

  it('движение РОВНО на slop не отменяет (граница: cancel строго > slop)', () => {
    const { log, opts } = pressLog();
    const p = createPress({ ...opts, slop: 3 });
    p.pointerDown({ x: 0, y: 0, t: 0 });
    p.pointerMove({ x: 3, y: 0, t: 0.05 });
    p.pointerUp({ x: 3, y: 0, t: 0.1 });
    expect(log).toEqual(['start', 'press']);
  });

  it('pointerCancel → cancel', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.pointerDown({ x: 0, y: 0, t: 0 });
    p.pointerCancel();
    expect(log).toEqual(['start', 'cancel']);
  });

  it('pressing-флаг отражает состояние', () => {
    const p = createPress();
    expect(p.pressing).toBe(false);
    p.pointerDown({ x: 0, y: 0, t: 0 });
    expect(p.pressing).toBe(true);
    p.pointerUp({ x: 0, y: 0, t: 0.1 });
    expect(p.pressing).toBe(false);
  });

  it('up без down — тихий no-op', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.pointerUp({ x: 0, y: 0, t: 0 });
    p.pointerMove({ x: 5, y: 5, t: 0.1 });
    expect(log).toEqual([]);
  });
});

describe('gestures/press: keyboard accessibility (Enter/Space)', () => {
  it('keyDown Enter → start; keyUp Enter → press', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.keyDown('Enter');
    p.keyUp('Enter');
    expect(log).toEqual(['start', 'press']);
  });

  it('Space работает как Enter', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.keyDown(' ');
    p.keyUp(' ');
    expect(log).toEqual(['start', 'press']);
  });

  it('автоповтор keyDown не даёт второго start', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.keyDown('Enter');
    p.keyDown('Enter');
    p.keyDown('Enter');
    p.keyUp('Enter');
    expect(log).toEqual(['start', 'press']);
  });

  it('Escape во время удержания → cancel', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.keyDown('Enter');
    p.keyDown('Escape');
    p.keyUp('Enter');
    expect(log).toEqual(['start', 'cancel']);
  });

  it('прочие клавиши игнорируются', () => {
    const { log, opts } = pressLog();
    const p = createPress(opts);
    p.keyDown('a');
    p.keyUp('a');
    expect(log).toEqual([]);
  });
});
