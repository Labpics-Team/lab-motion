import { describe, expect, it } from 'vitest';
import { CompositorSpring } from '../src/compositor/index.js';

const SPRING = { mass: 1, stiffness: 170, damping: 26 };

function controller(target: { animate: (...args: any[]) => any }, extra = {}) {
  return new CompositorSpring({
    spring: SPRING,
    property: 'opacity',
    from: 0,
    to: 1,
    target,
    now: () => 0,
    ...extra,
  });
}

function drainFrames(queue: Array<(timestamp?: number) => void>): void {
  for (let frame = 1; queue.length > 0 && frame <= 200; frame++) {
    queue.shift()!(frame * 1000 / 60);
  }
  expect(queue).toHaveLength(0);
}

describe('CompositorSpring host-owner protocol', () => {
  it('null target остаётся RAF fallback, а не terminal sentinel', () => {
    let frames = 0;
    const seen: Array<string | number> = [];
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      target: null as never,
      requestFrame: () => ++frames,
      apply: (value) => { seen.push(value); },
    });

    spring.start();

    expect(spring.tier).toBe('raf');
    expect(frames).toBe(1);
    expect(seen).toEqual([0]);
    spring.destroy();
  });

  it('headless fallback не вычисляет format без writer', () => {
    let formats = 0;
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      requestFrame: () => 1,
      format: () => {
        formats++;
        throw new Error('unused formatter called');
      },
    });

    expect(() => spring.start()).not.toThrow();
    expect(formats).toBe(0);
    spring.destroy();
  });

  it('оплачивает Animation, вернувшийся после реентрантного destroy', () => {
    let cancels = 0;
    let spring!: CompositorSpring;
    spring = controller({
      animate() {
        const animation = { cancel: () => { cancels++; } };
        spring.destroy();
        return animation;
      },
    });

    spring.start();

    expect(cancels).toBe(1);
  });

  it('бросающий timer cancel не прерывает terminal cleanup', () => {
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: () => 1,
      setTimer: () => () => { throw new Error('host timer cancel failed'); },
    });
    spring.start();

    expect(() => spring.destroy()).not.toThrow();
  });

  it('stop остаётся терминальным при start из host cancel', () => {
    const animations: Array<{ cancelled: number; cancel(): void }> = [];
    let spring!: CompositorSpring;
    spring = controller({
      animate() {
        const id = animations.length;
        const animation = {
          cancelled: 0,
          cancel() {
            this.cancelled++;
            if (id === 0) spring.start();
          },
        };
        animations.push(animation);
        return animation;
      },
    });

    spring.start();
    spring.stop();
    spring.stop();

    expect(animations).toHaveLength(1);
    expect(animations[0]!.cancelled).toBe(1);
  });

  it('destroy из stop cleanup не воскресает generation', () => {
    let starts = 0;
    let spring!: CompositorSpring;
    spring = controller({
      animate() {
        starts++;
        return { cancel: () => { spring.destroy(); } };
      },
    });

    spring.start();
    spring.stop();
    spring.start();

    expect(starts).toBe(1);
  });

  it('stale Animation cleanup не воскрешает effect после stop', () => {
    let starts = 0;
    let spring!: CompositorSpring;
    spring = controller({
      animate() {
        starts++;
        if (starts === 1) spring.stop();
        return { cancel: () => { spring.start(); } };
      },
    });

    spring.start();

    expect(starts).toBe(1);
  });

  it('stale timer cleanup не воскрешает fallback после stop', () => {
    let timers = 0;
    let spring!: CompositorSpring;
    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: () => 1,
      setTimer() {
        timers++;
        spring.stop();
        return () => { spring.start(); };
      },
    });

    spring.start();

    expect(timers).toBe(1);
    spring.destroy();
  });

  it('stale timer cancel не потребляет callback нового timer-owner', () => {
    let spring!: CompositorSpring;
    let timerCalls = 0;
    let frames = 0;
    let newerFired = false;
    let newerCancels = 0;
    let fireNewer = (): void => {
      throw new Error('newer timer ещё не зарезервирован');
    };

    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: () => ++frames,
      setTimer(callback) {
        if (++timerCalls === 1) {
          // Пока A не вернул cleanup, новый start уже публикует owner B.
          spring.start();
          // Stale cleanup A синхронно потребляет one-shot continuation B.
          return () => {
            fireNewer();
            // После возврата current continuation хвост stale A снова заперт.
            spring.start();
          };
        }

        let pending = true;
        fireNewer = () => {
          if (!pending) return;
          pending = false;
          newerFired = true;
          callback();
        };
        return () => {
          newerCancels++;
          pending = false;
        };
      },
    });

    spring.start();
    const observed = { timerCalls, newerFired, frames };
    spring.destroy();

    expect(observed).toEqual({ timerCalls: 2, newerFired: true, frames: 1 });
    expect(newerCancels).toBe(0);
  });

  it('cleanup A не подавляет terminal stop из continuation нового owner B', () => {
    let spring!: CompositorSpring;
    let timerCalls = 0;
    let fireNewer = (): void => {
      throw new Error('timer B ещё не зарезервирован');
    };
    const queue: Array<(timestamp?: number) => void> = [];
    const applied: Array<string | number> = [];

    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      apply: (value) => { applied.push(value); },
      requestFrame(callback) {
        queue.push(callback);
        // Вызов принадлежит continuation B, хотя cleanup A ещё на стеке.
        spring.stop();
        return queue.length;
      },
      setTimer(callback) {
        if (++timerCalls === 1) {
          spring.start();
          return () => fireNewer();
        }
        let pending = true;
        fireNewer = () => {
          if (!pending) return;
          pending = false;
          callback();
        };
        return () => { pending = false; };
      },
    });

    try {
      spring.start();
      expect(queue).toHaveLength(1);
      queue.shift()!(16);
      expect(queue).toHaveLength(0);
      expect(applied).toEqual([0]);
    } finally {
      spring.destroy();
    }
  });

  it('cleanup stale effect не подавляет stop из кадра текущего live-owner', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    const applied: Array<string | number> = [];
    let spring!: CompositorSpring;
    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      target: {
        animate() {
          spring.handoffToLive();
          return {
            cancel() {
              queue.shift()?.(16);
            },
          };
        },
      },
      requestFrame: (callback) => queue.push(callback),
      apply(value) {
        applied.push(value);
        if (applied.length === 2) spring.stop();
      },
      now: () => 0,
    });

    spring.start();

    expect(applied).toEqual([0, 0]);
    expect(queue).toHaveLength(0);
    spring.destroy();
  });

  it('cleanup stale effect не подавляет stop из публичного listener live-owner', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    let emissions = 0;
    let spring!: CompositorSpring;
    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      target: {
        animate() {
          const live = spring.handoffToLive();
          live.onChange(() => {
            if (++emissions === 2) spring.stop();
          });
          return { cancel: () => queue.shift()?.(16) };
        },
      },
      requestFrame: (callback) => queue.push(callback),
      apply() {},
      now: () => 0,
    });

    try {
      spring.start();
      expect({ emissions, queued: queue.length }).toEqual({ emissions: 2, queued: 0 });
    } finally {
      spring.destroy();
    }
  });

  it('stale timer return не стирает новый owner и оплачивает только stale handle', () => {
    let spring!: CompositorSpring;
    let calls = 0;
    let staleCancels = 0;
    let currentCancels = 0;
    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: () => 1,
      setTimer() {
        if (++calls === 1) {
          spring.start();
          return () => { staleCancels++; };
        }
        return () => { currentCancels++; };
      },
    });

    spring.start();
    expect({ calls, staleCancels, currentCancels }).toEqual({
      calls: 2,
      staleCancels: 1,
      currentCancels: 0,
    });
    spring.destroy();
    expect(currentCancels).toBe(1);
  });

  it('один handle, возвращённый stale и current reservation, отменяется только terminal-owner', () => {
    let spring!: CompositorSpring;
    let calls = 0;
    let cancels = 0;
    const shared = () => { cancels++; };
    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: () => 1,
      setTimer() {
        if (++calls === 1) spring.start();
        return shared;
      },
    });

    spring.start();
    expect({ calls, cancels }).toEqual({ calls: 2, cancels: 0 });
    spring.destroy();
    expect(cancels).toBe(1);
  });

  it('host throw инвалидирует leaked callback и оставляет start повторяемым', () => {
    let calls = 0;
    let cancels = 0;
    let frames = 0;
    let leaked!: () => void;
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: () => ++frames,
      setTimer(callback) {
        if (++calls === 1) {
          leaked = callback;
          throw new Error('timer rejected');
        }
        return () => { cancels++; };
      },
    });

    expect(() => spring.start()).toThrow('timer rejected');
    leaked();
    expect(frames).toBe(0);
    expect(() => spring.start()).not.toThrow();
    spring.destroy();
    expect({ calls, cancels }).toEqual({ calls: 2, cancels: 1 });
  });

  it('stale setTimer throw не стирает reentrant owner', () => {
    let spring!: CompositorSpring;
    let calls = 0;
    let currentCancels = 0;
    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: () => 1,
      setTimer() {
        if (++calls === 1) {
          spring.start();
          throw new Error('stale timer rejected');
        }
        return () => { currentCancels++; };
      },
    });

    expect(() => spring.start()).toThrow('stale timer rejected');
    expect({ calls, currentCancels }).toEqual({ calls: 2, currentCancels: 0 });
    spring.destroy();
    expect(currentCancels).toBe(1);
  });

  it('stale effect cleanup не может мутировать новый owner через public API', () => {
    const actions = {
      start: (spring: CompositorSpring) => spring.start(),
      retarget: (spring: CompositorSpring) => spring.retarget(2),
      stop: (spring: CompositorSpring) => spring.stop(),
      handoff: (spring: CompositorSpring) => { spring.handoffToLive(2); },
    };

    for (const [name, reenter] of Object.entries(actions)) {
      const cancels: number[] = [];
      let spring!: CompositorSpring;
      spring = controller({
        animate() {
          const id = cancels.push(0) - 1;
          if (id === 0) spring.start();
          return {
            currentTime: 0,
            cancel() {
              cancels[id]++;
              if (id === 0) reenter(spring);
            },
          };
        },
      });

      spring.start();
      expect(cancels, name).toEqual([1, 0]);
      spring.destroy();
      expect(cancels, name).toEqual([1, 1]);
    }
  });

  it('fallback delay публикует пассивный owner и стартует только из timer', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    const seen: Array<string | number> = [];
    let timer!: () => void;
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 100,
      requestFrame: (callback) => queue.push(callback),
      setTimer(callback, ms) {
        expect(ms).toBe(100);
        expect(queue).toHaveLength(0);
        timer = callback;
        return () => {};
      },
      apply: (value) => { seen.push(value); },
    });

    spring.start();

    expect(queue).toHaveLength(0);
    expect(seen).toEqual([0]);
    expect(spring.value).toBe(0);
    timer();
    expect(queue).toHaveLength(1);
    drainFrames(queue);
    expect(spring.value).toBe(1);
    spring.destroy();
  });

  it('fallback handoff потребляет pending delay и продолжает к текущей цели сейчас', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    let timer!: () => void;
    let cancels = 0;
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 100,
      requestFrame: (callback) => queue.push(callback),
      setTimer(callback) {
        timer = callback;
        return () => { cancels++; };
      },
    });
    spring.start();

    const mv = spring.handoffToLive();

    expect(cancels).toBe(1);
    expect(queue).toHaveLength(1);
    timer();
    expect(queue).toHaveLength(1);
    drainFrames(queue);
    expect(mv.value).toBe(1);
    expect(spring.value).toBe(1);
    spring.destroy();
  });

  it('cleanup сохраняет identity-token у signed-int32 границы', () => {
    let starts = 0;
    let cancels = 0;
    let spring!: CompositorSpring;
    spring = controller({
      animate() {
        starts++;
        return {
          cancel() {
            cancels++;
            spring.start();
          },
        };
      },
    });
    (spring as unknown as { _epoch: number })._epoch = 2 ** 31;

    spring.start();
    spring.start();

    expect(starts).toBe(2);
    spring.destroy();
    expect(cancels).toBe(2);
  });

  it('неуспешный WAAPI successor сохраняет donor-owner', () => {
    let calls = 0;
    let cancels = 0;
    const spring = controller({
      animate() {
        if (++calls === 2) throw new Error('successor rejected');
        return { currentTime: 0, cancel: () => { cancels++; } };
      },
    });
    spring.start();

    expect(() => spring.retarget(2)).toThrow('successor rejected');
    expect(cancels).toBe(0);
    spring.stop();
    expect(cancels).toBe(1);
  });

  it('scheduler throw после live commit оставляет повторяемый successor-owner', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    let requests = 0;
    let cancels = 0;
    const spring = controller(
      { animate: () => ({ currentTime: 0, cancel: () => { cancels++; } }) },
      {
        requestFrame(callback: (timestamp?: number) => void) {
          if (++requests === 1) throw new Error('live rejected');
          queue.push(callback);
          return requests;
        },
      },
    );
    spring.start();

    expect(() => spring.handoffToLive(2)).toThrow('live rejected');
    expect(cancels).toBe(1);
    expect(spring.mode).toBe('fallback');

    const owned = spring.handoffToLive(1);
    drainFrames(queue);
    expect(owned.value).toBe(1);
    expect(spring.value).toBe(1);
    spring.destroy();
    expect(cancels).toBe(1);
  });

  it('live handoff не выдаёт scheduler кадр до donor cancel', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    const seen: Array<string | number> = [];
    const spring = controller(
      { animate: () => ({ currentTime: 0, cancel: () => { drainFrames(queue); } }) },
      {
        requestFrame: (callback: (timestamp?: number) => void) => queue.push(callback),
        apply: (value: string | number) => { seen.push(value); },
      },
    );
    spring.start();

    const mv = spring.handoffToLive();

    expect(mv.value).toBe(0);
    expect(spring.value).toBe(0);
    expect(queue).toHaveLength(1);
    drainFrames(queue);
    expect(mv.value).toBe(1);
    expect(spring.value).toBe(1);
    expect(seen.at(-1)).toBe(1);
    spring.destroy();
  });

  it('stop инвалидирует live-кадры до timer cancel', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    const seen: Array<string | number> = [];
    const spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      delay: 10,
      requestFrame: (callback) => queue.push(callback),
      setTimer: () => () => { drainFrames(queue); },
      apply: (value) => { seen.push(value); },
    });
    spring.retarget(1);
    spring.start();

    spring.stop();
    const mv = spring.handoffToLive();

    expect(mv.value).toBe(0);
    expect(spring.value).toBe(0);
    expect(seen).toEqual([0]);
    expect(queue).toHaveLength(0);
    spring.destroy();
  });

  it('throwing apply при сборке кандидата не снимает donor-owner', () => {
    let cancels = 0;
    const spring = controller(
      { animate: () => ({ currentTime: 0, cancel: () => { cancels++; } }) },
      { apply: () => { throw new Error('writer rejected'); } },
    );
    spring.start();

    expect(() => spring.handoffToLive()).toThrow('writer rejected');
    expect(cancels).toBe(0);
    expect(spring.value).toBe(0);
    spring.destroy();
    expect(cancels).toBe(1);
  });

  it('retarget из format не допускает stale apply прежнего generation', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    let formats = 0;
    let writes = 0;
    let spring!: CompositorSpring;
    spring = new CompositorSpring({
      spring: SPRING,
      property: 'opacity',
      from: 0,
      to: 1,
      requestFrame: (callback) => queue.push(callback),
      format(value) {
        if (++formats === 2) spring.retarget(2);
        return value;
      },
      apply: () => { writes++; },
    });
    spring.start();
    expect(writes).toBe(1);

    queue.shift()!(16);

    expect(writes).toBe(1);
    spring.destroy();
  });

  it('после destroy public API инертен, но живой handoff валидирует цель', () => {
    const spring = controller({ animate: () => ({ cancel() {} }) });
    expect(() => spring.handoffToLive(Number.NaN)).toThrow();
    spring.destroy();

    expect(() => spring.retarget(Number.NaN)).not.toThrow();
    expect(() => spring.start()).not.toThrow();
    expect(() => spring.stop()).not.toThrow();
    spring.handoffToLive().destroy();
  });

  it('restart throw после commit оставляет forward-only live-owner', () => {
    const queue: Array<(timestamp?: number) => void> = [];
    let frames = 0;
    let cancels = 0;
    const spring = controller(
      { animate: () => ({ currentTime: 0, cancel: () => { cancels++; } }) },
      {
        requestFrame(callback: (timestamp?: number) => void) {
          if (++frames === 1) throw new Error('restart rejected');
          queue.push(callback);
          return frames;
        },
      },
    );
    spring.start();

    expect(() => spring.handoffToLive()).toThrow('restart rejected');
    expect(cancels).toBe(1);
    expect(spring.mode).toBe('fallback');

    const owned = spring.handoffToLive();
    owned.setTarget(1);
    drainFrames(queue);
    expect(spring.value).toBe(1);
    spring.destroy();
  });

  it('reentrant destroy из post-commit schedule не оставляет adopted owner', () => {
    let frames = 0;
    let animations = 0;
    let spring!: CompositorSpring;
    spring = controller(
      {
        animate() {
          animations++;
          return { currentTime: 0, cancel() {} };
        },
      },
      {
        requestFrame() {
          if (++frames === 1) spring.destroy();
          return 1;
        },
      },
    );
    spring.start();

    const mv = spring.handoffToLive();
    spring.start();
    mv.setTarget(2);

    expect(animations).toBe(1);
    expect(frames).toBe(1);
    expect(mv.value).toBe(0);
  });

  it('handle=0 не фабрикует commit-тик, late callback stale после destroy', () => {
    let requests = 0;
    let first!: (timestamp?: number) => void;
    const spring = controller(
      { animate: () => ({ currentTime: 0, cancel() {} }) },
      {
        requestFrame(callback: (timestamp?: number) => void) {
          requests++;
          if (requests === 1) {
            first = callback;
            return 0;
          }
          return 1;
        },
      },
    );
    spring.start();

    const mv = spring.handoffToLive();
    expect(requests).toBe(1);
    expect(mv.value).toBe(0);
    expect(spring.value).toBe(0);
    spring.destroy();
    first(16);

    expect(requests).toBe(1);
    expect(mv.value).toBe(0);
  });

  it('повторный start не оставляет прежний effect без owner', () => {
    const animations: Array<{ cancelled: number; cancel(): void }> = [];
    const spring = controller({
      animate() {
        const animation = {
          cancelled: 0,
          cancel() { this.cancelled++; },
        };
        animations.push(animation);
        return animation;
      },
    });

    spring.start();
    spring.start();
    spring.stop();

    expect(animations.map(({ cancelled }) => cancelled)).toEqual([1, 1]);
  });

  it('state-machine: все трассы start/retarget/stop/destroy сохраняют одного owner', () => {
    const operations = 4;
    const traceLength = 5;

    for (const kind of ['effect', 'timer'] as const) {
      for (let encoded = 0; encoded < operations ** traceLength; encoded++) {
        const owners: Array<{ cancels: number }> = [];
        const own = (): { cancels: number } => {
          const owner = { cancels: 0 };
          owners.push(owner);
          return owner;
        };
        const spring = kind === 'effect'
          ? controller({
            animate() {
              const owner = own();
              return { currentTime: 0, cancel: () => { owner.cancels++; } };
            },
          })
          : new CompositorSpring({
            spring: SPRING,
            property: 'opacity',
            from: 0,
            to: 1,
            delay: 10,
            requestFrame: () => 1,
            setTimer() {
              const owner = own();
              return () => { owner.cancels++; };
            },
          });
        let trace = encoded;
        let destroyed = false;
        let expectedActive = 0;

        for (let step = 0; step < traceLength; step++) {
          const op = trace % operations;
          trace = Math.floor(trace / operations);
          const ownersBefore = owners.length;
          if (op === 0) spring.start();
          else if (op === 1) spring.retarget(step + 2);
          else if (op === 2) spring.stop();
          else {
            spring.destroy();
            destroyed = true;
          }

          if (!destroyed && op === 0) expectedActive = 1;
          else if (!destroyed && op === 1) expectedActive = kind === 'effect' ? 1 : 0;
          else if (op >= 2) expectedActive = 0;

          const active = owners.filter(({ cancels }) => cancels === 0).length;
          expect(active, `${kind}:${encoded}:${step}`).toBe(expectedActive);
          expect(owners.every(({ cancels }) => cancels <= 1), `${kind}:${encoded}:${step}`).toBe(true);
          if (destroyed) expect(owners).toHaveLength(ownersBefore);
          if (op >= 2) expect(active).toBe(0);
        }

        spring.destroy();
        expect(owners.every(({ cancels }) => cancels === 1)).toBe(true);
      }
    }
  });
});
