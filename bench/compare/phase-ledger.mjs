import { readFileSync } from 'node:fs';

// Только source-only bundle: исходный product не переписывается на диске.
export function sourceLedgerPlugin() {
  return { name: 'phase-ledger', setup(build) {
    build.onLoad({ filter: /[/\\]motion[/\\]runtime\.ts$/ }, args => {
      let contents = readFileSync(args.path, 'utf8');
      const replace = (from, to) => {
        if (contents.split(from).length !== 2) throw new Error('Неоднозначный source hook: ' + from);
        contents = contents.replace(from, to);
      };
      replace('const input = properties(props);', "const input = globalThis.__phase.scope('properties', () => properties(props));");
      replace('const clock = timing(options);', "const clock = globalThis.__phase.scope('timing', () => timing(options));");
      replace('return this._execute(this._draft(target, input, clock));', "const drafts = globalThis.__phase.scope('draft', () => this._draft(target, input, clock));\n    return globalThis.__phase.scope('execute', () => this._execute(drafts));");
      replace('const spec = program(property._key, current, values, property._authored, property._authored ? author : clock, current._velocity, offset + i * clock._stagger);', "const spec = globalThis.__phase.scope('program', () => program(property._key, current, values, property._authored, property._authored ? author : clock, current._velocity, offset + i * clock._stagger));");
      return { contents, loader: 'ts' };
    });
  } };
}

// Выполняется в fresh realm до trigger. Никаких дополнительных style/currentTime reads.
export function installPhaseLedger() {
  const rows = [], stack = [], computed = new WeakMap(), effects = new WeakMap(), targets = new WeakMap();
  let serial = 0, effectId = 0, phase = 'setup', enabled = true;
  const mark = (edge, label, id) => {
    const token = `phase-ledger:${edge}:${id}:${label}`;
    console.timeStamp(token);
    rows.push({ edge, label, id, phase, wallMs: performance.now() });
  };
  const scope = (label, action) => {
    if (!enabled) return action();
    const id = ++serial; mark('begin', label, id); stack.push(label);
    try { return action(); } finally { stack.pop(); mark('end', label, id); }
  };
  const ledger = window.__phase = { rows, native: [], reads: [], cancels: [], scope,
    checkpoint(name) { phase = name; mark('checkpoint', name, ++serial); },
    disable() { enabled = false; },
    enable() { enabled = true; },
    targetList(list) { list.forEach((el, i) => targets.set(el, i)); },
  };
  const originalAnimate = Element.prototype.animate;
  Element.prototype.animate = function(...args) {
    if (!enabled) return Reflect.apply(originalAnimate, this, args);
    const result = scope('native', () => Reflect.apply(originalAnimate, this, args));
    const id = ++effectId; effects.set(result, id);
    // Структура аргументов читается после original вызова, только authored plain inputs.
    const option = name => args[1] && typeof args[1] === 'object'
      ? Object.getOwnPropertyDescriptor(args[1], name)?.value ?? null : null;
    ledger.native.push({ id, target: targets.get(this) ?? null, phase, stage: stack.at(-1) ?? null,
      keyframeCount: Array.isArray(args[0]) ? args[0].length : null,
      duration: typeof args[1] === 'number' ? args[1] : option('duration'), easing: option('easing'),
      delay: option('delay'), fill: option('fill') });
    return result;
  };
  const originalCancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function(...args) {
    if (enabled) ledger.cancels.push({ id: effects.get(this) ?? null, phase });
    return Reflect.apply(originalCancel, this, args);
  };
  const originalComputed = window.getComputedStyle;
  window.getComputedStyle = function(...args) {
    const result = Reflect.apply(originalComputed, this, args);
    computed.set(result, targets.get(args[0]) ?? null); return result;
  };
  const originalProperty = CSSStyleDeclaration.prototype.getPropertyValue;
  CSSStyleDeclaration.prototype.getPropertyValue = function(...args) {
    if (!enabled || args[0] !== 'transform' || !computed.has(this)) return Reflect.apply(originalProperty, this, args);
    const result = scope('computed-transform', () => Reflect.apply(originalProperty, this, args));
    ledger.reads.push({ target: computed.get(this), phase, stage: stack.at(-1) ?? null });
    return result;
  };
  // Motion может использовать css.transform вместо getPropertyValue.
  let owner = CSSStyleDeclaration.prototype;
  while (owner && !Object.getOwnPropertyDescriptor(owner, 'transform')) owner = Object.getPrototypeOf(owner);
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'transform');
  ledger.transformGetter = descriptor?.get && descriptor.configurable ? 'instrumented' : 'UNAVAILABLE';
  if (ledger.transformGetter === 'instrumented') Object.defineProperty(owner, 'transform', { ...descriptor,
    get() {
      if (!enabled || !computed.has(this)) return Reflect.apply(descriptor.get, this, []);
      const result = scope('computed-transform', () => Reflect.apply(descriptor.get, this, []));
      ledger.reads.push({ target: computed.get(this), phase, stage: stack.at(-1) ?? null }); return result;
    },
  });
}

