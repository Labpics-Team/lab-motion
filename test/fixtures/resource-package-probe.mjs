import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';

// Этот файл копируется в приложение, установившее полный tarball. Импорты
// резолвятся только через его package.json, а не через исходный checkout.
const require = createRequire(import.meta.url);
const specifiers = ['@labpics/motion', '@labpics/motion/frame', '@labpics/motion/compositor',
  '@labpics/motion/bindings', '@labpics/motion/behaviors', '@labpics/motion/behaviors/reorder',
  '@labpics/motion/compositor/follow', '@labpics/motion/presence', '@labpics/motion/animate'];
const modules = [];
for (const format of ['esm', 'cjs']) {
  const loaded = [];
  for (const name of specifiers) loaded.push(format === 'esm' ? await import(name) : require(name));
  const [root, frame, compositor, bindings, behaviors, reorder, follow, presence, animate] = loaded;
  modules.push({ format, root, frame, compositor, bindings, behaviors, reorder, follow, presence, animate });
}
const mode = process.argv[2];
assert.ok(['witness', 'lifecycle', 'retention', 'bytes', 'reentry'].includes(mode), 'неизвестный режим RESOURCE proof');
const CYCLES = 10_000;
const SPRING = Object.freeze({ mass: 1, stiffness: 170, damping: 26 });
const EXISTING_KINDS = ['frame', 'motion-value', 'compositor-native', 'compositor-live',
  'compositor-delay', 'compositor-handoff', 'compositor-roundtrip', 'compositor-reduced-loans', 'binding', 'sheet', 'pager',
  'dismiss', 'pull', 'pull-pending', 'pull-settled', 'reorder',
  'follow-native', 'follow-pickup', 'follow-live'];
const ADDED_KINDS = ['presence-transition', 'animate-scope-main', 'animate-scope-native'];
const corpus = process.argv[3] ?? 'combined';
assert.ok(['existing', 'presence-scope', 'combined'].includes(corpus), 'неизвестный RESOURCE corpus');
const ALL_CASES = modules.flatMap(mod => [...EXISTING_KINDS, ...ADDED_KINDS]
  .map(kind => ({ mod, kind, name: `${mod.format}/${kind}` })));
const CASES = ALL_CASES.filter(({ kind }) => corpus === 'combined'
  || (corpus === 'existing' ? EXISTING_KINDS : ADDED_KINDS).includes(kind));
const terminalPromises = [];
const settledPromises = [];
const componentPromises = [];

// Array хранится в JS heap: external ArrayBuffer/RSS не подменяют heapUsed.
function component(id, words = 256) { return { id, publications: 0, refreshes: 0, dismissals: 0, payload: new Array(words).fill(id) }; }
function listener(value) { return () => { value.publications++; }; }
function formatter(value) { return number => { void value.id; return number; }; }
function scheduler(value, host) { return callback => { void value.id; return host.requestFrame(callback); }; }
function clock(value, host) { return () => { void value.id; return host.now; }; }
function completion(value) { return () => { value.dismissals++; }; }
function refresh(value, deferred) { return () => { value.refreshes++; return deferred.promise; }; }
const LINEAR = t => t;
function scopeTarget(value, host, native) {
  const notify = listener(value);
  return { marker: value, style: {
    getPropertyValue: () => '', setProperty: notify, removeProperty: notify,
  }, ...(native ? { animate: host.animate } : {}) };
}
function scopeRoot(value, elements) { return { marker: value, querySelectorAll: () => elements }; }
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
// Все terminal host-объекты остаются roots. Общий prototype и отсутствие
// пустых очередей отделяют стоимость observer от удержания package owners.
class ResourceHost {
  #frames;
  #timers;
  #effects;
  #next = 0;
  #now = 0;
  #createdEffects = 0;
  #cancelledEffects = 0;
  #scheduledFrames = 0;

