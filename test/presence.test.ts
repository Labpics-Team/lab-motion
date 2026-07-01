/**
 * test/presence.test.ts — машина enter/exit lifecycle (subpath ./presence).
 * Классы: А (state machine) + В (property: случайные последовательности) + Д.
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падают поведенческие блоки.
 * Mutation-proof: убрать generation-инвалидацию done → тест «stale done
 * после прерывания» RED; убрать reduced-ветку → «reduce: мгновенно» RED.
 */

import { describe, expect, it } from 'vitest';
import * as presence from '../src/presence/index.js';
import { createPresence, swapPresence } from '../src/presence/index.js';

/** matchMedia-стаб: reduced-motion = true. */
function reduceMedia(): (q: string) => MediaQueryList {
  return () =>
    ({ matches: true, media: '', onchange: null, addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as unknown as MediaQueryList;
}

function rig(opts: Parameters<typeof createPresence>[0] = {}) {
  const log: string[] = [];
  const dones: Array<() => void> = [];
  const p = createPresence({
    onEnterStart: (done) => { log.push('enterStart'); dones.push(done); },
    onExitStart: (done) => { log.push('exitStart'); dones.push(done); },
    onPresent: () => log.push('present'),
    onGone: () => log.push('gone'),
    ...opts,
  });
  return { p, log, dones };
}

// ─── Базовый lifecycle ────────────────────────────────────────────────────────

describe('presence: базовый lifecycle', () => {
  it('начальное состояние: gone (не в DOM); initiallyPresent → present', () => {
    expect(createPresence().state).toBe('gone');
    expect(createPresence({ initiallyPresent: true }).state).toBe('present');
  });

  it('enter(): entering → done() → present (события по порядку)', () => {
    const { p, log, dones } = rig();
    p.enter();
    expect(p.state).toBe('entering');
    expect(log).toEqual(['enterStart']);
    dones[0]();
    expect(p.state).toBe('present');
    expect(log).toEqual(['enterStart', 'present']);
  });

  it('exit(): exiting → done() → gone', () => {
    const { p, log, dones } = rig({ initiallyPresent: true });
    p.exit();
    expect(p.state).toBe('exiting');
    dones[0]();
    expect(p.state).toBe('gone');
    expect(log).toEqual(['exitStart', 'gone']);
  });

  it('enter() в present / exit() в gone — идемпотентные no-op', () => {
    const { p, log, dones } = rig();
    p.enter();
    dones[0]();
    p.enter(); // уже present
    expect(log).toEqual(['enterStart', 'present']);
    const { p: p2, log: log2 } = rig();
    p2.exit(); // уже gone
    expect(log2).toEqual([]);
  });

  it('повторный done() того же этапа — no-op (ровно один терминальный колбэк)', () => {
    const { p, log, dones } = rig();
    p.enter();
    dones[0]();
    dones[0]();
    dones[0]();
    expect(log).toEqual(['enterStart', 'present']);
  });
});

// ─── Прерывания ───────────────────────────────────────────────────────────────

describe('presence: прерывания (interruption)', () => {
  it('exit() во время entering → exiting; stale done старой фазы — no-op', () => {
    const { p, log, dones } = rig();
    p.enter();
    p.exit(); // прерываем вход
    expect(p.state).toBe('exiting');
    expect(log).toEqual(['enterStart', 'exitStart']);
    dones[0](); // done ВХОДА — уже неактуален
    expect(p.state).toBe('exiting'); // не сдвинул машину
    dones[1](); // done выхода
    expect(p.state).toBe('gone');
    expect(log).toEqual(['enterStart', 'exitStart', 'gone']);
  });

  it('enter() во время exiting → re-enter (entering заново)', () => {
    const { p, log, dones } = rig({ initiallyPresent: true });
    p.exit();
    p.enter(); // передумали удалять
    expect(p.state).toBe('entering');
    dones[0](); // stale done выхода — no-op
    expect(p.state).toBe('entering');
    dones[1]();
    expect(p.state).toBe('present');
    expect(log).toEqual(['exitStart', 'enterStart', 'present']);
  });

  it('онGone не вызывается, если exit был прерван (нет ложного размонтирования)', () => {
    const { p, log, dones } = rig({ initiallyPresent: true });
    p.exit();
    p.enter();
    dones[0](); // stale exit done
    expect(log.filter((e) => e === 'gone')).toEqual([]);
  });
});

// ─── Reduced motion ───────────────────────────────────────────────────────────

describe('presence: prefers-reduced-motion (CHARACTER-switch)', () => {
  it('enter(): мгновенно present, БЕЗ анимационной фазы (onEnterStart не зовётся)', () => {
    const { p, log } = rig({ matchMedia: reduceMedia() });
    p.enter();
    expect(p.state).toBe('present');
    expect(log).toEqual(['present']);
  });

  it('exit(): мгновенно gone — элемент удаляется сразу', () => {
    const { p, log } = rig({ initiallyPresent: true, matchMedia: reduceMedia() });
    p.exit();
    expect(p.state).toBe('gone');
    expect(log).toEqual(['gone']);
  });
});

// ─── Property: случайные последовательности не ломают машину ─────────────────

describe('presence: property — валидность при любых последовательностях', () => {
  it('2000 случайных операций: состояние всегда валидно, gone ≤ 1 на exit-фазу', () => {
    let s = 20260702;
    const rnd = () => {
      s = (Math.imul(48271, s) + 0) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const valid = ['gone', 'entering', 'present', 'exiting'];
    const dones: Array<() => void> = [];
    const p = createPresence({
      onEnterStart: (d) => dones.push(d),
      onExitStart: (d) => dones.push(d),
    });
    for (let i = 0; i < 2000; i++) {
      const op = rnd();
      if (op < 0.35) p.enter();
      else if (op < 0.7) p.exit();
      else if (dones.length > 0) {
        // случайный (возможно stale) done
        const idx = Math.floor(rnd() * dones.length);
        dones[idx]();
      }
      expect(valid).toContain(p.state);
    }
  });
});

// ─── swapPresence (координатор old→new) ───────────────────────────────────────

describe('presence: swapPresence — координация замены', () => {
  it("mode 'wait': enter нового ТОЛЬКО после gone старого (порядок запинен)", () => {
    const order: string[] = [];
    const dones: Array<() => void> = [];
    const prev = createPresence({
      initiallyPresent: true,
      onExitStart: (d) => { order.push('prev:exitStart'); dones.push(d); },
      onGone: () => order.push('prev:gone'),
    });
    const next = createPresence({
      onEnterStart: (d) => { order.push('next:enterStart'); dones.push(d); },
      onPresent: () => order.push('next:present'),
    });
    swapPresence(prev, next, { mode: 'wait' });
    expect(order).toEqual(['prev:exitStart']); // новый ещё НЕ входит
    dones[0]();
    expect(order).toEqual(['prev:exitStart', 'prev:gone', 'next:enterStart']);
    dones[1]();
    expect(order[order.length - 1]).toBe('next:present');
  });

  it("mode 'sync': exit старого и enter нового стартуют одновременно", () => {
    const order: string[] = [];
    const prev = createPresence({
      initiallyPresent: true,
      onExitStart: () => order.push('prev:exitStart'),
    });
    const next = createPresence({
      onEnterStart: () => order.push('next:enterStart'),
    });
    swapPresence(prev, next, { mode: 'sync' });
    expect(order).toEqual(['prev:exitStart', 'next:enterStart']);
  });

  it("mode 'wait' + прерывание: enter старого отменяет своп (новый не входит)", () => {
    const order: string[] = [];
    const dones: Array<() => void> = [];
    const prev = createPresence({
      initiallyPresent: true,
      onExitStart: (d) => { order.push('prev:exitStart'); dones.push(d); },
      onEnterStart: (d) => { order.push('prev:enterStart'); dones.push(d); },
    });
    const next = createPresence({
      onEnterStart: () => order.push('next:enterStart'),
    });
    swapPresence(prev, next, { mode: 'wait' });
    prev.enter(); // передумали
    dones[0](); // stale exit done — no-op
    expect(order).toEqual(['prev:exitStart', 'prev:enterStart']);
    expect(next.state).toBe('gone');
  });
});

// ─── API surface pin ──────────────────────────────────────────────────────────

describe('presence-api-surface-pin', () => {
  it('ровно запиненный набор runtime-экспортов', () => {
    expect(Object.keys(presence).sort()).toEqual(['createPresence', 'swapPresence']);
  });

  it('форма контроллера (исчерпывающе)', () => {
    expect(Object.keys(createPresence()).sort()).toEqual(['enter', 'exit', 'onStateChange', 'state']);
  });

  it('onStateChange: синхронные уведомления + отписка', () => {
    const seen: string[] = [];
    const dones: Array<() => void> = [];
    const p = createPresence({ onEnterStart: (d) => dones.push(d) });
    const unsub = p.onStateChange((s) => seen.push(s));
    p.enter();
    dones[0]();
    expect(seen).toEqual(['entering', 'present']);
    unsub();
    p.exit();
    expect(seen).toEqual(['entering', 'present']); // после отписки тишина
  });

  it('SSR: создание в node env не бросает', () => {
    expect(() => {
      const p = createPresence();
      p.enter();
      swapPresence(createPresence({ initiallyPresent: true }), createPresence(), { mode: 'sync' });
    }).not.toThrow();
  });
});
