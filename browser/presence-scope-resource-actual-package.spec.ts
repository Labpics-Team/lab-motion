import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures/harness';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type OwnersPackage = Pick<typeof import('../src/animate/index.js'), 'createAnimateScope'>
  & Pick<typeof import('../src/presence/index.js'), 'createPresenceTransition'>;
type Owner = { destroy(): void };
type DomControls = {
  owners: unknown[];
  terminal: { presence: Array<WeakRef<HTMLElement>>; scope: Array<WeakRef<HTMLElement>> };
  live: { presence: WeakRef<HTMLElement>; scope: WeakRef<HTMLElement> };
  liveOwners: Owner[];
  dropped: { presence: WeakRef<HTMLElement>; scope: WeakRef<HTMLElement> };
  deliberate: WeakRef<HTMLElement>;
  deliberateOwner: HTMLElement | undefined;
};
type ResourcePage = typeof globalThis & { __presenceScopeResource?: DomControls };

test('RESOURCE-01: packed presence/scope освобождают реальные DOM roots при сохранённых terminal controls', async ({ page, browserName }, info) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const receiptBytes = readFileSync(join(ROOT, 'browser/.artifacts/presence-scope-resource.package.json'));
  const receipt = JSON.parse(receiptBytes.toString('utf8')) as {
    schema: string; tarball: { sha256: string }; bundleSha256: string;
  };
  const shared = JSON.parse(readFileSync(join(ROOT, 'browser/.artifacts/scope-recipes.package.json'), 'utf8')) as {
    tarball: { file: string; sha256: string };
  };
  expect(receipt.schema).toBe('presence-scope-resource-package-v1');
  expect(receipt.tarball.sha256).toBe(shared.tarball.sha256);
  expect(createHash('sha256').update(readFileSync(join(ROOT, 'browser/.artifacts', shared.tarball.file))).digest('hex'))
    .toBe(receipt.tarball.sha256);
  expect(createHash('sha256').update(readFileSync(join(ROOT, 'browser/.artifacts/presence-scope-resource.js'))).digest('hex'))
    .toBe(receipt.bundleSha256);
  const fetched = await page.evaluate(async ({ archive }) => {
    const digest = async (path: string): Promise<string> => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`resource artifact fetch failed: ${path}`);
      const bytes = await response.arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
    };
    return { archive: await digest(`/browser/.artifacts/${archive}`),
      bundle: await digest('/browser/.artifacts/presence-scope-resource.js') };
  }, { archive: shared.tarball.file });
  expect(fetched.archive).toBe(receipt.tarball.sha256);
  expect(fetched.bundle).toBe(receipt.bundleSha256);
  await info.attach('installed-package-tuple', { body: receiptBytes, contentType: 'application/json' });

  const report = await page.evaluate(async () => {
    const url = '/browser/.artifacts/presence-scope-resource.js';
    const { createAnimateScope, createPresenceTransition } = await import(url) as OwnersPackage;
    const spring = Object.freeze({ mass: 1, stiffness: 170, damping: 26 });
    const timers = new Map<number, () => void>();
    let timerId = 0, effects = 0, naturalCompletions = 0;
    const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
    const ownTimers = () => {
      const tokens = new Set<number>();
      return {
        setTimer(callback: () => void): (() => void) {
          const token = ++timerId; tokens.add(token); timers.set(token, callback);
          return () => { tokens.delete(token); timers.delete(token); };
        },
        finish(): void {
          const pending = [...tokens].map(token => timers.get(token)!);
          for (const token of tokens) timers.delete(token);
          tokens.clear();
          for (const callback of pending) callback();
        },
      };
    };
    const target = (): HTMLDivElement => {
      const element = document.createElement('div');
      element.style.cssText = 'opacity:0;width:20px;height:20px';
      const animate = element.animate;
      element.animate = (keyframes, options) => {
        effects++;
        const effect = Reflect.apply(animate, element, [keyframes, options]) as Animation;
        effect.pause(); effect.currentTime = 32;
        assert(effect.effect instanceof KeyframeEffect && effect.effect.target === element,
          'positive control requires an actual native target/effect');
        return effect;
      };
      return element;
    };
    const factory = (element: HTMLElement) => () => element.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: 1000, fill: 'both' });
    const completed = (root: HTMLElement) => () => { root.dataset.completed = 'yes'; naturalCompletions++; };
    const presence = (terminal: boolean) => {
      const element = target(); document.body.append(element);
      const phase = factory(element);
      const owner = createPresenceTransition({ enter: phase, exit: phase });
      const first = owner.setPresent(true);
      assert(owner.setPresent(true) === first, 'same presence target restarted its phase');
      const middle = owner.setPresent(false), pending = owner.setPresent(true);
      assert(element.getAnimations().length === 1, 'healthy current presence lost native ownership');
      if (terminal) {
        owner.destroy();
        assert(element.getAnimations().length === 0, 'terminal presence kept native ownership');
      }
      element.remove();
      return { owner, ref: new WeakRef(element), retained: [owner, first, middle, pending],
        pending: terminal ? Promise.all([first, middle, pending]).then(results => {
          assert(results[0]!.status === 'superseded' && results[0]!.present,
            'native presence enter lost superseded outcome');
          assert(results[1]!.status === 'superseded' && !results[1]!.present,
            'native presence exit lost superseded outcome');
          assert(results[2]!.status === 'destroyed' && results[2]!.present,
            'native presence terminal outcome changed');
        }) : undefined };
    };
    const scope = (terminal: boolean) => {
      const root = document.createElement('section');
      const elements = [target(), target(), target()]; root.append(...elements); document.body.append(root);
      const owner = createAnimateScope(root);
      const timer = ownTimers();
      const options = { spring, setTimer: timer.setTimer, now: () => 0, onComplete: completed(root) };
      const initial = owner.animate('div', { opacity: [0, 1] }, options);
      assert(elements.every(element => element.getAnimations().length === 1), 'healthy scope is not native');
      timer.finish();
      assert(elements.every(element => element.getAnimations().length === 0), 'natural terminal kept native effects');
      const active = owner.animate(elements[0]!, { opacity: [0, .8] }, options);
      const paused = owner.animate(elements[1]!, { opacity: [0, .6] }, options); paused.pause();
      const delayed = owner.animate(elements[2]!, { opacity: [0, .4] }, { ...options, delay: 1000 });
      assert(elements[0]!.getAnimations().length === 1 && elements[1]!.getAnimations().length === 0
        && elements[2]!.getAnimations().length === 1, 'current/paused/delayed ownership denominator');
      if (terminal) {
        owner.destroy();
        for (const controls of [initial, active, paused, delayed]) {
          controls.play(); controls.pause(); controls.seek(32); controls.cancel(); controls.stop();
        }
        assert(elements.every(element => element.getAnimations().length === 0), 'terminal controls restarted native ownership');
      }
      root.remove();
      return { owner, refs: [root, ...elements].map(element => new WeakRef(element)),
        retained: [owner, initial, active, paused, delayed],
        pending: terminal ? Promise.all([initial.finished, active.finished, paused.finished, delayed.finished]) : undefined };
    };
    const terminal: DomControls['terminal'] = { presence: [], scope: [] };
    const owners: unknown[] = [];
    let cycles = 0, hostTurns = 0;
    for (; cycles < 10_000; cycles++) {
      const p = presence(true), s = scope(true);
      terminal.presence.push(p.ref); terminal.scope.push(...s.refs);
      owners.push(p.retained, s.retained);
      await p.pending; await s.pending;
      assert(timers.size === 0 && document.getAnimations().length === 0, 'terminal boundary kept jobs/native effects');
      if ((cycles + 1) % 100 === 0) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); hostTurns++;
        assert(timers.size === 0 && document.getAnimations().length === 0, 'host turn revived terminal resources');
      }
    }
    const livePresence = presence(false), liveScope = scope(false);
    const droppedPresence = presence(true), droppedScope = scope(true);
    await droppedPresence.pending; await droppedScope.pending;
    const deliberate = document.createElement('div');
    (globalThis as ResourcePage).__presenceScopeResource = {
      owners, terminal,
      live: { presence: livePresence.ref, scope: liveScope.refs[0]! },
      liveOwners: [livePresence.owner, liveScope.owner],
      dropped: { presence: droppedPresence.ref, scope: droppedScope.refs[0]! },
      deliberate: new WeakRef(deliberate), deliberateOwner: deliberate,
    };
    return { cyclesPerOwner: cycles, hostTurns, effects, naturalCompletions,
      terminalTargets: { presence: terminal.presence.length, scope: terminal.scope.length },
      retainedTerminalOwnerGroups: owners.length,
      claim: 'actual DOM reachability only; heap/raster/GPU bytes and probabilities are not measured' };
  });
  expect(report.cyclesPerOwner).toBe(10_000);
  expect(report.hostTurns).toBe(100);
  expect(report.terminalTargets).toEqual({ presence: 10_000, scope: 40_000 });
  expect(report.retainedTerminalOwnerGroups).toBe(20_000);
  expect(report.naturalCompletions).toBe(10_002);
  const collect = async () => {
    for (let round = 0; round < 4; round++) await page.requestGC();
    return page.evaluate(() => {
      const refs = (globalThis as ResourcePage).__presenceScopeResource!;
      const count = (list: Array<WeakRef<HTMLElement>>) => list.filter(ref => ref.deref() !== undefined).length;
      return { terminal: { presence: count(refs.terminal.presence), scope: count(refs.terminal.scope) },
        live: { presence: Number(refs.live.presence.deref() !== undefined), scope: Number(refs.live.scope.deref() !== undefined) },
        dropped: { presence: Number(refs.dropped.presence.deref() !== undefined), scope: Number(refs.dropped.scope.deref() !== undefined) },
        deliberate: Number(refs.deliberate.deref() !== undefined) };
    });
  };
  const beforeRelease = await collect();
  expect(beforeRelease).toEqual({ terminal: { presence: 0, scope: 0 }, live: { presence: 1, scope: 1 },
    dropped: { presence: 0, scope: 0 }, deliberate: 1 });
  await page.evaluate(() => {
    const refs = (globalThis as ResourcePage).__presenceScopeResource!;
    for (const owner of refs.liveOwners) owner.destroy();
    refs.deliberateOwner = undefined;
  });
  const afterRelease = await collect();
  expect(afterRelease).toEqual({ terminal: { presence: 0, scope: 0 }, live: { presence: 0, scope: 0 },
    dropped: { presence: 0, scope: 0 }, deliberate: 0 });
  await info.attach('resource-presence-scope-dom', { body: JSON.stringify({ browserName, ...report,
    beforeRelease, afterRelease }, null, 2), contentType: 'application/json' });
});
