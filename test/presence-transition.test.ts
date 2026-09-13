import { describe, expect, it, vi } from 'vitest';
import * as presence from '../src/presence/index.js';
import type { PresenceTransitionOptions, PresenceTransitionControls } from '../src/presence/index.js';

function deferred() {
  let finish!: () => void;
  let reject!: (error: unknown) => void;
  const finished = new Promise<void>((yes, no) => { finish = yes; reject = no; });
  return { finished, finish, reject, cancel: vi.fn() };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const create = (options: PresenceTransitionOptions = {}): PresenceTransitionControls => {
  expect(presence).toHaveProperty('createPresenceTransition');
  return presence.createPresenceTransition(options);
};

describe('управляемое присутствие', () => {
  it('одна цель и одна общая граница завершения группы', async () => {
    const a = deferred(), b = deferred(), gone = vi.fn();
    const p = create({ initiallyPresent: true, exit: () => [a, b], onGone: gone });
    const pending = p.setPresent(false);
    expect(p.state).toBe('exiting');
    expect(p.setPresent(false)).toBe(pending);
    a.finish(); await flush();
    expect(gone).not.toHaveBeenCalled();
    b.finish();
    expect(await pending).toEqual({ status: 'finished', present: false });
    expect(p.state).toBe('gone');
    expect(gone).toHaveBeenCalledOnce();
  });

  it('повторное открытие отзывает старое удаление и сначала передаёт импульс', async () => {
    const a = deferred(), b = deferred(), events: string[] = [], gone = vi.fn();
    a.cancel.mockImplementation(() => events.push('cancel exit'));
    const p = create({ initiallyPresent: true, exit: () => a,
      enter: () => { events.push('start enter'); return b; }, onGone: gone });
    const exiting = p.setPresent(false), entering = p.setPresent(true);
    expect(events).toEqual(['start enter', 'cancel exit']);
    expect(await exiting).toEqual({ status: 'superseded', present: false });
    a.finish(); await flush();
    expect(p.state).toBe('entering'); expect(gone).not.toHaveBeenCalled();
    b.finish(); expect(await entering).toEqual({ status: 'finished', present: true });
  });

  it('тройное прерывание не принимает первый совпавший по направлению done', async () => {
    const a = deferred(), b = deferred(), c = deferred(); let exits = 0;
    const p = create({ initiallyPresent: true, exit: () => ++exits === 1 ? a : c, enter: () => b });
    p.setPresent(false); p.setPresent(true); const last = p.setPresent(false);
    a.finish(); b.finish(); await flush(); expect(p.state).toBe('exiting');
    c.finish(); expect((await last).status).toBe('finished');
  });

  it('destroy отменяет всех, не удаляет DOM и делает поздние вызовы инертными', async () => {
    const a = deferred(), b = deferred(), gone = vi.fn(), exit = vi.fn(() => [a, b]);
    const p = create({ initiallyPresent: true, exit, onGone: gone });
    const pending = p.setPresent(false); p.destroy(); p.destroy();
    expect(await pending).toEqual({ status: 'destroyed', present: false });
    a.finish(); b.finish(); await flush();
    p.setPresent(true); p.setPresent(false);
    expect(p.state).toBe('destroyed'); expect(exit).toHaveBeenCalledOnce();
    expect(a.cancel).toHaveBeenCalledOnce(); expect(b.cancel).toHaveBeenCalledOnce();
    expect(gone).not.toHaveBeenCalled();
  });

  it('ошибка cancel не мешает остальной очистке и не проглатывается', () => {
    const a = deferred(), b = deferred(), error = new Error('cancel');
    a.cancel.mockImplementation(() => { throw error; });
    const p = create({ initiallyPresent: true, exit: () => [a, b] });
    p.setPresent(false);
    expect(() => p.destroy()).toThrow(error); expect(b.cancel).toHaveBeenCalledOnce();
    expect(p.state).toBe('destroyed');
  });

  it('отклонение finished — явная ошибка, не разрешение на удаление', async () => {
    const a = deferred(), b = deferred(), gone = vi.fn();
    const p = create({ initiallyPresent: true, exit: () => [a, b], onGone: gone });
    const promise = p.setPresent(false); a.reject('failed');
    expect(await promise).toEqual({ status: 'failed', present: false, error: 'failed' });
    expect(p.state).toBe('failed'); expect(b.cancel).toHaveBeenCalledOnce();
    expect(gone).not.toHaveBeenCalled();
  });

  it('синхронная ошибка фабрики наблюдаема и отменяет прежний прогон', async () => {
    const a = deferred(), error = new Error('factory');
    const p = create({ enter: () => a, exit: () => { throw error; } });
    p.setPresent(true);
    expect(() => p.setPresent(false)).toThrow(error);
    expect(await p.finished).toEqual({ status: 'failed', present: false, error });
    expect(a.cancel).toHaveBeenCalledOnce();
  });

  it('nested setPresent в фабрике не присваивает старые handles новой фазе', async () => {
    const a = deferred(), b = deferred(); let p: PresenceTransitionControls;
    p = create({ enter: () => { p.setPresent(false); return a; }, exit: () => b });
    const old = p.setPresent(true);
    expect((await old).status).toBe('superseded'); expect(a.cancel).toHaveBeenCalledOnce();
    expect(b.cancel).not.toHaveBeenCalled(); expect(p.state).toBe('exiting');
    b.finish(); await p.finished; expect(p.state).toBe('gone');
  });

  it('destroy в фабрике отменяет вернувшийся позже handle', async () => {
    const a = deferred(); let p: PresenceTransitionControls;
    p = create({ enter: () => { p.destroy(); return a; } });
    expect((await p.setPresent(true)).status).toBe('destroyed');
    expect(a.cancel).toHaveBeenCalledOnce();
  });

  it('терминальный callback может начать новую фазу, не меняя завершённый исход', async () => {
    const a = deferred(), b = deferred(); let p: PresenceTransitionControls;
    p = create({ enter: () => a, exit: () => b, onPresent: () => p.setPresent(false) });
    const first = p.setPresent(true); a.finish();
    expect(await first).toEqual({ status: 'finished', present: true });
    expect(p.state).toBe('exiting'); b.finish(); await p.finished;
    expect(p.state).toBe('gone');
  });

  it('без анимации завершает синхронно; начальное присутствие не запускает фабрику', async () => {
    const enter = vi.fn(), gone = vi.fn(); const p = create({ initiallyPresent: true, enter, onGone: gone });
    expect(await p.setPresent(true)).toEqual({ status: 'finished', present: true });
    expect(enter).not.toHaveBeenCalled();
    const done = p.setPresent(false); expect(p.state).toBe('gone');
    expect(await done).toEqual({ status: 'finished', present: false });
  });

  it('повторённый handle внутри группы ожидает и отменяется один раз', async () => {
    const a = deferred(); const p = create({ enter: () => [a, a] });
    p.setPresent(true); p.destroy(); expect(a.cancel).toHaveBeenCalledOnce();
  });

  it('не отменяет handle, явно переданный новой фазе', async () => {
    const a = deferred(); const p = create({ enter: () => a, exit: () => a });
    p.setPresent(true); const last = p.setPresent(false);
    expect(a.cancel).not.toHaveBeenCalled(); a.finish();
    expect(await last).toEqual({ status: 'finished', present: false });
  });

  it('настоящий animate: фазы завершаются без ручного done, кадровый драйвер прежний', async () => {
    const { animate } = await import('../src/animate/index.js');
    let opacity = '0';
    const el = { style: { setProperty: (_: string, value: string) => { opacity = value; }, getPropertyValue: () => opacity } }; const frames: Array<(t?: number) => void> = [];
    const run = (opacity: number) => animate(el, { opacity }, { duration: 100, ease: t => t,
      requestFrame: cb => { frames.push(cb); return frames.length; } });
    const p = create({ enter: () => run(1), exit: () => run(0) });
    p.setPresent(true); frames.shift()?.(0); frames.shift()?.(40);
    expect(Number(opacity)).toBeGreaterThan(0);
    const exiting = p.setPresent(false);
    for (let t = 50; t <= 300; t += 25) { const queue = frames.splice(0); for (const f of queue) f(t); }
    expect(await exiting).toEqual({ status: 'finished', present: false });
    expect(Number(opacity)).toBe(0);
  });
});

it('ошибка группы сохраняет также все ошибки cleanup', async () => {
  const a = deferred(), b = deferred();
  a.cancel.mockImplementation(() => { throw undefined; });
  b.cancel.mockImplementation(() => { throw 'cleanup'; });
  const p = create({ enter: () => [a, b] });
  const pending = p.setPresent(true); a.reject('original');
  const result = await pending;
  expect(result.status).toBe('failed');
  if (result.status === 'failed') expect((result.error as AggregateError).errors).toEqual(['original', undefined, 'cleanup']);
});

it('синхронный thenable не завершает группу прежде её полной регистрации', async () => {
  const b = deferred(), notify = vi.fn();
  const a = { finished: { then: (resolve: () => void) => resolve() }, cancel() {} };
  const p = create({ enter: () => [a as unknown as presence.PresenceAnimation, b], onPresent: notify });
  p.setPresent(true); await flush(); expect(notify).not.toHaveBeenCalled();
  b.finish(); await p.finished; expect(notify).toHaveBeenCalledOnce();
});

it('getter finished может уничтожить область; поздняя регистрация не воскрешает её', async () => {
  const d = deferred(); let p: PresenceTransitionControls;
  const handle = { cancel: d.cancel, get finished() { p.destroy(); return d.finished; } };
  p = create({ enter: () => handle });
  expect(await p.setPresent(true)).toEqual({ status: 'destroyed', present: true });
  expect(d.cancel).toHaveBeenCalledOnce(); d.finish(); await flush(); expect(p.state).toBe('destroyed');
});

it('успевший завершиться участник освобождён, destroy отменяет только оставшихся', async () => {
  const a = deferred(), b = deferred(); const p = create({ enter: () => [a, b] });
  p.setPresent(true); a.finish(); await flush(); p.destroy();
  expect(a.cancel).not.toHaveBeenCalled(); expect(b.cancel).toHaveBeenCalledOnce();
});

it('ошибка терминального callback не ломает нового реентрантного владельца', async () => {
  const a = deferred(), b = deferred(); let p: PresenceTransitionControls;
  p = create({ enter: () => a, exit: () => b, onPresent() { p.setPresent(false); throw 'callback'; } });
  const first = p.setPresent(true); a.finish();
  expect(await first).toEqual({ status: 'failed', present: true, error: 'callback' });
  expect(p.state).toBe('exiting'); b.finish(); expect((await p.finished).status).toBe('finished');
});

it('последний input побеждает даже из cancel предыдущей фазы', async () => {
  const a = deferred(), b = deferred(), c = deferred(); let p: PresenceTransitionControls; let enters = 0;
  a.cancel.mockImplementation(() => p.setPresent(true));
  p = create({ enter: () => ++enters === 1 ? a : c, exit: () => b });
  p.setPresent(true); const second = p.setPresent(false);
  expect((await second).status).toBe('superseded'); expect(b.cancel).toHaveBeenCalledOnce();
  expect(p.state).toBe('entering'); c.finish(); expect((await p.finished).status).toBe('finished');
});

it('границы группы отвергают sparse и чрезмерный размер до traversal', () => {
  const a = deferred(); const sparse = [a, , a] as unknown as presence.PresenceAnimation[];
  const p = create({ enter: () => sparse });
  expect(() => p.setPresent(true)).toThrow(TypeError); expect(a.cancel).toHaveBeenCalledOnce();
  const huge = new Array(10_001); let reads = 0;
  Object.defineProperty(huge, 0, { get() { reads++; return a; } });
  expect(() => create({ enter: () => huge }).setPresent(true)).toThrow(RangeError);
  expect(reads).toBe(0);
});

it('снимок исхода неизменяем, done не означает уничтожение', async () => {
  const p = create(); const result = await p.setPresent(true);
  expect(Object.isFrozen(result)).toBe(true);
  p.destroy(); expect(result).toEqual({ status: 'finished', present: true }); expect(p.state).toBe('destroyed');
});

it('seeded истории: только все finished последнего intent могут разрешить onGone', async () => {
  let seed = 17;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let history = 0; history < 128; history++) {
    let desired = false, latest: ReturnType<typeof deferred>[] = [], gone = 0;
    const all: ReturnType<typeof deferred>[] = [];
    const factory = () => { latest = [deferred(), deferred()]; all.push(...latest); return latest; };
    const p = create({ enter: factory, exit: factory, onGone() { gone++; } });
    for (let i = 0; i < 16; i++) {
      const next = (random() & 2) !== 0;
      p.setPresent(next); desired = next;
      const stale = all.filter(d => !latest.includes(d));
      for (const d of stale) d.finish();
      await flush(); expect(gone).toBe(0);
    }
    latest[0]?.finish(); await flush(); expect(gone).toBe(0);
    latest[1]?.finish(); await p.finished;
    expect(p.state).toBe(desired ? 'present' : 'gone');
    expect(gone).toBe(desired || !all.length ? 0 : 1);
    p.destroy();
  }
});