// CPU берётся только из actual thread timestamps. Wall ts не заменяет отсутствующий tts.
export function exclusiveMarkerCpu(events, expectedRows, traceCompletion = {}) {
  const unavailable = reason => ({ status: 'UNAVAILABLE', reason });
  if (traceCompletion.dataLossOccurred === true) return unavailable('TRACE_DATA_LOSS');
  const markers = events.filter(e => e.name === 'TimeStamp' && String(e.args?.data?.message ?? '').startsWith('phase-ledger:'));
  if (!Array.isArray(expectedRows) || !expectedRows.length || markers.length !== expectedRows.length)
    return unavailable('LEDGER_MARKER_COUNT');
  if (markers.some(e => !Number.isFinite(e.ts) || e.ts < 0 || !Number.isSafeInteger(e.pid) || e.pid < 0 ||
    !Number.isSafeInteger(e.tid) || e.tid < 0)) return unavailable('INVALID_TRACE_FIELDS');
  markers.sort((a, b) => a.ts - b.ts);
  const thread = `${markers[0].pid}/${markers[0].tid}`;
  const identities = new Set();
  for (let i = 0; i < markers.length; i++) {
    const row = expectedRows[i], token = `phase-ledger:${row.edge}:${row.id}:${row.label}`;
    if (!['begin', 'end', 'checkpoint'].includes(row.edge) || !Number.isSafeInteger(row.id) || row.id < 1 ||
      typeof row.label !== 'string' || !row.label || identities.has(token)) return unavailable('INVALID_LEDGER_MARKER');
    identities.add(token);
    if (markers[i].args.data.message !== token) return unavailable('LEDGER_MARKER_MISMATCH');
    if (`${markers[i].pid}/${markers[i].tid}` !== thread) return unavailable('MARKER_THREAD_MISMATCH');
    if (!Number.isFinite(markers[i].tts) || markers[i].tts < 0) return unavailable('INVALID_THREAD_CLOCK');
    if (i && markers[i].tts < markers[i - 1].tts) return unavailable('THREAD_CLOCK_REGRESSION');
  }
  const required = ['root-start', 'return', 'post-frame-commit', 'finished', 'cleanup-start', 'cleanup'];
  const lifecycle = expectedRows.filter(row => row.edge === 'checkpoint').map(row => row.label);
  if (required.some(name => lifecycle.filter(label => label === name).length !== 1) || lifecycle.length !== required.length ||
    lifecycle[0] !== 'root-start' || lifecycle[1] !== 'return' || lifecycle.at(-2) !== 'cleanup-start' || lifecycle.at(-1) !== 'cleanup')
    return unavailable('LIFECYCLE_CHECKPOINTS');
  const pending = new Map(), intervals = [], threadStacks = new Map(), checkpoints = [], usedIds = new Set();
  for (const event of markers) {
    const [, edge, id, ...parts] = event.args.data.message.split(':');
    const key = `${event.pid}/${event.tid}/${id}`, label = parts.join(':');
    const thread = `${event.pid}/${event.tid}`;
    const stack = threadStacks.get(thread) ?? []; threadStacks.set(thread, stack);
    if (edge === 'checkpoint' || edge === 'begin') {
      if (usedIds.has(id)) return unavailable('DUPLICATE_MARKER_ID');
      usedIds.add(id);
    }
    if (edge === 'checkpoint') {
      if (stack.length) return unavailable('CHECKPOINT_INSIDE_SPAN');
      checkpoints.push({ label, pid: event.pid, tid: event.tid, tts: event.tts });
    }
    if (edge === 'begin') { pending.set(key, { event, label, children: 0 }); stack.push(key); }
    if (edge === 'end') {
      const entry = pending.get(key), begin = entry?.event;
      if (stack.pop() !== key || !begin || entry.label !== label) return unavailable('UNMATCHED_MARKER_PAIR');
      const cpu = event.tts - begin.tts;
      if (entry.children > cpu) return unavailable('INVALID_CHILD_CPU');
      pending.delete(key);
      const parent = pending.get(stack.at(-1)); if (parent) parent.children += cpu;
      intervals.push({ label, exclusive: cpu - entry.children });
    }
  }
  if (pending.size) return unavailable('TRUNCATED_MARKER_PAIR');
  const totals = {};
  for (const interval of intervals) {
    // Только direct-child inclusive CPU вычитается один раз; равные tts сохраняют nesting.
    totals[interval.label] = (totals[interval.label] ?? 0) + interval.exclusive / 1000;
  }
  const phases = checkpoints.slice(1).map((end, i) => {
    const begin = checkpoints[i];
    const valid = begin.pid === end.pid && begin.tid === end.tid && Number.isFinite(begin.tts) &&
      Number.isFinite(end.tts) && end.tts >= begin.tts;
    return { from: begin.label, to: end.label, threadCpuMs: valid ? (end.tts - begin.tts) / 1000 : null,
      status: valid ? 'AVAILABLE_ACTUAL_THREAD_CLOCK' : 'UNAVAILABLE' };
  });
  return { status: 'AVAILABLE_MARKED_SPANS_ONLY', exclusiveCpuMs: totals, phases,
    residual: 'UNAVAILABLE: unmarked renderer work and competitor resolver/program/setup are not attributed; finished-to-cleanup-start includes excluded geometry and is not useful-work CPU' };
}

