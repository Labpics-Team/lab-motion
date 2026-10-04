import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures/harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type CompositorPackage = Pick<typeof import('../src/compositor/index.js'), 'CompositorSpring'>;
type ResourceReachability = {
  terminal: Array<WeakRef<HTMLElement>>;
  live: WeakRef<HTMLElement>;
  dropped: WeakRef<HTMLElement>;
  droppedOwner: WeakRef<InstanceType<CompositorPackage['CompositorSpring']>>;
  deliberate: WeakRef<HTMLElement>;
  liveOwner: InstanceType<CompositorPackage['CompositorSpring']>;
  deliberateOwner: HTMLElement | undefined;
};
type ResourcePage = typeof globalThis & {
  __resourceTerminalOwners?: unknown[];
  __resourceReachability?: ResourceReachability;
};

test('RESOURCE-01: 10 000 native/live/serialized циклов фактического tarball освобождают Animation, jobs и DOM-цели', async ({ page, browserName }, info) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const tuple = readFileSync(join(ROOT, 'browser/.artifacts/scope-recipes.package.json'));
  const manifest = JSON.parse(tuple.toString('utf8')) as {
    schema: string; tarball: { sha256: string }; bundleSha256: string;
  };
  expect(manifest.schema).toBe('scope-recipes-package-v1');
  expect(manifest.tarball.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(createHash('sha256').update(readFileSync(join(ROOT, 'browser/.artifacts/scope-recipes.js'))).digest('hex'))
    .toBe(manifest.bundleSha256);
  await info.attach('installed-package-tuple', { body: tuple, contentType: 'application/json' });

  const report = await page.evaluate(async () => {
    const moduleUrl = '/browser/.artifacts/scope-recipes.js';
    const { CompositorSpring } = await import(moduleUrl) as CompositorPackage;
    const spring = Object.freeze({ mass: 1, stiffness: 170, damping: 26 });
    const queue: Array<(timestamp?: number) => void> = [];
    let now = 0, requests = 0, writes = 0, createdEffects = 0;
    const requestFrame = (callback: (timestamp?: number) => void): number => {
      queue.push(callback); return ++requests;
    };
    const step = (): void => {
      now += 16;
      const batch = queue.splice(0);
      for (const callback of batch) callback(now);
    };
    const assert = (condition: boolean, message: string): void => {
      if (!condition) throw new Error(message);
    };
    const target = (): HTMLDivElement => {
      const element = document.createElement('div');
      element.style.cssText = 'width:20px;height:20px;opacity:0';
      const animate = element.animate;
      element.animate = (keyframes, options): Animation => {
        createdEffects++;
        // Монитор считает реальные Animation, сохраняет native receiver и не
        // хранит history handles/targets. Замены исполнителя здесь нет.
        return Reflect.apply(animate, element, [keyframes, options]) as Animation;
      };
      document.body.append(element);
      return element;
    };
    const owner = (element: HTMLElement) => new CompositorSpring({
      spring, property: 'opacity', from: 0, to: 1, target: element,
      apply(value) { writes++; element.style.opacity = String(value); },
      requestFrame, now: () => now,
      matchMedia: query => window.matchMedia(query),
    });
    const animation = (element: HTMLElement): number => {
      const effects = element.getAnimations();
      assert(effects.length === 1, 'одна поверхность должна иметь один native effect');
      const effect = effects[0]!;
      assert(effect.effect instanceof KeyframeEffect && effect.effect.target === element,
        'Animation должен принадлежать исследуемой поверхности');
      effect.pause(); effect.currentTime = 32;
      return effects.length;
    };

    assert(document.getAnimations().length === 0, 'стенд не начал с пустого native ownership');
    const liveTarget = target(), live = owner(liveTarget);
    live.start(); animation(liveTarget);
    assert(live.mode === 'compositor', 'положительный native control недоступен');
    const deliberateTarget = target();
    const deliberate = deliberateTarget.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, fill: 'both' });
    deliberate.pause(); deliberate.currentTime = 32;
    assert(document.getAnimations().length === 2, 'deliberate/live controls не различаются');
    assert(requests === 0 && queue.length === 0, 'автономные controls создали собственный frame');

    const retained = [];
    const terminal: Array<WeakRef<HTMLElement>> = [];
    let cycles = 0, hostTurns = 0;
    let maximumCycleEffects = 0;
    const beforeEffects = createdEffects;
    for (let cycle = 0; cycle < 10_000; cycle++) {
      const element = target();
      terminal.push(new WeakRef(element));
      const controller = owner(element);
      const beforeNative = requests;
      controller.start(); animation(element);
      assert(controller.mode === 'compositor', 'нативный участок не принят');
      controller.retarget(0.8); const retargetEffectCount = animation(element);
      assert(requests === beforeNative && queue.length === 0, 'native start/retarget создал собственный frame');
      // Число измерено при native commit; pause/currentTime семплируют тот же Animation.
      maximumCycleEffects = Math.max(maximumCycleEffects, retargetEffectCount);

      const dynamic = controller.handoffToLive(0.6);
      assert(element.getAnimations().length === 0, 'native donor не отменён после live commit');
      assert(queue.length > 0, 'живой положительный контроль не запросил frame');
      step(); dynamic.setTarget(0.5); step();
      controller.handoffToCompositor(0.7); animation(element);
      assert(controller.mode === 'compositor', 'serialized successor не принят');
      const beforeDonor = writes;
      dynamic.setTarget(0.1); step();
      assert(writes === beforeDonor && queue.length === 0, 'переданный live donor продолжает работу');

      controller.destroy(); controller.destroy();
      const beforeTerminal = { writes, requests };
      // Contract RequestFrameFn не имеет cancel handle: единственный уже
      // выданный host batch дрейнится, затем jobs должны физически отсутствовать.
      step(); controller.start(); controller.retarget(1);
      assert(writes === beforeTerminal.writes && requests === beforeTerminal.requests,
        'terminal controller воскресил writer/scheduler');
      assert(queue.length === 0 && element.getAnimations().length === 0,
        'terminal boundary оставила job/native effect');
      element.remove();
      retained.push(controller, dynamic);
      cycles++;
      if (cycles % 500 === 0) {
        // Как в Node-стенде, серия заканчивается ходом хоста для отложенной
        // очистки. Сразу после него проверяются прежние terminal-обязательства.
        const beforeTurn = { writes, requests, createdEffects };
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        hostTurns++;
        assert(writes === beforeTurn.writes && requests === beforeTurn.requests,
          'после хода хоста terminal owner восстановил writer/scheduler');
        assert(createdEffects === beforeTurn.createdEffects,
          'после хода хоста terminal owner создал native effect');
        assert(queue.length === 0 && document.getAnimations().length === 2,
          'после хода хоста потерян control либо остался native/job owner');
      }
    }
    const observedCycleEffects = createdEffects - beforeEffects;
    assert(observedCycleEffects === cycles * 3, 'неполный знаменатель start/retarget/serialized commit');
    const beforeRelease = document.getAnimations().length;
    assert(beforeRelease === 2, 'живые controls были потеряны либо terminal effects остались');
    live.destroy(); liveTarget.remove();
    const deliberateRemaining = document.getAnimations().length;
    assert(deliberateRemaining === 1, 'deliberate effect не обнаруживается отдельно от live owner');
    deliberate.cancel(); deliberateTarget.remove();
    const releasedRemaining = document.getAnimations().length;
    assert(releasedRemaining === 0, 'контрольное native ownership не освобождено');
    (globalThis as ResourcePage).__resourceTerminalOwners = retained;
    // Все цели detached: document не подменяет сильное владение библиотеки.
    // Живой controller удерживается, затем destroy проверяется на том же root.
    const liveDom = target();
    liveDom.remove();
    const deliberateDom = document.createElement('div');
    const droppedDom = document.createElement('div');
    const droppedOwner = owner(droppedDom);
    (globalThis as ResourcePage).__resourceReachability = {
      terminal,
      live: new WeakRef(liveDom), liveOwner: owner(liveDom),
      dropped: new WeakRef(droppedDom), droppedOwner: new WeakRef(droppedOwner),
      deliberate: new WeakRef(deliberateDom), deliberateOwner: deliberateDom,
    };

    return { cycles, hostTurns, observedCycleEffects, maximumCycleEffects, retainedTerminalOwners: retained.length,
      terminalAnimations: document.getAnimations().length, terminalJobs: queue.length,
      controls: { beforeRelease, afterLiveRelease: deliberateRemaining, afterRelease: releasedRemaining },
      memory: { rasterGpu: 'не измерены: DOM Animation ownership не является GPU byte-измерением' } };
  });
  await info.attach('resource-native-ownership', {
    body: JSON.stringify({ browserName, ...report }, null, 2), contentType: 'application/json',
  });
  expect(report.cycles).toBe(10_000);
  expect(report.hostTurns).toBe(20);
  expect(report.observedCycleEffects).toBe(30_000);
  expect(report.maximumCycleEffects).toBe(1);
  expect(report.retainedTerminalOwners).toBe(20_000);
  expect(report.terminalAnimations).toBe(0);
  expect(report.terminalJobs).toBe(0);

  const collect = async () => {
    // GC — отдельная проверка достижимости после возврата browser job;
    // число собранных объектов не превращается в heap/raster/GPU bytes.
    for (let round = 0; round < 4; round++) await page.requestGC();
    return page.evaluate(() => {
      const refs = (globalThis as ResourcePage).__resourceReachability!;
      return {
        observedTargets: refs.terminal.length,
        terminal: refs.terminal.filter(ref => ref.deref() !== undefined).length,
        live: Number(refs.live.deref() !== undefined),
        dropped: Number(refs.dropped.deref() !== undefined),
        droppedOwner: Number(refs.droppedOwner.deref() !== undefined),
        deliberate: Number(refs.deliberate.deref() !== undefined),
      };
    });
  };
  const beforeRelease = await collect();
  expect(beforeRelease).toEqual({ observedTargets: 10_000, terminal: 0, live: 1, dropped: 0, droppedOwner: 0, deliberate: 1 });
  await page.evaluate(() => {
    const refs = (globalThis as ResourcePage).__resourceReachability!;
    refs.liveOwner.destroy();
    refs.deliberateOwner = undefined;
  });
  const afterRelease = await collect();
  expect(afterRelease).toEqual({ observedTargets: 10_000, terminal: 0, live: 0, dropped: 0, droppedOwner: 0, deliberate: 0 });
  await info.attach('resource-dom-reachability', {
    body: JSON.stringify({ browserName, beforeRelease, afterRelease }, null, 2), contentType: 'application/json',
  });
});
