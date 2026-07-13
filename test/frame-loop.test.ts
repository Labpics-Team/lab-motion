/**
 * test/frame-loop.test.ts — единый frame-шедулер (subpath ./frame, S21).
 * Классы: А (фазовый порядок, жизненный цикл подписок) + В (мутации во время
 * тика, handle=0 fallback, детерминизм) + Д (mutation-хуки в шапке).
 *
 * ── RED PROOF ────────────────────────────────────────────────────────────────
 * Написаны до реализации — на стабе падал бы каждый поведенческий блок своим ассертом.
 * Mutation-proof: перепутать порядок фаз → «read→update→render в одном кадре»
 * RED; потерять once-семантику → «once вызывается ровно один раз» RED;
 * терять подписку из тика → «add во время тика исполняется со следующего
 * кадра» RED; сломать останов пустого цикла → «пустой цикл не планирует» RED.
 *
 * Зачем субпуть (D11): сейчас каждый MotionValue/drive планирует СВОЙ rAF —
 * N значений = N колбэков на кадр. Единый тикер = один rAF, батч всех
 * значений, фазы против layout-thrash (канон Motion frame / gsap.ticker).
 * Миграция ядра на шедулер — отдельный differential-этап после мержа.
 */

import { describe, expect, it } from 'vitest';
import * as frameModule from '../src/frame/index.js';
import { createFrameLoop } from '../src/frame/index.js';

function makeVirtualClock() {
  const queue: Array<(ts?: number) => void> = [];
  let clock = 0;
  let handle = 0;
  return {
    requestFrame(cb: (ts?: number) => void): number {
      queue.push(cb);
      return ++handle;
    },
    /** Продвинуть РОВНО один кадр (все колбэки, запланированные к нему). */
    step(dtMs = 1000 / 60): number {
      clock += dtMs;
      const batch = queue.splice(0, queue.length);
      for (const cb of batch) cb(clock);
      return batch.length;
    },
    get pending(): number {
      return queue.length;
    },
  };
}

describe('frame: фазовый порядок', () => {
  it('read → update → render строго в одном кадре, независимо от порядка подписки', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.render(() => calls.push('render'));
    loop.read(() => calls.push('read'));
    loop.update(() => calls.push('update'));
    vc.step();
    expect(calls).toEqual(['read', 'update', 'render']);
  });

  it('несколько подписчиков одной фазы исполняются в порядке подписки', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: number[] = [];
    loop.update(() => calls.push(1));
    loop.update(() => calls.push(2));
    loop.update(() => calls.push(3));
    vc.step();
    expect(calls).toEqual([1, 2, 3]);
  });
});

describe('frame: жизненный цикл подписки', () => {
  it('подписка повторяется каждый кадр до отписки; отписка идемпотентна', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    const off = loop.update(() => {
      n++;
    });
    vc.step();
    vc.step();
    vc.step();
    expect(n).toBe(3);
    off();
    off(); // повторная отписка — no-op
    vc.step();
    expect(n).toBe(3);
  });

  it('once: вызывается ровно один раз и самоотписывается', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    loop.update(
      () => {
        n++;
      },
      { once: true },
    );
    vc.step();
    vc.step();
    expect(n).toBe(1);
  });

  it('колбэк получает timestamp кадра (или undefined — фикс-шаг у потребителя)', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const seen: Array<number | undefined> = [];
    loop.update((ts) => {
      seen.push(ts);
    });
    vc.step();
    vc.step();
    expect(seen).toHaveLength(2);
    expect(seen[1]! - (seen[0] as number)).toBeCloseTo(1000 / 60, 6);
  });
});

describe('frame: ОДИН rAF на кадр — суть шедулера', () => {
  it('N подписчиков — ровно один запланированный колбэк на кадр', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    loop.read(() => {});
    loop.update(() => {});
    loop.update(() => {});
    loop.render(() => {});
    expect(vc.pending).toBe(1); // не 4
    const fired = vc.step();
    expect(fired).toBe(1);
    expect(vc.pending).toBe(1); // перепланирован снова один
  });

  it('пустой цикл не планирует кадры; после отписки последнего — останавливается', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    expect(vc.pending).toBe(0); // ленивый старт
    const off = loop.update(() => {});
    expect(vc.pending).toBe(1);
    off();
    vc.step(); // кадр без подписчиков
    expect(vc.pending).toBe(0); // не перепланировался
  });
});

