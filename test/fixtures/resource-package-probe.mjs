import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';

// Этот файл копируется в приложение, установившее полный tarball. Импорты
// резолвятся только через его package.json, а не через исходный checkout.
const require = createRequire(import.meta.url);
const specifiers = ['@labpics/motion', '@labpics/motion/frame', '@labpics/motion/compositor',
  '@labpics/motion/bindings', '@labpics/motion/behaviors', '@labpics/motion/behaviors/reorder'];
const modules = [];
for (const format of ['esm', 'cjs']) {
  const loaded = [];
  for (const name of specifiers) loaded.push(format === 'esm' ? await import(name) : require(name));
  const [root, frame, compositor, bindings, behaviors, reorder] = loaded;
  modules.push({ format, root, frame, compositor, bindings, behaviors, reorder });
}
const mode = process.argv[2];
assert.ok(['witness', 'lifecycle', 'retention', 'bytes'].includes(mode), 'неизвестный режим RESOURCE proof');
const CYCLES = 10_000;
const SPRING = Object.freeze({ mass: 1, stiffness: 170, damping: 26 });
const KINDS = ['frame', 'motion-value', 'compositor-native', 'compositor-live',
  'compositor-delay', 'compositor-handoff', 'compositor-roundtrip', 'compositor-reduced-loans', 'binding', 'sheet', 'pager',
  'dismiss', 'pull', 'pull-pending', 'pull-settled', 'reorder'];
const CASES = modules.flatMap(mod => KINDS.map(kind => ({ mod, kind, name: `${mod.format}/${kind}` })));
const terminalPromises = [];
const settledPromises = [];

