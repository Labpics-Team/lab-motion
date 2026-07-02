/**
 * test/bindings-shared-frame.test.ts — дефолт биндингов на ОБЩИЙ кадр (S32).
 *
 * Класс: без инжектированного requestFrame биндинг-значения садятся на
 * разделяемый цикл (один rAF на ВСЕ значения — D11 по умолчанию). Существующие
 * биндинг-тесты инжектируют клок, поэтому НЕ покрывают этот путь — здесь он
 * пинится напрямую через единый хелпер createBoundValue и через реальный
 * биндинг (svelte springStore без requestFrame).
 *
 * RED-proof (диверсия): в src/internal/binding-value.ts убрать `?? asRequestFrame()`
 * → значения возвращаются к собственному rAF ядра (N значений = N rAF) →
 * тест «N значений = один rAF» краснеет (rafCalls станет 3, не 1).
 *
 * Изоляция: общий синглтон frame гасится в afterEach (cancelAll + слив pending),
 * глобальный requestAnimationFrame восстанавливается — состояние не течёт.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBoundValue } from '../src/internal/binding-value.js';
import { frame } from '../src/frame/index.js';
import { springStore } from '../src/svelte/index.js';

const SPRING = { mass: 1, stiffness: 200, damping: 20 } as const;

let rafCalls: number;
let pending: Array<(ts?: number) => void>;
const origRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;

beforeEach(() => {
  rafCalls = 0;
  pending = [];
  (globalThis as unknown as { requestAnimationFrame: (cb: (ts?: number) => void) => number }).requestAnimationFrame =
    (cb) => {
      rafCalls++;
      pending.push(cb);
      return rafCalls; // ненулевой handle — путь setTimeout-фоллбека не активен
    };
});

afterEach(() => {
  // Погасить общий цикл и слить очередь, чтобы scheduled-флаг синглтона
  // сбросился (тик выставляет scheduled=false) — изоляция между тестами.
  frame.cancelAll();
  let guard = 0;
  while (pending.length > 0 && guard++ < 100) {
    const batch = pending;
    pending = [];
    for (const cb of batch) cb(16);
  }
  if (origRaf === undefined) {
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  } else {
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRaf;
  }
});

describe('дефолт биндингов на общий кадр (createBoundValue)', () => {
  it('N значений без инжектированного requestFrame = ОДИН rAF на кадр (D11)', () => {
    const a = createBoundValue({ initial: 0, spring: SPRING });
    const b = createBoundValue({ initial: 0, spring: SPRING });
    const c = createBoundValue({ initial: 0, spring: SPRING });
    a.setTarget(1);
    b.setTarget(1);
    c.setTarget(1);
    // Три значения делят один цикл → ровно одна заявка rAF на кадр.
    expect(rafCalls).toBe(1);
    a.destroy();
    b.destroy();
    c.destroy();
  });

  it('инжектированный requestFrame выигрывает — общий цикл не тронут (детерминизм)', () => {
    let injected = 0;
    const mv = createBoundValue({
      initial: 0,
      spring: SPRING,
      requestFrame: () => {
        injected++;
        return 1;
      },
    });
    mv.setTarget(1);
    expect(injected).toBe(1); // использован инжектированный клок
    expect(rafCalls).toBe(0); // синглтон frame не задействован
    mv.destroy();
  });
});

describe('реальный биндинг (svelte) наследует общий кадр', () => {
  it('два springStore без requestFrame делят один rAF', () => {
    const s1 = springStore(0, SPRING);
    const s2 = springStore(0, SPRING);
    s1.set(100);
    s2.set(100);
    expect(rafCalls).toBe(1);
    s1.destroy();
    s2.destroy();
  });
});