describe('frame: мутации во время тика (класс гонок)', () => {
  it('add во время тика: новый подписчик исполняется со СЛЕДУЮЩЕГО кадра', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.update(() => {
      calls.push('a');
      if (calls.filter((c) => c === 'a').length === 1) {
        loop.update(() => calls.push('b'));
      }
    });
    vc.step();
    expect(calls).toEqual(['a']); // b не в этом кадре
    vc.step();
    expect(calls).toEqual(['a', 'a', 'b']);
  });

  it('remove самого себя и соседа во время тика — без пропусков и дублей', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    let offB: () => void = () => {};
    loop.update(() => {
      calls.push('a');
      offB(); // сосед удаляется прямо в тике
    });
    offB = loop.update(() => calls.push('b'));
    loop.update(() => calls.push('c'));
    vc.step();
    // 'b' удалён в момент исполнения 'a' — в этом кадре не вызывается
    expect(calls).toEqual(['a', 'c']);
    vc.step();
    expect(calls).toEqual(['a', 'c', 'a', 'c']);
  });

  it('исключение одного подписчика не срывает остальных и не убивает цикл', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.update(() => {
      throw new Error('плохой подписчик');
    });
    loop.update(() => calls.push('ok'));
    expect(() => vc.step()).not.toThrow();
    expect(calls).toEqual(['ok']);
    vc.step();
    expect(calls).toEqual(['ok', 'ok']);
  });
});