// Array хранится в JS heap: external ArrayBuffer/RSS не подменяют heapUsed.
function component(id, words = 256) { return { id, publications: 0, refreshes: 0, dismissals: 0, payload: new Array(words).fill(id) }; }
function listener(value) { return () => { value.publications++; }; }
function formatter(value) { return number => { void value.id; return number; }; }
function scheduler(value, host) { return callback => { void value.id; return host.requestFrame(callback); }; }
function clock(value, host) { return () => { void value.id; return host.now; }; }
function completion(value) { return () => { value.dismissals++; }; }
function refresh(value, deferred) { return () => { value.refreshes++; return deferred.promise; }; }
function deferred() {
  let resolve;
  // Executor/resolver нейтрален к компоненту. Внешний promise сам по себе
  // не получает права держать component callbacks уничтоженного controller.
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Host-seams измеряют владение package. Реальные raster/GPU bytes этим double
// не измеряются. Stale frame физически дрейнится один раз по RequestFrameFn:
// у этого публичного шва нет cancel handle, но stale callback инертен.
function makeHost() {
  const frames = [], timers = new Map(), effects = new Set();
  let next = 0, now = 0, createdEffects = 0, scheduledFrames = 0;
  return {
    get now() { return now; },
    get pendingFrames() { return frames.length; },
    get pendingTimers() { return timers.size; },
    get activeEffects() { return effects.size; },
    get createdEffects() { return createdEffects; },
    get scheduledFrames() { return scheduledFrames; },
    requestFrame(callback) { frames.push(callback); scheduledFrames++; return ++next; },
    setTimer(callback) { const token = ++next; timers.set(token, callback); return () => { timers.delete(token); }; },
    animate() {
      const effect = { currentTime: 32, cancel() { effects.delete(effect); } };
      effects.add(effect); createdEffects++; return effect;
    },
    step() { now += 16; const batch = frames.splice(0); for (const callback of batch) callback(now); },
    drain() {
      let count = 0;
      while (frames.length) {
        assert.ok(++count <= 1000, 'здоровый runner не достиг terminal snapshot');
        this.step();
      }
    },
    terminalDrain() {
      assert.equal(timers.size, 0, 'terminal owner оставил timer');
      assert.equal(effects.size, 0, 'terminal owner оставил native effect');
      this.step();
      assert.equal(frames.length, 0, 'terminal drain создал следующий frame');
      assert.equal(timers.size, 0, 'terminal drain воскресил timer');
      assert.equal(effects.size, 0, 'terminal drain воскресил native effect');
    },
  };
}

function runCase({ mod, kind, name }, value, terminal) {
  const host = makeHost();
  const notify = listener(value);
  const frame = scheduler(value, host);
  let owners;
  let destroy;
  switch (kind) {
    case 'frame': {
      // cancelAll не делает переиспользуемый FrameLoop permanently dead;
      // component принадлежит callbacks/teardown, не общему scheduler.
      const owner = mod.frame.createFrameLoop({ requestFrame: host.requestFrame });
      const offs = [owner.read(notify), owner.update(notify), owner.render(notify, { onTeardown: notify })];
      host.step();
      assert.equal(value.publications, 3, name + ': здоровый кадр не доставлен');
      destroy = () => { for (const off of offs) off(); owner.cancelAll(); };
      owners = [owner, ...offs];
      break;
    }
    case 'motion-value': {
      const owner = new mod.root.MotionValue({ initial: 0, spring: SPRING, requestFrame: frame });
      const off = owner.onChange(notify);
      owner.setTarget(1); host.step(); owner.setTarget(0.5);
      assert.ok(value.publications > 1, name + ': живое значение не публикуется');
      off(); off();
      const before = value.publications;
      host.step();
      assert.equal(value.publications, before, name + ': unsubscribe действует на живом owner');
      const again = owner.onChange(notify);
      assert.equal(value.publications, before + 1, name + ': повторная подписка доставляет current snapshot');
      owner.stop(); owner.setTarget(0.75);
      // Unsubscribe-handle остаётся у потребителя: destroy обязан разорвать
      // ссылки даже без дополнительного вызова already terminal off.
      destroy = () => { owner.destroy(); owner.setTarget(1); };
      owners = [owner, off, again];
      break;
    }
    case 'compositor-native':
    case 'compositor-live':
    case 'compositor-delay':
    case 'compositor-handoff':
    case 'compositor-roundtrip': {
      const native = kind === 'compositor-native' || kind === 'compositor-handoff' || kind === 'compositor-roundtrip';
      const target = native ? { marker: value, animate: host.animate } : undefined;
      const owner = new mod.compositor.CompositorSpring({
        spring: SPRING, property: 'opacity', from: 0, to: 1, target,
        apply: notify, format: formatter(value), now: clock(value, host), requestFrame: frame,
        delay: kind === 'compositor-delay' ? 100 : 0, setTimer: host.setTimer,
      });
      owner.start();
      if (native) {
        assert.equal(host.createdEffects, 1, name + ': native здоровый контроль не активен');
        assert.equal(host.activeEffects, 1);
      } else if (kind === 'compositor-delay') assert.equal(host.pendingTimers, 1);
      else assert.ok(host.pendingFrames > 0, name + ': live здоровый контроль не активен');
      owner.retarget(0.8);
      if (native) assert.equal(host.activeEffects, 1, name + ': retarget оставил donor effect');
      else assert.equal(host.pendingTimers, 0, name + ': retarget не снял delay');
      let live, off;
      if (kind === 'compositor-handoff' || kind === 'compositor-roundtrip') {
        live = owner.handoffToLive(0.6); off = live.onChange(notify);
        assert.equal(host.activeEffects, 0, name + ': handoff не снял native donor');
        assert.ok(host.pendingFrames > 0, name + ': handoff не запустил live owner');
      }
      host.step();
      if (kind === 'compositor-roundtrip') {
        owner.handoffToCompositor(0.7);
        assert.equal(owner.mode, 'compositor', name + ': reciprocal native successor не принят');
        assert.equal(host.activeEffects, 1, name + ': reciprocal successor не владеет effect');
        const before = value.publications;
        live.setTarget(0.4); host.step();
        assert.equal(value.publications, before, name + ': переданный live donor продолжает публиковаться');
        assert.equal(host.pendingFrames, 0, name + ': переданный live donor создал job');
      }
      destroy = () => { owner.destroy(); owner.start(); owner.retarget(1); };
      owners = [owner, ...(live ? [live, off] : [])];
      break;
    }
    case 'compositor-reduced-loans': {
      const owner = new mod.compositor.CompositorSpring({
        spring: SPRING, property: 'opacity', from: 0, to: 1,
        apply: notify, format: formatter(value), now: clock(value, host), requestFrame: frame,
        matchMedia: () => ({ matches: true }),
      });
      const old = owner.handoffToLive(0.8);
      const oldOff = old.onChange(notify);
      old.setTarget(0.2); host.step(); host.step();
      assert.ok(host.pendingFrames > 0, name + ': здоровый старый loan не активен');
      const next = owner.handoffToLive(0.6);
      const nextOff = next.onChange(notify);
      const before = value.publications;
      old.setTarget(0.4); host.step();
      assert.equal(value.publications, before, name + ': прежний loan продолжает писать');
      assert.equal(host.pendingFrames, 0, name + ': прежний loan продолжает планировать');
      next.setTarget(0.9); host.step();
      assert.ok(host.pendingFrames > 0, name + ': текущий loan потерял ownership');
      destroy = () => { owner.destroy(); old.setTarget(0.1); next.setTarget(0.2); };
      owners = [owner, old, oldOff, next, nextOff];
      break;
    }
    case 'binding': {
      const project = model => { void value.id; return { surface: { opacity: model } }; };
      const owner = mod.bindings.createMotionBinding(project, { surface() { notify(); return host.animate(); } });
      owner.update(0); owner.update(0);
      assert.equal(host.createdEffects, 1, name + ': одна цель перезапускает роль');
      owner.update(1);
      assert.equal(host.createdEffects, 2, name + ': изменённая цель не принята');
      assert.equal(host.activeEffects, 1, name + ': successor не освободил donor');
      destroy = () => { owner.destroy(); owner.update(0.5); assert.equal(owner.state, 'destroyed'); };
      owners = [owner];
      break;
    }
    case 'sheet':
    case 'pager': {
      const sheet = kind === 'sheet';
      const owner = sheet
        ? mod.behaviors.createBottomSheet({ snapPoints: [0, 100, 200], requestFrame: frame, onChange: notify })
        : mod.behaviors.createCarousel({ pageCount: 3, pageSize: 100, requestFrame: frame, onChange: notify });
      const off = owner.subscribe(notify);
      owner.pointerDown({ x: 0, y: 0, t: 0 });
      owner.pointerMove({ x: -60, y: 60, t: 0.05 });
      owner.pointerUp({ x: -60, y: 60, t: 0.1 });
      host.step();
      off(); off();
      const before = value.publications;
      host.step();
      assert.equal(value.publications, before, name + ': unsubscribe не снял listener живого owner');
      const again = owner.subscribe(notify);
      if (sheet) owner.update([0, 80, 160]); else owner.update(3, 80);
      // Новый ввод должен отозвать старую release-очередь того же владельца.
      owner.pointerDown({ x: 0, y: 0, t: 1 });
      owner.pointerMove({ x: -20, y: 20, t: 1.05 });
      owner.pointerCancel();
      assert.ok(host.pendingFrames > 0, name + ': release не создал job');
      assert.ok(value.publications > 0, name + ': подписка не работает');
      destroy = () => { owner.destroy(); owner.pointerDown({ x: 0, y: 0, t: 2 }); };
      owners = [owner, off, again];
      break;
    }
    case 'dismiss': {
      const owner = mod.behaviors.createDragDismiss({
        distanceThreshold: 40, spring: SPRING, requestFrame: frame,
        onChange: notify, onDismiss: completion(value),
      });
      const off = owner.subscribe(notify);
      owner.pointerDown({ x: 0, y: 0, t: 0 });
      owner.pointerMove({ x: 0, y: 60, t: 0.2 });
      owner.pointerUp({ x: 0, y: 60, t: 0.4 });
      host.step();
      assert.ok(host.pendingFrames > 0, name + ': release не запустил runner');
      // Новый ввод отменяет уход прежде onDismiss и возвращает ту же машину.
      owner.pointerDown({ x: 0, y: 0, t: 1 });
      owner.pointerMove({ x: 0, y: 20, t: 1.2 });
      owner.pointerCancel();
      assert.equal(value.dismissals, 0, name + ': отменённый dismiss вызвал completion');
      destroy = () => { owner.destroy(); owner.pointerDown({ x: 0, y: 0, t: 2 }); };
      owners = [owner, off];
      break;
    }
    case 'pull':
    case 'pull-pending':
    case 'pull-settled': {
      const action = deferred();
      const owner = mod.behaviors.createPullToRefresh({
        threshold: 40, resistance: 1, pendingPosition: 60, spring: SPRING,
        requestFrame: frame, onChange: notify, onRefresh: refresh(value, action),
      });
      const off = owner.subscribe(notify);
      owner.pointerDown({ x: 0, y: 0, t: 0 });
      owner.pointerMove({ x: 0, y: 20, t: 0.1 });
      owner.pointerUp({ x: 0, y: 20, t: 0.2 });
      host.step();
      assert.ok(host.pendingFrames > 0, name + ': возврат не запустил runner');
      owner.pointerDown({ x: 0, y: 0, t: 1 });
      owner.pointerMove({ x: 0, y: 60, t: 1.2 });
      if (kind !== 'pull') {
        // value === pendingPosition позволяет достигнуть Promise-владения
        // синхронно; старый выданный возврат остаётся stale и дрейнится ниже.
        owner.pointerUp({ x: 0, y: 60, t: 1.4 });
        assert.equal(owner.state.pending, true, name + ': pending не достигнут');
        assert.equal(value.refreshes, 1, name + ': onRefresh не вызван ровно один раз');
        const pending = owner.state;
        owner.pointerDown({ x: 0, y: 0, t: 2 });
        assert.equal(owner.state, pending, name + ': pending потерял единственного владельца');
      } else {
        owner.pointerCancel();
        assert.equal(value.refreshes, 0, name + ': pointerCancel запустил refresh');
      }
      let released = false;
      destroy = () => {
        if (kind === 'pull-settled') {
          if (!released) {
            released = true;
            settledPromises.push({ host, owner, ref: new WeakRef(value), terminal: true });
            action.resolve();
          }
          return;
        }
        owner.destroy(); owner.pointerDown({ x: 0, y: 0, t: 3 });
        if (!released && kind === 'pull-pending') {
          released = true;
          terminalPromises.push({ host, owner, state: owner.state,
            ref: new WeakRef(value), publications: value.publications });
          action.resolve();
        }
      };
      if (!terminal && kind === 'pull-settled') {
        settledPromises.push({ host, owner, ref: new WeakRef(value), terminal: false });
        action.resolve();
      }
      owners = [owner, off, action];
      break;
    }
    case 'reorder': {
      const items = [{ key: 'a', rect: { x: 0, y: 0, width: 20, height: 20 } },
        { key: 'b', rect: { x: 40, y: 0, width: 20, height: 20 } }];
      const owner = mod.reorder.createReorder({ items, onReorder: notify });
      const before = owner.start('a'); before.step('next');
      assert.equal(value.publications, 1, name + ': proposal не доставлен');
      owner.update(items); before.cancel();
      const after = owner.start('b'); after.step('previous');
      assert.equal(value.publications, 2, name + ': successor session не доставлен');
      destroy = () => { owner.destroy(); before.step('next'); after.step('previous'); };
      owners = [owner, before, after];
      break;
    }
    default: throw new Error(kind);
  }
  if (terminal) {
    destroy(); destroy();
    const publications = value.publications;
    host.terminalDrain();
    assert.equal(value.publications, publications, name + ': terminal listener был вызван');
  }
  // У живого контроля host остаётся вместе с owner: очередь сама является
  // допустимой сильной ссылкой. У terminal host физически пуст.
  return [host, ...owners];
}

async function flushTerminalPromises() {
  await Promise.resolve(); await Promise.resolve();
  for (const check of settledPromises.splice(0)) {
    check.host.drain();
    assert.equal(check.owner.state.phase, 'idle', 'refresh не завершил возврат прежде destroy');
    assert.equal(check.owner.state.pending, false);
    assert.equal(check.owner.state.value, 0);
    const value = check.ref.deref();
    assert.ok(value, 'живой controller потерял component callback до завершения refresh');
    assert.equal(value.refreshes, 1);
    if (check.terminal) {
      const publications = value.publications, state = check.owner.state;
      check.owner.destroy(); check.owner.destroy();
      check.owner.pointerDown({ x: 0, y: 0, t: 3 });
      check.host.terminalDrain();
      assert.equal(value.publications, publications, 'settled destroy вызвал terminal listener');
      assert.equal(check.owner.state, state, 'settled destroy был отменён поздним вводом');
    }
  }
  for (const check of terminalPromises.splice(0)) {
    assert.equal(check.owner.state, check.state, 'поздний refresh изменил terminal state');
    check.host.terminalDrain();
    assert.equal(check.owner.state, check.state, 'поздний refresh-frame изменил terminal state');
    const value = check.ref.deref();
    if (value) assert.equal(value.publications, check.publications, 'поздний refresh вызвал terminal listener');
  }
}

function setup(testCase, id, terminal, weak, words = 256) {
  const value = component(id, words);
  const ref = weak ? new WeakRef(value) : undefined;
  const owners = runCase(testCase, value, terminal);
  testCase.completed = (testCase.completed ?? 0) + 1;
  return { ref, owners };
}

function resetExecutions() { for (const testCase of CASES) testCase.completed = 0; }
function executions() { return CASES.map(testCase => ({ name: testCase.name, cycles: testCase.completed })); }

function activeUnsubscribe(mod, kind) {
  const value = component(4);
  const ref = new WeakRef(value);
  const host = makeHost();
  const progress = { publications: 0 };
  const notify = listener(value);
  const constructorListener = kind.endsWith('-constructor');
  const behaviorKind = kind.replace('-constructor', '');
  let owner, off;
  if (kind === 'motion-value') {
    owner = new mod.root.MotionValue({ initial: 0, spring: SPRING, requestFrame: host.requestFrame });
    off = owner.onChange(notify);
    owner.onChange(listener(progress));
    off(); off();
    owner.setTarget(1); host.step();
    assert.ok(progress.publications > 1, 'unsubscribe остановил соседний listener живого MotionValue');
  } else {
    owner = behaviorKind === 'sheet'
      ? mod.behaviors.createBottomSheet({ snapPoints: [0, 100], requestFrame: host.requestFrame,
          onChange: constructorListener ? notify : undefined })
      : behaviorKind === 'pager'
        ? mod.behaviors.createCarousel({ pageCount: 2, pageSize: 100, requestFrame: host.requestFrame,
            onChange: constructorListener ? notify : undefined })
        : kind === 'dismiss'
          ? mod.behaviors.createDragDismiss({ distanceThreshold: 40, requestFrame: host.requestFrame })
          : mod.behaviors.createPullToRefresh({ threshold: 40, resistance: 1, requestFrame: host.requestFrame });
    // Даже callback из constructor-options использует ту же Set identity:
    // off повторной subscribe снимает запись и не удерживает receiver options.
    off = owner.subscribe(notify);
    owner.subscribe(listener(progress));
    off(); off();
    if (behaviorKind === 'sheet') owner.snapTo(1);
    else if (behaviorKind === 'pager') owner.goTo(1);
    else {
      owner.pointerDown({ x: 0, y: 0, t: 0 });
      owner.pointerMove({ x: 0, y: 20, t: 0.1 });
      owner.pointerUp({ x: 0, y: 20, t: 0.2 });
    }
    host.step();
    assert.ok(progress.publications > 0, 'unsubscribe остановил соседний listener живого behavior');
  }
  return { ref, owners: [owner, off, host, progress] };
}

function promiseRoot(mod, kind) {
  const value = component(5), ref = new WeakRef(value), action = deferred();
  if (kind === 'user-owned') {
    action.promise.then(listener(value));
    return { ref, owners: [action] };
  }
  const host = makeHost();
  const owner = mod.behaviors.createPullToRefresh({
    threshold: 40, resistance: 1, pendingPosition: 60,
    requestFrame: host.requestFrame, onRefresh: refresh(value, action),
  });
  const off = owner.subscribe(listener(value));
  owner.pointerDown({ x: 0, y: 0, t: 0 });
  owner.pointerMove({ x: 0, y: 60, t: 0.1 });
  owner.pointerUp({ x: 0, y: 60, t: 0.2 });
  assert.equal(owner.state.pending, true);
  assert.equal(value.refreshes, 1);
  if (kind !== 'live') { owner.destroy(); host.terminalDrain(); }
  return { ref, owners: kind === 'promise-only' ? [action] : [owner, off, action, host] };
}

async function promiseHealthy(mod) {
  const value = component(6), action = deferred(), host = makeHost();
  const owner = mod.behaviors.createPullToRefresh({
    threshold: 40, resistance: 1, pendingPosition: 60, requestFrame: host.requestFrame,
    onRefresh: refresh(value, action), onChange: listener(value),
  });
  owner.pointerDown({ x: 0, y: 0, t: 0 });
  owner.pointerMove({ x: 0, y: 60, t: 0.1 });
  owner.pointerUp({ x: 0, y: 60, t: 0.2 });
  assert.equal(owner.state.pending, true);
  assert.equal(value.refreshes, 1);
  assert.equal(host.pendingFrames, 0);
  action.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.ok(host.pendingFrames > 0, 'healthy Promise не продолжил возврат');
  host.drain();
  assert.equal(owner.state.phase, 'idle'); assert.equal(owner.state.pending, false);
  assert.equal(owner.state.value, 0);
  owner.destroy(); host.terminalDrain();
  const dismiss = mod.behaviors.createDragDismiss({
    distanceThreshold: 40, dismissTarget: 80, matchMedia: () => ({ matches: true }),
    requestFrame: host.requestFrame, onDismiss: completion(value),
  });
  dismiss.pointerDown({ x: 0, y: 0, t: 0 });
  dismiss.pointerMove({ x: 0, y: 60, t: 0.1 });
  dismiss.pointerUp({ x: 0, y: 60, t: 0.2 });
  assert.equal(value.dismissals, 1, 'healthy onDismiss не выполнен');
  assert.equal(dismiss.state.dismissed, true);
  dismiss.destroy(); host.terminalDrain();
}
async function collect(rounds = 4) {
  assert.equal(typeof globalThis.gc, 'function', '--expose-gc отсутствует');
  for (let round = 0; round < rounds; round++) { await setImmediate(); globalThis.gc(); }
}
const countAlive = refs => refs.reduce((count, ref) => count + (ref.deref() === undefined ? 0 : 1), 0);

if (mode === 'lifecycle') {
  resetExecutions();
  for (const testCase of CASES) for (let cycle = 0; cycle < CYCLES; cycle++) setup(testCase, cycle, true, false, 0);
  await flushTerminalPromises();
  const caches = modules.map(mod => {
    const cache = mod.compositor.createSpringLinearCache(2);
    for (let i = 0; i < 20; i++) cache.compile({ mass: 1, stiffness: 120 + i, damping: 26 });
    assert.equal(cache.capacity, 2); assert.equal(cache.size, 2);
    cache.clear(); assert.equal(cache.size, 0);
    const defaults = mod.compositor.createSpringLinearCache();
    assert.equal(defaults.capacity, 256, 'зарегистрированная ёмкость default-cache изменилась');
    for (let i = 0; i < 260; i++) defaults.compile({ mass: 1, stiffness: 120 + i, damping: 26 });
    assert.equal(defaults.size, 256, 'default-cache не вытесняет сверх frozen capacity');
    defaults.clear(); assert.equal(defaults.size, 0);
    return { format: mod.format, isolatedCapacity: cache.capacity, defaultCapacity: defaults.capacity, finalSize: 0 };
  });
  console.log(JSON.stringify({ status: 'pass', mode, cyclesPerOwner: CYCLES,
    executions: executions(), terminal: { effects: 0, jobs: 0, publications: 0 }, caches }));
} else if (mode === 'retention' || mode === 'witness') {
  const count = mode === 'witness' ? 1 : CYCLES;
  const terminalOwners = [], terminalRefs = CASES.map(() => []), droppedRefs = [], liveOwners = [], liveRefs = [];
  const unsubscribedOwners = [], unsubscribedRefs = [];
  const promiseOwners = [], promiseRefs = { live: [], terminal: [], 'promise-only': [], 'user-owned': [] };
  for (const mod of modules) {
    await promiseHealthy(mod);
    for (const kind of Object.keys(promiseRefs)) {
      const result = promiseRoot(mod, kind);
      promiseOwners.push(result.owners); promiseRefs[kind].push(result.ref);
    }
  }
  for (const mod of modules) for (const kind of ['motion-value', 'sheet', 'sheet-constructor',
    'pager', 'pager-constructor', 'dismiss', 'pull']) {
    const result = activeUnsubscribe(mod, kind);
    unsubscribedOwners.push(result.owners); unsubscribedRefs.push(result.ref);
  }
  for (const testCase of CASES) {
    const control = setup(testCase, 1, false, true);
    liveOwners.push(control.owners); liveRefs.push(control.ref);
    droppedRefs.push(setup(testCase, 2, true, true).ref);
  }
  const deliberateOwners = [component(3)], deliberateRefs = [new WeakRef(deliberateOwners[0])];
  resetExecutions();
  for (let cycle = 0; cycle < count; cycle++) {
    for (let index = 0; index < CASES.length; index++) {
      const result = setup(CASES[index], cycle, true, true);
      terminalOwners.push(result.owners); terminalRefs[index].push(result.ref);
    }
    if ((cycle + 1) % 500 === 0) { await flushTerminalPromises(); await collect(2); }
  }
  // Глобальная достижимость не позволяет оптимизатору выбросить контролируемые roots.
  globalThis.__resourceControls = { terminalOwners, liveOwners, deliberateOwners, unsubscribedOwners, promiseOwners };
  await flushTerminalPromises();
  await collect(16);
  const owners = CASES.map((testCase, index) => ({ name: testCase.name, retained: countAlive(terminalRefs[index]) }));
  const retainedComponentReferences = owners.reduce((total, owner) => total + owner.retained, 0);
  const controls = { live: countAlive(liveRefs), expectedLive: CASES.length,
    dropped: countAlive(droppedRefs), deliberate: countAlive(deliberateRefs),
    unsubscribedActive: countAlive(unsubscribedRefs), activeOwnersWithHealthySibling: unsubscribedOwners.length,
    promiseRoots: Object.fromEntries(Object.entries(promiseRefs).map(([name, refs]) => [name, countAlive(refs)])),
    healthyPromiseCompletions: modules.length, healthyDismissCompletions: modules.length };
  const passed = retainedComponentReferences === 0 && controls.live === CASES.length
    && controls.dropped === 0 && controls.deliberate === 1 && controls.unsubscribedActive === 0
    && controls.promiseRoots.live === 2 && controls.promiseRoots.terminal === 0
    && controls.promiseRoots['promise-only'] === 0 && controls.promiseRoots['user-owned'] === 2;
  const report = { status: passed ? 'pass' : 'fail', mode, cyclesPerOwner: count, executions: executions(),
    retainedComponentReferences, retainedComponentPayloadBytes: retainedComponentReferences === 0 ? 0 : null, owners, controls };
  console.log(JSON.stringify(report));
  assert.equal(controls.live, CASES.length, 'live-owner control собран преждевременно');
  assert.equal(controls.dropped, 0, 'dropped-owner control остался достижим');
  assert.equal(controls.deliberate, 1, 'deliberate-retention control не обнаружен');
  assert.equal(controls.unsubscribedActive, 0, 'retained off удерживает компонент при живом owner');
  assert.equal(controls.promiseRoots.live, 2, 'live Promise control потерял компонент');
  assert.equal(controls.promiseRoots.terminal, 0, 'terminal controller удерживает onRefresh при нейтральном внешнем Promise');
  assert.equal(controls.promiseRoots['promise-only'], 0, 'motion continuation удерживает компонент через нейтральный внешний Promise');
  assert.equal(controls.promiseRoots['user-owned'], 2, 'внешний пользовательский Promise callback не различается');
  assert.equal(retainedComponentReferences, 0, 'terminal controls удерживают уничтоженные компоненты');
} else {
  // До candidate фиксированы измеримость и правило отказа. Полоса — разрешение
  // стенда, не новый budget продукта: шире 256 KiB калибровка не принимается.
  // Контрольный Array содержит 131 072 элемента; измеренный сигнал должен
  // различаться минимум в 4× band независимо от представления элементов V8.
  const MAX_RESOLVABLE_BAND = 256 * 1024;
  const READOUT_ALLOWANCE = 8 * 1024;
  const CONTROL_WORDS = 128 * 1024;
  const batch = cycles => { for (let i = 0; i < cycles; i++) for (const testCase of CASES) setup(testCase, i, true, false); };
  const memory = async () => { await flushTerminalPromises(); await collect(); return process.memoryUsage(); };
  const heap = async () => (await memory()).heapUsed;
  batch(256);
  await heap();
  const calibration = [];
  for (let i = 0; i < 8; i++) { batch(128); calibration.push(await heap()); }
  const low = Math.min(...calibration), high = Math.max(...calibration);
  const band = high - low + READOUT_ALLOWANCE;
  const baseline = { low, high, band, maximumResolvableBand: MAX_RESOLVABLE_BAND, samples: calibration };
  console.log(JSON.stringify({ phase: 'baseline', mode, baseline }));
  assert.ok(band <= MAX_RESOLVABLE_BAND, 'named gap: A/A heap baseline не разрешает 256 KiB; candidate admission не запущен');

  let deliberate = [component(1, CONTROL_WORDS)];
  globalThis.__resourceBytesControls = deliberate;
  const deliberateHeap = await heap();
  const deliberateSignal = deliberateHeap - high;
  assert.ok(deliberateSignal >= 4 * band, 'named gap: deliberate-retention bytes не различаются от A/A baseline');
  deliberate = undefined; globalThis.__resourceBytesControls = undefined;
  const releasedControl = await heap();
  assert.ok(releasedControl <= high + band, 'deliberate control не вернулся в baseline после release');

  let live = [setup(CASES.find(testCase => testCase.name === 'esm/compositor-native'), 2, false, false, CONTROL_WORDS).owners];
  globalThis.__resourceBytesControls = live;
  const liveHeap = await heap();
  const liveSignal = liveHeap - high;
  assert.ok(liveSignal >= 4 * band, 'named gap: live-owner bytes не различаются от A/A baseline');
  live = undefined; globalThis.__resourceBytesControls = undefined;
  const droppedControl = await heap();
  assert.ok(droppedControl <= high + band, 'dropped owner не вернулся в baseline');

  const samples = [];
  resetExecutions();
  for (let prefix = 2000; prefix <= CYCLES; prefix += 2000) {
    batch(2000);
    const measured = await memory();
    samples.push({ cyclesPerOwner: prefix, ...measured });
  }
  const excess = samples.map(sample => Math.max(0, sample.heapUsed - high - band));
  const report = { status: excess.every(bytes => bytes === 0) ? 'pass' : 'fail', mode, cyclesPerOwner: CYCLES,
    executions: executions(), baseline,
    controls: { deliberateHeap, deliberateSignal, releasedControl, liveHeap, liveSignal, droppedControl }, samples, excess,
    accounting: { componentPayload: 'JS Array', boundedCaches: 'warmed before A/A',
      terminalShells: 'отдельный retention proof; в bytes owners dropped',
      process: 'heapUsed, heapTotal, external, arrayBuffers и rss показаны отдельно',
      nativeGpuBytes: 'не измерены этим Node host' } };
  console.log(JSON.stringify(report));
  assert.ok(excess.every(bytes => bytes === 0), 'retained heap вышел из заранее разрешённой baseline-полосы');
}