export async function phaseLifecycle(page, duration, watchdogMs, diagnostic) {
  return page.evaluate(async ({ duration, watchdogMs, diagnostic }) => {
    const ledger = diagnostic ? window.__phase : null, snapshots = [];
    const snapshot = name => { ledger?.checkpoint(name); snapshots.push({ name, wallMs: performance.now(),
      outstandingEffects: document.getAnimations().length, nativeCreated: ledger ? ledger.native.length : null,
      computedTransformReads: ledger ? ledger.reads.length : null }); };
    let watchdog;
    // Подписка на frame до trigger; MessageChannel после rAF task+microtasks, не sleep.
    let frameResolve;
    const postFrame = new Promise(resolve => { frameResolve = resolve; });
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); frameResolve(); };
      channel.port2.postMessage(null);
    });
    ledger?.checkpoint('root-start');
    const start = performance.now();
    window.__control = window.__adapterModule.start(window.__targets, 300, duration);
    const apiMs = performance.now() - start;
    snapshot('return');
    const finished = window.__control.finished();
    if (typeof finished?.then !== 'function') throw new Error('Completion not awaitable');
    const finishedSignal = Promise.resolve(finished).then(() => snapshot('finished'));
    try {
      await Promise.race([Promise.all([finishedSignal, postFrame.then(() => snapshot('post-frame-commit'))]),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Lifecycle watchdog')), watchdogMs); })]);
    } finally { clearTimeout(watchdog); }
    return { apiMs, completionMs: performance.now() - start, snapshots };
  }, { duration, watchdogMs, diagnostic });
}