describe('frame: fallback handle=0 (non-draining клок)', () => {
  it('handle=0 → setTimeout-фоллбек продолжает кадры (луп не дедлочится)', async () => {
    let calls = 0;
    const loop = createFrameLoop({ requestFrame: () => 0 });
    loop.update(() => {
      calls++;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeGreaterThan(0);
    loop.cancelAll();
  });
});

describe('frame: гонка позднего дрейна (класс Finding 3 — двойной цикл)', () => {
  it('handle=0 клок, дренированный ПОЗЖЕ, гасится токеном — двойного тика нет', async () => {
    const captured: Array<(ts?: number) => void> = [];
    const loop = createFrameLoop({
      requestFrame: (cb) => {
        captured.push(cb); // клок сохраняет колбэк, но сообщает 0 (non-draining)
        return 0;
      },
    });
    let n = 0;
    loop.update(() => {
      n++;
    });
    await new Promise((r) => setTimeout(r, 40)); // fallback-путь накрутил кадры
    const before = n;
    expect(before).toBeGreaterThan(0);
    for (const cb of captured) cb(999); // поздний дрейн «мёртвого» пути
    expect(n).toBe(before); // токен погасил чужой тик синхронно
    loop.cancelAll();
  });
});

describe('frame: lifecycle-классы (ноты QA-ревью)', () => {
  it('бросок requestFrame откатывает подписку и не отравляет следующий старт', () => {
    const queue: Array<(ts?: number) => void> = [];
    let first = true;
    const loop = createFrameLoop({
      requestFrame: (cb) => {
        if (first) {
          first = false;
          throw new Error('host scheduler failed');
        }
        queue.push(cb);
        return 1;
      },
    });
    let calls = 0;
    expect(() => loop.update(() => calls++)).toThrow('host scheduler failed');
    expect(() => loop.update(() => calls++, { once: true })).not.toThrow();
    queue.shift()?.(0);
    expect(calls).toBe(1);
  });

  it('контракт-пин: клок-нарушитель, зовущий колбэк дважды, не ломает состояние', () => {
    // Двойной синхронный вызов одного fire гасится токеном (или, при пустых
    // фазах, наблюдаемо-нейтрален). Пин против будущих регрессий механики.
    let n = 0;
    const loop = createFrameLoop({
      requestFrame: (cb) => {
        cb(1);
        cb(1); // нарушение контракта клока
        return 1;
      },
    });
    expect(() =>
      loop.update(
        () => {
          n++;
        },
        { once: true },
      ),
    ).not.toThrow();
    expect(n).toBe(1);
  });

  it('cancelAll ВНУТРИ тика: соседи этого кадра не вызываются, цикл встаёт', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.update(() => {
      calls.push('a');
      loop.cancelAll();
    });
    loop.update(() => calls.push('b'));
    vc.step();
    expect(calls).toEqual(['a']);
    expect(vc.pending).toBe(0);
  });

  it('cancelAll в read-фазе гасит update/render без OOB по старым границам', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.read(() => {
      calls.push('read');
      loop.cancelAll();
    });
    loop.update(() => calls.push('update'));
    loop.render(() => calls.push('render'));

    expect(() => vc.step()).not.toThrow();
    expect(calls).toEqual(['read']);
    expect(vc.pending).toBe(0);
  });

  it('resubscribe из cancelAll-callback ждёт следующего кадра', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.read(() => {
      calls.push('old');
      loop.cancelAll();
      loop.render(() => calls.push('new'), { once: true });
    });
    loop.update(() => calls.push('stale'));

    vc.step();
    expect(calls).toEqual(['old']);
    expect(vc.pending).toBe(1);
    vc.step();
    expect(calls).toEqual(['old', 'new']);
    expect(vc.pending).toBe(0);
  });

  it('resubscribe после cancelAll: цикл возобновляется', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    loop.update(() => {});
    loop.cancelAll();
    vc.step();
    expect(vc.pending).toBe(0);
    let n = 0;
    loop.update(() => {
      n++;
    });
    vc.step();
    expect(n).toBe(1);
  });

  it('исключение в read-фазе не срывает update/render ТОГО ЖЕ кадра', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    const calls: string[] = [];
    loop.read(() => {
      throw new Error('плохой read');
    });
    loop.update(() => calls.push('u'));
    loop.render(() => calls.push('r'));
    vc.step();
    expect(calls).toEqual(['u', 'r']);
  });

  it('once, отписанный ДО первого кадра, не вызывается', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    const off = loop.update(
      () => {
        n++;
      },
      { once: true },
    );
    off();
    vc.step();
    expect(n).toBe(0);
  });

  it('два независимых createFrameLoop не мешают друг другу', () => {
    const vcA = makeVirtualClock();
    const vcB = makeVirtualClock();
    const a = createFrameLoop({ requestFrame: vcA.requestFrame });
    const b = createFrameLoop({ requestFrame: vcB.requestFrame });
    let nA = 0;
    let nB = 0;
    a.update(() => {
      nA++;
    });
    b.update(() => {
      nB++;
    });
    vcA.step();
    vcA.step();
    expect(nA).toBe(2);
    expect(nB).toBe(0);
  });
});

describe('frame: cancelAll и синглтон', () => {
  it('cancelAll снимает все подписки всех фаз', () => {
    const vc = makeVirtualClock();
    const loop = createFrameLoop({ requestFrame: vc.requestFrame });
    let n = 0;
    loop.read(() => n++);
    loop.update(() => n++);
    loop.render(() => n++);
    loop.cancelAll();
    vc.step();
    expect(n).toBe(0);
  });

  it('детерминизм: две одинаковые последовательности дают идентичные журналы', () => {
    const run = (): string[] => {
      const vc = makeVirtualClock();
      const loop = createFrameLoop({ requestFrame: vc.requestFrame });
      const calls: string[] = [];
      loop.render(() => calls.push('r1'));
      const off = loop.update(() => calls.push('u1'));
      loop.read(() => calls.push('d1'));
      vc.step();
      off();
      loop.update(() => calls.push('u2'), { once: true });
      vc.step();
      vc.step();
      return calls;
    };
    expect(run()).toEqual(run());
  });
});

// Пин набора runtime-экспортов живёт ТОЛЬКО в frame-api-surface-pin.test.ts
// (один источник истины: два пина одного контракта = coupled-дубль).
describe('frame SSR-safety', () => {
  it('SSR: import + фабрика в node не бросают; дефолтный синглтон ленив', () => {
    expect(() => {
      const loop = createFrameLoop({ requestFrame: () => 1 });
      loop.cancelAll();
      void frameModule.frame; // сам доступ к синглтону не должен трогать rAF
    }).not.toThrow();
  });
});