it('реентрантный getter фабрики не запускает уже отозванную фазу', async () => {
  let p: PresenceTransitionControls; const stale = vi.fn();
  p = create({ get enter() { p.setPresent(false); return stale; } });
  expect((await p.setPresent(true)).status).toBe('superseded');
  expect(stale).not.toHaveBeenCalled(); expect(p.state).toBe('gone');
});

it('сбой чтения одного участника не оставляет остальные возвращённые анимации бесхозными', async () => {
  const a = deferred(), b = deferred(), c = deferred(); const error = new Error('finished getter');
  const broken = { cancel: b.cancel, get finished(): Promise<void> { throw error; } };
  const p = create({ enter: () => [a, broken, c] });
  expect(() => p.setPresent(true)).toThrow(error);
  expect(await p.finished).toEqual({ status: 'failed', present: true, error });
  expect(a.cancel).toHaveBeenCalledOnce(); expect(b.cancel).toHaveBeenCalledOnce();
  expect(c.cancel).toHaveBeenCalledOnce();
});

it('мгновенный уход не разрешает удаление, пока отмена прежней фазы может отказать', async () => {
  const a = deferred(), gone = vi.fn(), error = new Error('previous cancel');
  a.cancel.mockImplementation(() => { throw error; });
  const p = create({ enter: () => a, onGone: gone });
  p.setPresent(true);
  expect(() => p.setPresent(false)).toThrow(error);
  expect(gone).not.toHaveBeenCalled();
  expect(await p.finished).toEqual({ status: 'failed', present: false, error });
  expect(p.state).toBe('failed');
});
