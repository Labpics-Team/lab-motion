/**
 * test/future-layout-runtime-policy.test.ts — input policy, scroll anchor и
 * coordinator-владение surface-транзакции (спеки «ACCESSIBILITY И INPUT»,
 * «SCROLL ANCHOR», «DOCUMENT-SCOPED COORDINATOR», «VIEW TRANSITION HOST»).
 *
 * Native tier существует только в pseudo-tree same-document VT: все
 * native-сценарии получают полный комплект швов (makeSurfaceEnv), snap-сценарии
 * документируют fail-closed деградацию (нет VT / недоказанная модель).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SPRING } from '../src/internal/motion-defaults.js';
import {
  createSurfaceCoordinator,
  startSurfaceTransition,
  type SurfaceSeams,
} from '../src/future-layout/index.js';
import { fakeEl, makeClock, type FakeElement } from './animate-facade-helpers.js';
import {
  makePseudoModelReader,
  makeSurfaceEnv,
  makeSurfaceHost,
  type FakeSurfaceHost,
} from './future-layout-helpers.js';

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
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      seams: { onInputIntent: hub.onInputIntent, host: env.host, readPseudoModel: env.readPseudoModel },
    });
    await controls.ready;
    expect(controls.state).toBe('running');
    expect(hub.activeHandlers).toBe(1);

    hub.fire();
    expect(controls.state).toBe('released');
    // Проекция удалена: snapshot-плоскости сняты skipTransition, stylesheet
    // убран, committed DOM (width) раскрыт.
    expect(env.host.skips).toBe(1);
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
    expect(hub.activeHandlers).toBe(0);
    expect(hub.cleanedUp).toBe(1);
    await controls.finished;
  });

  it('cancel: intent завершает транзакцию отменой (committed не откатывается)', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const hub = makeIntentHub();
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      options: { inputPolicy: 'cancel' },
      seams: { onInputIntent: hub.onInputIntent, host: env.host, readPseudoModel: env.readPseudoModel },
    });
    await controls.ready;
    hub.fire();
    expect(controls.state).toBe('canceled');
    expect(env.host.skips).toBe(1);
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
    await controls.finished;
  });

  it('block: intent не прерывает transition; подписка не создаётся', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const hub = makeIntentHub();
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      options: { inputPolicy: 'block' },
      seams: { onInputIntent: hub.onInputIntent, host: env.host, readPseudoModel: env.readPseudoModel },
    });
    await controls.ready;
    expect(hub.activeHandlers).toBe(0);
    hub.fire();
    expect(controls.state).toBe('running');
    // Terminal authority — vt.finished: естественное завершение CSS-анимаций.
    env.host.complete();
    await controls.finished;
    expect(controls.state).toBe('released');
  });

  it('stale handler после terminal: повторный fire не меняет состояние, cleanup ровно один', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const hub = makeIntentHub();
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      seams: { onInputIntent: hub.onInputIntent, host: env.host, readPseudoModel: env.readPseudoModel },
    });
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
    await controls.finished;
    expect(world.log).toHaveLength(0);
  });
});

describe('view transition host', () => {
  it('native tier: UA-disable ДО VT, effects после сертификации; cleanup ровно один', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const host = makeSurfaceHost();
    const controls = begin(fake, clock, {
      seams: { generation, host, readPseudoModel: makePseudoModelReader() },
    });
    await controls.ready;
    expect(controls.tier).toBe('future-layout-native');
    // Два инжекта: UA-отключение (до startViewTransition) и 5 effects (после).
    expect(host.injects).toHaveLength(2);
    for (const pseudo of ['group', 'image-pair', 'old', 'new']) {
      expect(host.injects[0]).toContain(`::view-transition-${pseudo}(${generation.viewTransitionName})`);
      expect(host.injects[0]).toContain('animation: none');
    }
    expect(host.effectCount).toBe(5);
    expect(host.injects[1]).toContain(`::view-transition-group(${generation.viewTransitionName})`);
    expect(host.removals).toBe(0);
    host.complete();
    await controls.finished;
    expect(host.removals).toBe(1);
  });

  it('terminal cleanup снимает view-transition-name, если цель ещё носит наше имя', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    // Route назначает имя inline до транзакции; эмулируем назначение.
    fake.el.style.setProperty('view-transition-name', generation.viewTransitionName);
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      seams: { generation, host: env.host, readPseudoModel: env.readPseudoModel },
    });
    await controls.ready;
    env.host.complete();
    await controls.finished;
    // Временное имя снимается: inline-style не остаётся.
    expect(fake.removals).toEqual(['view-transition-name']);
    expect(fake.el.style.getPropertyValue('view-transition-name')).toBe('');
  });

  it('startViewTransition capability: commit проходит внутри VT', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      seams: { host: env.host, readPseudoModel: env.readPseudoModel },
    });
    await controls.committed;
    expect(env.host.vtCalls).toBe(1);
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
    env.host.complete();
    await controls.finished;
  });

  it('startViewTransition отсутствует: транзакция полноценна без VT (snap)', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const host: FakeSurfaceHost = makeSurfaceHost();
    const hostNoVt = { injectCss: host.injectCss, removeCss: host.removeCss };
    const controls = begin(fake, clock, {
      seams: { host: hostNoVt, readPseudoModel: makePseudoModelReader() },
    });
    await controls.committed;
    expect(host.vtCalls).toBe(0);
    await controls.finished;
    expect(controls.state).toBe('released');
    expect(controls.tier).toBe('future-layout-snap');
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
  });

  it('host throw в startViewTransition не оставляет partial owner', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const host = {
      injectCss(): void {},
      removeCss(): void {},
      startViewTransition(): unknown {
        throw new Error('vt unsupported');
      },
    };
    const controls = begin(fake, clock, {
      seams: { host, readPseudoModel: makePseudoModelReader() },
    });
    await controls.finished;
    // Throw гасится: commit применяется напрямую, транзакция завершается snap.
    expect(controls.state).toBe('released');
    expect(controls.tier).toBe('future-layout-snap');
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
  });

  it('недоказанная pseudo-модель: fail-closed snap, effects CSS не инжектится', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const host = makeSurfaceHost();
    const controls = begin(fake, clock, {
      seams: { generation, host, readPseudoModel: makePseudoModelReader(999) },
    });
    await controls.finished;
    expect(controls.tier).toBe('future-layout-snap');
    // UA-отключение было инжектнуто до VT (и снято на terminal); effects нет.
    expect(host.injects).toHaveLength(1);
    expect(host.effectCount).toBe(0);
    expect(host.removals).toBe(1);
    expect(fake.el.style.getPropertyValue('width')).toBe('360px');
  });

  it('readPseudoModel отсутствует: snap без effects', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const host = makeSurfaceHost();
    const controls = begin(fake, clock, { seams: { host } });
    await controls.finished;
    expect(controls.tier).toBe('future-layout-snap');
    expect(host.effectCount).toBe(0);
  });

  it('cancel ДО commit: host не трогается вовсе', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      seams: { host: env.host, readPseudoModel: env.readPseudoModel },
    });
    controls.cancel();
    await controls.finished;
    expect(env.host.vtCalls).toBe(0);
    expect(env.host.injects).toHaveLength(0);
    expect(env.host.removals).toBe(0);
    expect(env.host.skips).toBe(0);
  });
});

describe('coordinator-владение транзакции', () => {
  it('published generation завершается finish ровно один раз', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const env = makeSurfaceEnv();
    const controls = begin(fake, clock, {
      seams: { generation, host: env.host, readPseudoModel: env.readPseudoModel },
    });
    await controls.committed;
    expect(generation.published).toBe(true);
    env.host.complete();
    await controls.finished;
    expect(generation.released).toBe(true);
    expect(coordinator.activeGeneration).toBe(0);
    // Повторный finish — stale no-op.
    generation.finish();
    expect(coordinator.activeGeneration).toBe(0);
  });

  it('snap-транзакция публикует commit и завершается finish', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const generation = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    // Без VT/модели — fail-closed snap, но commit публикуется всегда.
    const controls = begin(fake, clock, { seams: { generation } });
    await controls.finished;
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

  it('supersede: старая транзакция останавливается, новую generation не очищает', async () => {
    const fake = fakeEl({ width: '240px' }, true);
    const clock = makeClock();
    const coordinator = createSurfaceCoordinator();
    const first = coordinator.begin({ target: fake.el, fromWidth: 240, toWidth: 360 });
    const env = makeSurfaceEnv();
    const controlsA = begin(fake, clock, {
      seams: { generation: first, host: env.host, readPseudoModel: env.readPseudoModel },
    });
    await controlsA.ready;
    expect(controlsA.state).toBe('running');

    // Новый transition вытесняет визуальное представление старого: onSupersede
    // останавливает active representation (skip + stylesheet cleanup).
    const second = coordinator.begin({ target: fake.el, fromWidth: 360, toWidth: 480 });
    await controlsA.finished;
    expect(controlsA.state).toBe('released');
    expect(env.host.skips).toBe(1);
    expect(env.host.removals).toBe(1);

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
    await controls.finished;
  });
});
