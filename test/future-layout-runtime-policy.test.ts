/**
 * test/future-layout-runtime-policy.test.ts — input policy, scroll anchor и
 * coordinator-владение surface-транзакции (спеки «ACCESSIBILITY И INPUT»,
 * «SCROLL ANCHOR», «DOCUMENT-SCOPED COORDINATOR»).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SPRING } from '../src/internal/motion-defaults.js';
import {
  createSurfaceCoordinator,
  startSurfaceTransition,
  type SurfaceSeams,
} from '../src/future-layout/index.js';
import { fakeEl, makeClock, type FakeElement } from './animate-facade-helpers.js';

interface IntentHub {
  onInputIntent(handler: () => void): () => void;
  fire(): void;
  readonly activeHandlers: number;
  readonly cleanedUp: number;
}

function makeIntentHub(): IntentHub {
  let handler: (() => void) | undefined;
  let active = 0;
  let cleanedUp = 0;
  return {
    onInputIntent(h: () => void): () => void {
      handler = h;
      active++;
      return () => {
        handler = undefined;
        active--;
        cleanedUp++;
      };
    },
    fire(): void {
      handler?.();
    },
    get activeHandlers(): number {
      return active;
    },
    get cleanedUp(): number {
      return cleanedUp;
    },
  };
}

interface ScrollWorld {
  getScroll(): number;
  scrollTo(position: number): void;
  readonly log: ReadonlyArray<{ kind: 'get' | 'set'; value: number }>;
  position: number;
}

function makeScrollWorld(start = 120): ScrollWorld {
  const log: { kind: 'get' | 'set'; value: number }[] = [];
  const world: ScrollWorld = {
    position: start,
    getScroll(): number {
      log.push({ kind: 'get', value: world.position });
      return world.position;
    },
    scrollTo(position: number): void {
      world.position = position;
      log.push({ kind: 'set', value: position });
    },
    log,
  };
  return world;
}

function begin(
  fake: FakeElement,
  clock: ReturnType<typeof makeClock>,
  extra: { options?: Record<string, unknown>; seams?: Partial<SurfaceSeams> } = {},
) {
  return startSurfaceTransition(
    fake.el as never,
    240,
    360,
    { spring: DEFAULT_SPRING, ...(extra.options ?? {}) } as never,
    { requestFrame: clock.requestFrame, ...(extra.seams ?? {}) },
  );
}

describe('input policy', () => {
  it('finish (default): первый intent раскрывает committed DOM и снимает подписку', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const hub = makeIntentHub();
    const controls = begin(fake, clock, { seams: { onInputIntent: hub.onInputIntent } });
    await controls.ready;
    expect(controls.state).toBe('running');
    expect(hub.activeHandlers).toBe(1);

    hub.fire();
    expect(controls.state).toBe('released');
    // Проекция удалена: effects отменены, committed DOM (width) раскрыт.
    expect(fake.cancels).toBe(5);
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
    expect(hub.activeHandlers).toBe(0);
    expect(hub.cleanedUp).toBe(1);
    await controls.finished;
  });

  it('cancel: intent завершает транзакцию отменой (committed не откатывается)', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const hub = makeIntentHub();
    const controls = begin(fake, clock, {
      options: { inputPolicy: 'cancel' },
      seams: { onInputIntent: hub.onInputIntent },
    });
    await controls.ready;
    hub.fire();
    expect(controls.state).toBe('canceled');
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
    await controls.finished;
  });

  it('block: intent не прерывает transition; подписка не создаётся', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const hub = makeIntentHub();
    const controls = begin(fake, clock, {
      options: { inputPolicy: 'block' },
      seams: { onInputIntent: hub.onInputIntent },
    });
    await controls.ready;
    expect(hub.activeHandlers).toBe(0);
    hub.fire();
    expect(controls.state).toBe('running');
    clock.drain();
    await controls.finished;
    expect(controls.state).toBe('released');
  });

  it('stale handler после terminal: повторный fire не меняет состояние, cleanup ровно один', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const hub = makeIntentHub();
    const controls = begin(fake, clock, { seams: { onInputIntent: hub.onInputIntent } });
    await controls.ready;
    hub.fire();
    expect(controls.state).toBe('released');
    expect(hub.cleanedUp).toBe(1);
    // Hub уже снял handler: повторный fire — no-op по построению; состояние стабильно.
    hub.fire();
    expect(controls.state).toBe('released');
    expect(hub.cleanedUp).toBe(1);
  });
});

describe('scroll anchor', () => {
  it('preserve-start (default): get ДО commit, коррекция внутри barrier, без повторов', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const world = makeScrollWorld(340);
    const controls = begin(fake, clock, {
      seams: { getScroll: world.getScroll, scrollTo: world.scrollTo },
    });
    // get выполнен синхронно ДО microtask-commit.
    expect(world.log).toEqual([{ kind: 'get', value: 340 }]);
    // Коммит сдвинул layout (в фейке — эмуляция: позиция уплыла).
    world.position = 500;
    await controls.committed;
    // Коррекция произошла внутри barrier: позиция восстановлена один раз.
    expect(world.log).toEqual([
      { kind: 'get', value: 340 },
      { kind: 'set', value: 340 },
    ]);
    clock.drain();
    await controls.finished;
    // После terminal дополнительных записей scroll нет.
    expect(world.log).toHaveLength(2);
  });

  it('scrollAnchor none: scroll не читается и не пишется', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const world = makeScrollWorld();
    const controls = begin(fake, clock, {
      options: { scrollAnchor: 'none' },
      seams: { getScroll: world.getScroll, scrollTo: world.scrollTo },
    });
    await controls.ready;
    clock.drain();
    await controls.finished;
    expect(world.log).toHaveLength(0);
  });
});

interface FakeHost {
  injectCss(css: string): void;
  removeCss(): void;
  startViewTransition?(update: () => void | Promise<void>): unknown;
  readonly injects: string[];
  readonly removals: number;
  readonly vtCalls: number;
}

function makeFakeHost(withVt: boolean): FakeHost {
  const host: FakeHost = {
    injects: [],
    removals: 0,
    vtCalls: 0,
    injectCss(css: string): void {
      host.injects.push(css);
    },
    removeCss(): void {
      host.removals++;
    },
  };
  if (withVt) {
    host.startViewTransition = (update) => {
      host.vtCalls++;
      return Promise.resolve(update());
    };
  }
  return host;
}

describe('view transition host', () => {
  it('native tier: generated CSS инжектится до effects и снимается ровно один раз на terminal', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const host = makeFakeHost(false);
    const controls = begin(fake, clock, { seams: { generation, host } });
    await controls.ready;
    expect(controls.tier).toBe('future-layout-native');
    // CSS содержит отключение UA-анимаций всех четырёх псевдоуровней.
    expect(host.injects).toHaveLength(1);
    for (const pseudo of ['group', 'image-pair', 'old', 'new']) {
      expect(host.injects[0]).toContain(`::view-transition-${pseudo}(${generation.viewTransitionName})`);
      expect(host.injects[0]).toContain('animation: none');
    }
    expect(host.removals).toBe(0);
    clock.drain();
    await controls.finished;
    expect(host.removals).toBe(1);
    // Временное имя снимается: inline-style не остаётся.
    expect(fake.removals).toEqual(['view-transition-name']);
    expect(fake.el.style.getPropertyValue('view-transition-name')).toBe('');
  });

  it('startViewTransition capability: commit проходит внутри VT', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const host = makeFakeHost(true);
    const controls = begin(fake, clock, { seams: { host } });
    await controls.committed;
    expect(host.vtCalls).toBe(1);
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
    clock.drain();
    await controls.finished;
  });

  it('startViewTransition отсутствует: транзакция полноценна без VT', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const host = makeFakeHost(false);
    const controls = begin(fake, clock, { seams: { host } });
    await controls.committed;
    expect(host.vtCalls).toBe(0);
    clock.drain();
    await controls.finished;
    expect(controls.state).toBe('released');
  });

  it('host throw в startViewTransition не оставляет partial owner', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const host = makeFakeHost(false);
    host.startViewTransition = () => {
      throw new Error('vt unsupported');
    };
    const controls = begin(fake, clock, { seams: { host } });
    await controls.finished;
    // Сбой host терминализирует без зависших состояний.
    expect(['failed', 'released']).toContain(controls.state);
  });

  it('snap tier: CSS не инжектится и не снимается', async () => {
    const fake = fakeEl({ width: '240px' }, false); // без animate → snap
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const host = makeFakeHost(true);
    const controls = begin(fake, clock, { seams: { generation, host } });
    await controls.finished;
    expect(controls.tier).toBe('future-layout-snap');
    expect(host.injects).toHaveLength(0);
    expect(host.removals).toBe(0);
  });

  it('cancel ДО commit: host не трогается вовсе', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const host = makeFakeHost(true);
    const controls = begin(fake, clock, { seams: { host } });
    controls.cancel();
    await controls.finished;
    expect(host.vtCalls).toBe(0);
    expect(host.injects).toHaveLength(0);
    expect(host.removals).toBe(0);
  });
});

describe('coordinator-владение транзакции', () => {
  it('published generation завершается finish ровно один раз', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const controls = begin(fake, clock, { seams: { generation } });
    await controls.committed;
    expect(generation.published).toBe(true);
    clock.drain();
    await controls.finished;
    expect(generation.released).toBe(true);
    expect(coordinator.activeGeneration).toBe(0);
    // Повторный finish — stale no-op.
    generation.finish();
    expect(coordinator.activeGeneration).toBe(0);
  });

  it('snap-транзакция публикует commit и завершается finish', async () => {
    const fake = fakeEl({ width: '240px' }, false); // без animate → snap
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const controls = begin(fake, clock, { seams: { generation } });
    await controls.finished;
    // Коммит конечного DOM состоялся даже на snap-tier → published.
    expect(generation.published).toBe(true);
    expect(generation.released).toBe(true);
    expect(controls.tier).toBe('future-layout-snap');
  });

  it('cancel ДО commit: generation освобождается skip без публикации', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const controls = begin(fake, clock, { seams: { generation } });
    controls.cancel();
    await controls.finished;
    expect(controls.state).toBe('canceled');
    expect(generation.published).toBe(false);
    expect(generation.released).toBe(true);
    // Commit не выполнен: width цели не изменён.
    expect(fake.el.style.getPropertyValue('width')).toBe('240px');
  });

  it('supersede: stale-транзакция не очищает новую generation', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const first = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const controlsA = begin(fake, clock, { seams: { generation: first } });
    await controlsA.ready;

    // Новый transition вытесняет визуальное представление старого.
    const second = coordinator.begin({ target: fake.el, fromWidth: 360, toWidth: 480 });
    clock.drain();
    await controlsA.finished;

    // Stale finish первой generation НЕ трогает вторую.
    expect(first.released).toBe(false);
    expect(second.released).toBe(false);
    expect(coordinator.activeGeneration).toBe(second.generation);
    second.finish();
    expect(coordinator.activeGeneration).toBe(0);
  });

  it('FutureLayoutTransaction.commit: собственный commit исполняется вместо width-записи', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const calls: string[] = [];
    const controls = begin(fake, clock, {
      options: {
        commit: () => {
          calls.push('framework-flush');
          fake.el.style.setProperty('width', '360px');
        },
      },
    });
    await controls.committed;
    expect(calls).toEqual(['framework-flush']);
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
    clock.drain();
    await controls.finished;
  });
});