  get now() { return this.#now; }
  get pendingFrames() { return this.#frames?.length ?? 0; }
  get pendingTimers() { return this.#timers?.size ?? 0; }
  get activeEffects() { return this.#effects?.size ?? 0; }
  get createdEffects() { return this.#createdEffects; }
  get cancelledEffects() { return this.#cancelledEffects; }
  get scheduledFrames() { return this.#scheduledFrames; }
  requestFrame = callback => { (this.#frames ??= []).push(callback); this.#scheduledFrames++; return ++this.#next; };
  setTimer = callback => {
    const token = ++this.#next; (this.#timers ??= new Map()).set(token, callback);
    return () => {
      this.#timers?.delete(token);
      if (this.#timers?.size === 0) this.#timers = undefined;
    };
  };
  animate = () => {
    const effect = { currentTime: 32, cancel: () => {
      this.#cancelledEffects++;
      this.#effects?.delete(effect);
      if (this.#effects?.size === 0) this.#effects = undefined;
    } };
    (this.#effects ??= new Set()).add(effect); this.#createdEffects++; return effect;
  };
  step() {
    this.#now += 16;
    const batch = this.#frames ?? [];
    this.#frames = undefined;
    for (const callback of batch) callback(this.#now);
  }
  finishTimers() {
    const callbacks = [...(this.#timers?.values() ?? [])];
    this.#timers = undefined;
    for (const callback of callbacks) callback();
  }
  drain() {
    let count = 0;
    while (this.pendingFrames) {
      assert.ok(++count <= 1000, 'здоровый runner не достиг terminal snapshot');
      this.step();
    }
  }
  terminalDrain() {
    assert.equal(this.pendingTimers, 0, 'terminal owner оставил timer');
    assert.equal(this.activeEffects, 0, 'terminal owner оставил native effect');
    assert.equal(this.cancelledEffects, this.createdEffects, 'native effects должны отменяться ровно один раз');
    this.step();
    assert.equal(this.pendingFrames, 0, 'terminal drain создал следующий frame');
    assert.equal(this.pendingTimers, 0, 'terminal drain воскресил timer');
    assert.equal(this.activeEffects, 0, 'terminal drain воскресил native effect');
    assert.equal(this.cancelledEffects, this.createdEffects, 'stale callback повторно отменил native effect');
  }
}
function makeHost() { return new ResourceHost(); }

function runCase({ mod, kind, name }, value, terminal) {
  const host = makeHost();
  const notify = listener(value);
  const frame = scheduler(value, host);
  let owners;
  let destroy;
  let terminalCheck;
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
    case 'follow-native':
    case 'follow-pickup':
    case 'follow-live': {
      const target = { marker: value, animate() {
        const effect = host.animate(); effect.target = this; return effect;
      } };
      const owner = mod.follow.createCompositorFollow({
        spring: { ...SPRING, owner: value }, property: 'opacity', from: 0, to: 1, target,
        apply: notify, format: formatter(value), now: clock(value, host), requestFrame: frame,
      });
      owner.beginFollow(0); owner.follow(0.2, 0.02); owner.settle(1, 0.02);
      assert.equal(host.activeEffects, 1, name + ': native settle не создал владельца');
      assert.equal(host.pendingFrames, 0, name + ': native settle создал frame');
      const loans = [];
      if (kind === 'follow-live') {
        const donor = owner.handoffToLive(0.6), off = donor.onChange(notify);
        loans.push(donor, off);
        host.step(); host.step();
        assert.ok(host.pendingFrames > 0, name + ': live donor не работает');
        owner.beginFollow(0.03);
        const before = value.publications;
        donor.setTarget(0.1); host.step();
        assert.equal(value.publications, before, name + ': pickup не отозвал live donor');
        assert.equal(host.pendingFrames, 0, name + ': старый donor создал следующий frame');
        owner.follow(0.4, 0.04);
        const live = owner.handoffToLive(0.7), liveOff = live.onChange(notify);
        loans.push(live, liveOff);
        host.step();
        assert.ok(host.pendingFrames > 0, name + ': новый live owner не работает');
      } else if (kind === 'follow-pickup') {
        owner.beginFollow(0.03); owner.follow(0.4, 0.04);
      }
      assert.equal(host.activeEffects, kind === 'follow-native' ? 1 : 0,
        name + ': pickup оставил native donor');
      assert.ok(value.publications > 0, name + ': здоровый follow не доставил ввод');
      destroy = () => {
        owner.destroy(); owner.beginFollow(2); owner.follow(0.5, 2); owner.settle(1, 2);
        owner.start(); owner.retarget(1);
        for (const loan of loans) if (typeof loan !== 'function') loan.setTarget(0.2);
      };
      owners = [owner, ...loans];
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
    case 'presence-transition': {
      const action = deferred();
      const phase = () => {
        notify();
        return { ...host.animate(), finished: action.promise };
      };
      const owner = mod.presence.createPresenceTransition({ enter: phase, exit: phase,
        onPresent: completion(value), onGone: completion(value) });
      const enter = owner.setPresent(true);
      assert.equal(owner.setPresent(true), enter, name + ': повтор цели создал другую фазу');
      const exit = owner.setPresent(false);
      const pending = owner.setPresent(true);
      assert.equal(host.createdEffects, 3, name + ': interruption не создало successor');
      assert.equal(host.cancelledEffects, 2, name + ': supersede не снял прежние effects');
      assert.equal(host.activeEffects, 1, name + ': current phase не владеет effect');
      assert.equal(value.publications, 3, name + ': здоровые factory не выполнены');
      destroy = () => {
        owner.destroy();
        assert.equal(owner.state, 'destroyed');
        assert.equal(owner.setPresent(false), pending, name + ': terminal input создал Promise');
      };
      if (terminal) {
        terminalCheck = { name, kind, host, owner, pending,
          earlier: [enter, exit], ref: new WeakRef(value) };
        componentPromises.push(terminalCheck);
      }
      // Нейтральный незавершённый Promise не является consumer callback-root.
      owners = [owner, enter, exit, pending, action];
      break;
    }
    case 'animate-scope-main':
    case 'animate-scope-native': {
      const native = kind === 'animate-scope-native';
      const elements = [scopeTarget(value, host, native), scopeTarget(value, host, native), scopeTarget(value, host, native)];
      const root = scopeRoot(value, elements);
      const owner = mod.animate.createAnimateScope(root);
      const options = { ...(native ? { spring: SPRING } : { duration: 1000, ease: LINEAR }),
        requestFrame: frame, now: clock(value, host), setTimer: host.setTimer,
        onComplete: completion(value) };
      const initial = owner.animate('.surface', { opacity: [0, 1] }, options);
      host.step();
      if (native) {
        assert.equal(host.activeEffects, 3, name + ': native scope не владеет effects');
        host.finishTimers();
        assert.equal(host.activeEffects, 0, name + ': natural completion не освободило effects');
        assert.equal(value.dismissals, 1, name + ': natural completion callback');
      }
      else assert.ok(value.publications > 0, name + ': живой scope не пишет');
      const active = owner.animate(elements[0], { opacity: [0, 0.8] }, options);
      const paused = owner.animate(elements[1], { opacity: [0, 0.6] }, options);
      paused.pause();
      const delayed = owner.animate(elements[2], { opacity: [0, 0.4] }, { ...options, delay: 1000 });
      host.step();
      if (native) assert.equal(host.activeEffects, 2, name + ': current/paused/delayed native ownership');
      else assert.ok(host.pendingFrames > 0, name + ': active/delayed scope потерял scheduler');
      destroy = () => {
        owner.destroy();
        const before = value.publications;
        for (const controls of [initial, active, paused, delayed]) {
          controls.play(); controls.pause(); controls.seek(32); controls.cancel(); controls.stop();
        }
        assert.equal(value.publications, before, name + ': terminal control воскресил writer');
      };
      if (terminal) {
        terminalCheck = { name, kind, host, owner,
          pending: Promise.all([initial.finished, active.finished, paused.finished, delayed.finished]),
          ref: new WeakRef(value) };
        componentPromises.push(terminalCheck);
      }
      // Scope destroy терминализирует принадлежащие ему runs. Сохранённые
      // public controls/finished не дают motion право удерживать component.
      owners = [owner, initial, active, paused, delayed];
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
    if (terminalCheck) terminalCheck.publications = publications;
    host.terminalDrain();
    assert.equal(value.publications, publications, name + ': terminal listener был вызван');
  }
  // У живого контроля host остаётся вместе с owner: очередь сама является
  // допустимой сильной ссылкой. У terminal host физически пуст.
  return [host, ...owners];
}

async function flushTerminalPromises() {
  await Promise.resolve(); await Promise.resolve();
  for (const check of componentPromises.splice(0)) {
    const result = await check.pending;
    if (check.kind === 'presence-transition') {
      assert.deepEqual(result, { status: 'destroyed', present: true }, check.name + ': terminal result');
      for (const promise of check.earlier) assert.equal((await promise).status, 'superseded');
    }
    check.host.terminalDrain();
    const value = check.ref.deref();
    if (value) assert.equal(value.publications, check.publications, check.name + ': deferred cleanup вызвал writer');
  }
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

// Узкие witnesses прежнего follow proof: scheduler/listeners уже входят в
// общий корпус, а spring-only и отменённый native donor требуют отдельных roots.
function springRoot(mod, kind, terminal, metadata) {
  const value = component(7), ref = new WeakRef(value);
  const spring = metadata ? { ...SPRING, owner: value } : SPRING;
  const options = { spring, property: 'opacity', from: 0, to: 1 };
  const owner = kind === 'motion-value'
    ? new mod.root.MotionValue({ initial: 0, spring, requestFrame: () => 1 })
    : kind === 'follow' ? mod.follow.createCompositorFollow(options)
      : new mod.compositor.CompositorSpring(options);
  if (terminal) owner.destroy();
  return { ref, owners: [owner] };
}

function lateCallbackRoot(mod) {
  const value = component(8), ref = new WeakRef(value);
  const owner = new mod.root.MotionValue({ initial: 0, spring: SPRING, requestFrame: () => 1 });
  owner.destroy();
  return { ref, owners: [owner, owner.onChange(listener(value))] };
}

function followEffectRoot(mod, pickup, terminal) {
  const value = component(9), ref = new WeakRef(value), host = makeHost();
  let effectRef;
  const target = { marker: value, animate() {
    const effect = host.animate(); effect.target = this; effectRef = new WeakRef(effect); return effect;
  } };
  const owner = mod.follow.createCompositorFollow({
    spring: SPRING, property: 'opacity', from: 0, to: 1, target,
    apply: listener(value), format: formatter(value), now: () => host.now, requestFrame: host.requestFrame,
  });
  owner.beginFollow(0); owner.follow(0.2, 0.02); owner.settle(1, 0.02);
  assert.equal(host.createdEffects, 1, 'follow settle должен создать ровно один native effect');
  assert.equal(host.activeEffects, 1, 'follow reference control не создал native effect');
  assert.equal(host.cancelledEffects, 0, 'follow settle преждевременно отменил native effect');
  if (pickup) owner.beginFollow(0.03);
  assert.equal(host.cancelledEffects, pickup ? 1 : 0, 'follow pickup должен отменить donor ровно один раз');
  if (terminal) owner.destroy();
  assert.equal(host.activeEffects, pickup || terminal ? 0 : 1);
  assert.equal(host.cancelledEffects, pickup || terminal ? 1 : 0, 'follow native effect отменён больше одного раза');
  return { ref, effectRef, owners: [owner, host] };
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

// Host getter может принять вложенный handoff и вернуть управление после
// частичного отказа sibling. Проверяется реальный packed API, не source alias.
async function packedReentry(animate, scenario) {
  const rejectedWrite = new Error('reentry witness: rejected host write');
  const makeTarget = () => {
    const values = new Map();
    const state = { writes: 0, cancels: 0, rejectNextWrite: false, calls: [] };
    state.target = { style: {
      getPropertyValue: name => values.get(name) ?? '',
      setProperty(name, value) {
        if (state.rejectNextWrite) { state.rejectNextWrite = false; throw rejectedWrite; }
        state.writes++; values.set(name, value);
      },
    }, animate(keyframes, timing) {
      state.calls.push({ keyframes, timing });
      return { cancel() { state.cancels++; } };
    } };
    return state;
  };
  const targets = [makeTarget(), makeTarget(), makeTarget()];
  let queue = [], requests = 0, armed = false, caught = 0, completions = 0, crossing;
  let controls;
  const requestFrame = callback => { queue.push(callback); return ++requests; };
  controls = animate(targets.map(item => item.target), { opacity: [0, 1] }, {
    spring: { mass: 1, stiffness: 100, damping: 10 },
    now: () => 0, setTimer: () => () => {}, onComplete: () => { completions++; },
    get requestFrame() {
      if (armed) {
        armed = false;
        if (scenario === 'nested-failure') {
          targets[1].rejectNextWrite = true;
          try { controls.seek(crossing); }
          catch (error) { assert.equal(error, rejectedWrite); caught++; }
        } else if (scenario === 'cancel') controls.cancel();
        else if (scenario === 'pause') controls.pause();
      }
      return requestFrame;
    },
  });
  assert.ok(targets.every(item => item.calls.length === 1), 'healthy native start must be reached');
  const timing = targets[0].calls[0].timing;
  // Время crossing выводится из фактически отданной host кривой, а не из
  // независимого solver с иной сериализацией/допуском.
  assert.ok(timing.easing.startsWith('linear('));
  const stops = timing.easing.slice(7, -1).split(',').map(stop =>
    stop.trim().split(/\s+/).map(parseFloat));
  for (let i = 0; i + 1 < stops.length; i++) {
    const [p0, t0] = stops[i], [p1, t1] = stops[i + 1];
    if (p0 < 1 && p1 >= 1) {
      crossing = (t0 + (1 - p0) / (p1 - p0) * (t1 - t0)) / 100 * timing.duration;
      break;
    }
  }
  assert.ok(Number.isFinite(crossing), 'positive target crossing is required');
  armed = scenario !== 'control';
  controls.seek(crossing);
  const initialRequests = requests;
  if (scenario === 'cancel' || scenario === 'pause') assert.equal(requests, 0);
  else assert.equal(requests, 1, 'one aggregate created multiple frame clocks after getter reentry');
  assert.equal(caught, scenario === 'nested-failure' ? 1 : 0);
  if (scenario === 'pause') {
    controls.play(); assert.equal(requests, 1, 'accepted pause must remain resumable');
  }
  controls.cancel(); await controls.finished;
  assert.ok(targets.every(item => item.cancels === 1), 'every original native effect must be released once');
  const writes = targets.map(item => item.writes), requested = requests;
  controls.play(); controls.pause(); controls.seek(32); controls.stop();
  const pending = queue; queue = [];
  for (const callback of pending) callback(16);
  assert.deepEqual(targets.map(item => item.writes), writes, 'terminal controls published stale writes');
  assert.equal(requests, requested, 'terminal aggregate rearmed a frame');
  assert.equal(queue.length, 0);
  assert.equal(completions, 0);
  return { scenario, caught, initialRequests, requests, nativeCancels: targets.map(item => item.cancels) };
}

if (mode === 'reentry') {
  const checks = [];
  for (const mod of modules) {
    for (const scenario of ['control', 'nested-failure', 'cancel', 'pause']) {
      checks.push({ format: mod.format, ...await packedReentry(mod.animate.animate, scenario) });
    }
  }
  console.log(JSON.stringify({ status: 'pass', mode, corpus, checks }));
} else if (mode === 'lifecycle') {
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
  console.log(JSON.stringify({ status: 'pass', mode, corpus, cyclesPerOwner: CYCLES,
    executions: executions(), terminal: { effects: 0, jobs: 0, publications: 0 }, caches }));
} else if (mode === 'retention' || mode === 'witness') {
  const count = mode === 'witness' ? 1 : CYCLES;
  const terminalOwners = [], terminalRefs = CASES.map(() => []), droppedRefs = [], liveOwners = [], liveRefs = [];
  const unsubscribedOwners = [], unsubscribedRefs = [];
  const promiseOwners = [], promiseRefs = { live: [], terminal: [], 'promise-only': [], 'user-owned': [] };
  const inheritedOwners = [], inheritedChecks = [];
  for (const mod of modules) {
    for (const kind of ['motion-value', 'compositor', 'follow']) {
      for (const [terminal, metadata] of [[true, true], [true, false], [false, true]]) {
        const result = springRoot(mod, kind, terminal, metadata);
        inheritedOwners.push(result.owners);
        inheritedChecks.push({ ref: result.ref, alive: !terminal, label: `${mod.format}/${kind}/spring/${terminal}/${metadata}` });
      }
    }
    const late = lateCallbackRoot(mod);
    inheritedOwners.push(late.owners);
    inheritedChecks.push({ ref: late.ref, alive: false, label: `${mod.format}/late-subscription` });
    for (const pickup of [false, true]) for (const terminal of [false, true]) {
      const result = followEffectRoot(mod, pickup, terminal);
      inheritedOwners.push(result.owners);
      inheritedChecks.push({ ref: result.ref, alive: !terminal, label: `${mod.format}/follow/target/${pickup}/${terminal}` });
      inheritedChecks.push({ ref: result.effectRef, alive: !pickup && !terminal, label: `${mod.format}/follow/effect/${pickup}/${terminal}` });
    }
  }
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
  globalThis.__resourceControls = { terminalOwners, liveOwners, deliberateOwners, unsubscribedOwners, promiseOwners, inheritedOwners };
  await flushTerminalPromises();
  await collect(16);
  const owners = CASES.map((testCase, index) => ({ name: testCase.name, retained: countAlive(terminalRefs[index]) }));
  const retainedComponentReferences = owners.reduce((total, owner) => total + owner.retained, 0);
  const inheritedFailures = inheritedChecks.filter(({ ref, alive }) => (ref.deref() !== undefined) !== alive)
    .map(({ label }) => label);
  const controls = { inheritedChecks: inheritedChecks.length, inheritedFailures,
    live: countAlive(liveRefs), expectedLive: CASES.length,
    dropped: countAlive(droppedRefs), deliberate: countAlive(deliberateRefs),
    unsubscribedActive: countAlive(unsubscribedRefs), activeOwnersWithHealthySibling: unsubscribedOwners.length,
    promiseRoots: Object.fromEntries(Object.entries(promiseRefs).map(([name, refs]) => [name, countAlive(refs)])),
    healthyPromiseCompletions: modules.length, healthyDismissCompletions: modules.length };
  // Тот же live scope/presence controller остаётся сильным root после destroy;
  // прежние 38 controls не меняют свой текущий lifetime premise.
  const addedLiveRefs = [];
  for (let index = 0; index < CASES.length; index++) if (ADDED_KINDS.includes(CASES[index].kind)) {
    const [host, owner] = liveOwners[index];
    owner.destroy(); host.terminalDrain();
    addedLiveRefs.push(liveRefs[index]);
  }
  await flushTerminalPromises(); await collect(16);
  controls.addedLiveReleased = countAlive(addedLiveRefs);
  controls.addedLiveReleaseControls = addedLiveRefs.length;
  const passed = inheritedFailures.length === 0 && retainedComponentReferences === 0 && controls.live === CASES.length
    && controls.dropped === 0 && controls.deliberate === 1 && controls.unsubscribedActive === 0
    && controls.promiseRoots.live === 2 && controls.promiseRoots.terminal === 0
    && controls.promiseRoots['promise-only'] === 0 && controls.promiseRoots['user-owned'] === 2
    && controls.addedLiveReleased === 0;
  const report = { status: passed ? 'pass' : 'fail', mode, corpus, cyclesPerOwner: count, executions: executions(),
    retainedComponentReferences, retainedComponentPayloadBytes: retainedComponentReferences === 0 ? 0 : null, owners, controls };
  console.log(JSON.stringify(report));
  assert.deepEqual(inheritedFailures, [], 'spring/callback/follow reference contract нарушен');
  assert.equal(controls.live, CASES.length, 'live-owner control собран преждевременно');
  assert.equal(controls.dropped, 0, 'dropped-owner control остался достижим');
  assert.equal(controls.deliberate, 1, 'deliberate-retention control не обнаружен');
  assert.equal(controls.unsubscribedActive, 0, 'retained off удерживает компонент при живом owner');
  assert.equal(controls.promiseRoots.live, 2, 'live Promise control потерял компонент');
  assert.equal(controls.promiseRoots.terminal, 0, 'terminal controller удерживает onRefresh при нейтральном внешнем Promise');
  assert.equal(controls.promiseRoots['promise-only'], 0, 'motion continuation удерживает компонент через нейтральный внешний Promise');
  assert.equal(controls.promiseRoots['user-owned'], 2, 'внешний пользовательский Promise callback не различается');
  assert.equal(retainedComponentReferences, 0, 'terminal controls удерживают уничтоженные компоненты');
  assert.equal(controls.addedLiveReleased, 0, 'тот же уничтоженный live scope/presence удерживает компонент');
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
  console.log(JSON.stringify({ phase: 'baseline', mode, corpus, baseline }));
  assert.ok(band <= MAX_RESOLVABLE_BAND, 'named gap: A/A heap baseline не разрешает 256 KiB; candidate admission не запущен');

  let deliberate = [component(1, CONTROL_WORDS)];
  globalThis.__resourceBytesControls = deliberate;
  const deliberateHeap = await heap();
  const deliberateSignal = deliberateHeap - high;
  assert.ok(deliberateSignal >= 4 * band, 'named gap: deliberate-retention bytes не различаются от A/A baseline');
  deliberate = undefined; globalThis.__resourceBytesControls = undefined;
  const releasedControl = await heap();
  assert.ok(releasedControl <= high + band, 'deliberate control не вернулся в baseline после release');

  const liveCase = CASES.find(testCase => testCase.name ===
    (corpus === 'presence-scope' ? 'esm/presence-transition' : 'esm/compositor-native'));
  let live = [setup(liveCase, 2, false, false, CONTROL_WORDS).owners];
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
  const report = { status: excess.every(bytes => bytes === 0) ? 'pass' : 'fail', mode, corpus, cyclesPerOwner: CYCLES,
    executions: executions(), baseline,
    controls: { deliberateHeap, deliberateSignal, releasedControl, liveHeap, liveSignal, droppedControl }, samples, excess,
    accounting: { componentPayload: 'JS Array', boundedCaches: 'warmed before A/A',
      terminalShells: 'отдельный retention proof; в bytes owners dropped',
      process: 'heapUsed, heapTotal, external, arrayBuffers и rss показаны отдельно',
      nativeGpuBytes: 'не измерены этим Node host' } };
  console.log(JSON.stringify(report));
  assert.ok(excess.every(bytes => bytes === 0), 'retained heap вышел из заранее разрешённой baseline-полосы');
}
