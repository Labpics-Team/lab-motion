import { pairedClusterBootstrap, applyHolmCorrection } from './methodology.mjs';

export const KEYBOARD_PLAN = Object.freeze({ schema: 1, rounds: 20, vendors: ['lab', 'motion', 'anime'],
  targets: 1000, targetPx: 300, durationMs: 400, easing: 'linear', key: ' ', code: 'Space',
  controls: 3, blockingIterations: 8_000_000, timeoutMs: 10_000, maxLifecycles: 66,
  quantumMs: 8, intervalHalfWidthMs: 4, bootstrapIterations: 10_000, seed: 0x4B4559,
  alpha: 0.05, familySize: 2, practicalMs: 8, practicalFraction: 0.05,
  p95NonInferiorityRatio: 1.05, samplesObservedAtRegistration: false,
  metric: 'first-input duration: trusted event to next rendering update, not photon/INP/S5',
  analysis: 'paired-round bootstrap; worst-case rounding endpoints; Holm two loss comparisons; no p99; missing/control failure/overlap INCONCLUSIVE',
});

// Один serializable owner для настоящего браузера и deterministic fake environment.
export function installKeyboardCollector(config, environment = globalThis) {
  const { performance, PerformanceObserver, document, setTimeout, clearTimeout } = environment;
  const control = document.getElementById('keyboard-action');
  const ack = document.getElementById('keyboard-ack');
  const raw = [], eventEvidence = [], before = { now: performance.now(), timeOrigin: performance.timeOrigin };
  let observer, timer, triggered = false, resolveInput, resolveFinished, inputAfter = null, status = 'WAITING';
  const input = new Promise(resolve => { resolveInput = resolve; });
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const cleanupObserver = () => { observer?.disconnect(); clearTimeout(timer); };
  const complete = reason => {
    if (status !== 'WAITING') return;
    status = reason; inputAfter = { now: performance.now(), timeOrigin: performance.timeOrigin };
    cleanupObserver(); resolveInput(reason);
  };
  const onEntries = list => {
    for (const entry of list.getEntries()) {
      const value = { ...entry.toJSON(), targetId: entry.target?.id ?? null };
      raw.push(value);
      if (value.entryType !== 'first-input' || value.name !== 'keydown') continue;
      const event = eventEvidence.find(e => e.type === 'keydown');
      if (!event || !event.isTrusted || event.key !== config.key || event.code !== config.code || event.repeat ||
        value.targetId !== control.id || !Number.isFinite(value.startTime) || Math.abs(value.startTime - event.timeStamp) > 1) continue;
      complete('ENTRY');
    }
  };
  const handler = event => {
    eventEvidence.push({ type: event.type, key: event.key, code: event.code, isTrusted: event.isTrusted,
      repeat: event.repeat, timeStamp: event.timeStamp, targetId: event.target?.id ?? null });
    if (event.type !== 'keydown' || triggered || event.key !== config.key || event.code !== config.code || event.repeat) return;
    triggered = true; event.preventDefault();
    if (!event.isTrusted) { complete('UNTRUSTED'); resolveFinished({ error: 'untrusted trigger' }); return; }
    const start = performance.now();
    try {
      if (config.kind === 'vendor') {
        environment.__control = environment.__adapterModule.start(environment.__targets, config.targetPx, config.durationMs);
      } else if (config.kind === 'blocking') {
        let checksum = 1;
        for (let i = 0; i < config.blockingIterations; i++) checksum = Math.imul(checksum ^ i, 1664525) + 1013904223 | 0;
        environment.__blockingChecksum = checksum;
      }
      environment.__keyboardApiMs = performance.now() - start;
      ack.textContent = 'done';
      if (config.kind === 'vendor') {
        const signal = environment.__control.finished();
        if (typeof signal?.then !== 'function') throw new Error('non-awaitable public finished');
        Promise.resolve(signal).then(() => resolveFinished({ completed: true }), error => resolveFinished({ error: String(error) }));
      } else resolveFinished({ completed: true });
    } catch (error) { resolveFinished({ error: String(error) }); }
  };
  control.addEventListener('keydown', handler);
  control.addEventListener('keyup', handler);
  // Первый input threshold-exempt; никакого durationThreshold/event fallback.
  if (PerformanceObserver?.supportedEntryTypes?.includes('first-input')) {
    try { observer = new PerformanceObserver(onEntries); observer.observe({ type: 'first-input', buffered: true }); }
    catch { complete('UNAVAILABLE'); }
  } else complete('UNAVAILABLE');
  if (status === 'WAITING') timer = setTimeout(() => complete('MISSING'), config.timeoutMs);
  environment.__keyboardCapture = {
    input, finished, raw, eventEvidence, before,
    receipt() { return { status, raw, eventEvidence, before, inputAfter, after: { now: performance.now(), timeOrigin: performance.timeOrigin },
      apiWallMs: environment.__keyboardApiMs ?? null, blockingChecksum: environment.__blockingChecksum ?? null }; },
    teardown() { cleanupObserver(); control.removeEventListener('keydown', handler); control.removeEventListener('keyup', handler); },
  };
  return { subscribed: !!observer, status, before };
}

export function firstInputInterval(receipt) {
  if (receipt?.status !== 'ENTRY' || !Array.isArray(receipt.raw) || !Array.isArray(receipt.eventEvidence)) return null;
  const probes = [receipt.before, receipt.inputAfter, receipt.after];
  if (probes.some(probe => !probe || ![probe.now, probe.timeOrigin].every(value => Number.isFinite(value) && value >= 0)) ||
    probes.some(probe => probe.timeOrigin !== receipt.before.timeOrigin) ||
    receipt.before.now > receipt.inputAfter.now || receipt.inputAfter.now > receipt.after.now) return null;
  const event = receipt.eventEvidence.find(e => e?.type === 'keydown');
  const entries = receipt.raw.filter(e => e?.entryType === 'first-input' && e.name === 'keydown');
  if (entries.length !== 1 || !event?.isTrusted || event.key !== KEYBOARD_PLAN.key || event.code !== KEYBOARD_PLAN.code ||
    event.repeat || event.targetId !== 'keyboard-action' || !Number.isFinite(event.timeStamp)) return null;
  const entry = entries[0];
  if (entry.targetId !== event.targetId || !Number.isSafeInteger(entry.interactionId) || entry.interactionId <= 0 ||
    Math.abs(entry.startTime - event.timeStamp) > 1 ||
    ![entry.startTime, entry.processingStart, entry.processingEnd, entry.duration].every(Number.isFinite) ||
    entry.startTime < 0 || entry.processingStart < entry.startTime || entry.processingEnd < entry.processingStart ||
    entry.duration < 0 || entry.duration % KEYBOARD_PLAN.quantumMs !== 0 ||
    entry.startTime < receipt.before.now || entry.processingEnd > receipt.inputAfter.now) return null;
  const low = Math.max(0, entry.duration - 4), high = entry.duration + 4;
  // processingEnd не может лежать после даже верхней границы next-render.
  if (entry.processingEnd > entry.startTime + high || entry.startTime + low > receipt.inputAfter.now) return null;
  return { low, high, duration: entry.duration, inputDelayMs: entry.processingStart - entry.startTime,
    processingMs: entry.processingEnd - entry.processingStart,
    renderingDelayMs: { low: Math.max(0, entry.startTime + low - entry.processingEnd),
      high: entry.startTime + high - entry.processingEnd } };
}

export function analyzeKeyboardSamples(samples) {
  const interval = sample => sample.useful === true ? firstInputInterval(sample.receipt) : null;
  const controls = samples.filter(s => s.kind !== 'vendor');
  const empty = controls.filter(s => s.kind === 'empty').map(interval), blocking = controls.filter(s => s.kind === 'blocking').map(interval);
  if (samples.length !== 66 || empty.length !== 3 || blocking.length !== 3 || [...empty, ...blocking].some(x => !x) ||
    Math.min(...blocking.map(x => x.processingMs)) <= Math.max(...empty.map(x => x.processingMs)) + 8)
    return { status: 'INCONCLUSIVE', reason: 'sensor-control missing/invalid/not-distinguishing' };
  const vendors = Object.fromEntries(KEYBOARD_PLAN.vendors.map(id => [id, samples.filter(s => s.kind === 'vendor' && s.id === id).sort((a, b) => a.round - b.round)]));
  if (Object.values(vendors).some(rows => rows.length !== 20 || rows.some((s, i) => s.round !== i || !interval(s))))
    return { status: 'INCONCLUSIVE', reason: 'vendor sample missing/invalid/useful parity failed' };
  if (Object.values(vendors).flat().some(s => interval(s).low <= 0))
    return { status: 'INCONCLUSIVE', reason: 'rounding interval reaches zero; positive-ratio bootstrap not identifiable' };
  const clusters = (id, edge) => vendors[id].map(s => ({ run: s.round, semantic: true, samples: [interval(s)[edge]] }));
  const comparisons = ['motion', 'anime'].map((id, index) => {
    const options = { seed: KEYBOARD_PLAN.seed + index, iterations: KEYBOARD_PLAN.bootstrapIterations };
    // Самая неблагоприятная для утверждения losing-case rounding реализация.
    const competitorFaster = pairedClusterBootstrap(clusters(id, 'high'), clusters('lab', 'low'), options);
    const labWorstCase = pairedClusterBootstrap(clusters('lab', 'high'), clusters(id, 'low'), options);
    const practicalClusters = clusters(id, 'high').map(c => ({ ...c,
      samples: c.samples.map(value => value + Math.max(KEYBOARD_PLAN.practicalMs, KEYBOARD_PLAN.practicalFraction * value)) }));
    const practicalLoss = pairedClusterBootstrap(practicalClusters, clusters('lab', 'low'), options);
    const difference = competitorFaster.p50.competitor - competitorFaster.p50.lab;
    const practical = Math.max(8, 0.05 * competitorFaster.p50.lab);
    return { id, pValue: practicalLoss.pValue, practicalLoss, competitorFaster, labWorstCase, differenceMs: difference, practicalMs: practical };
  });
  const family = applyHolmCorrection(comparisons, KEYBOARD_PLAN.alpha).map(c => ({ ...c,
    losingCase: c.accepted && c.practicalLoss.p50.high < 1,
    nonInferior: c.labWorstCase.p50.high <= 1.05 && c.labWorstCase.p95.high <= KEYBOARD_PLAN.p95NonInferiorityRatio }));
  return { status: family.some(c => c.losingCase) ? 'LOSING_CASE' : family.every(c => c.nonInferior) ? 'NO_ESTABLISHED_LOSS' : 'INCONCLUSIVE',
    comparisons: family, controls: { empty, blocking }, scope: KEYBOARD_PLAN.metric };
}

export async function runKeyboardSample(page, config) {
  await page.evaluate(installKeyboardCollector, config);
  // trusted browser event, не dispatchEvent. Observer уже готов.
  await page.keyboard.press('Space');
  return page.evaluate(async config => {
    const capture = window.__keyboardCapture;
    let timeout;
    const settle = async () => {
      let watchdog;
      try {
        await Promise.race([
          new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('settlement watchdog')), config.timeoutMs); }),
        ]);
      } finally { clearTimeout(watchdog); }
    };
    try {
      await capture.input;
      const finished = await Promise.race([capture.finished,
        new Promise(resolve => { timeout = setTimeout(() => resolve({ error: 'finished watchdog' }), config.timeoutMs); })]);
      clearTimeout(timeout);
      await settle();
      const receipt = capture.receipt();
      const xs = config.kind === 'vendor' ? window.__targets.map(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).e) : [];
      const endpoint = { count: xs.length, finite: xs.every(Number.isFinite), maxError: xs.length ? Math.max(...xs.map(x => Math.abs(x - config.targetPx))) : 0 };
      const acknowledgement = document.getElementById('keyboard-ack').textContent;
      window.__control?.cancel();
      for (const element of window.__targets) element.remove();
      document.getElementById('keyboard-action').remove(); document.getElementById('keyboard-ack').remove();
      await settle();
      const effects = document.getAnimations().length;
      return { receipt, finished, endpoint, acknowledgement, effects,
        useful: finished.completed === true && acknowledgement === 'done' && effects === 0 &&
          (config.kind !== 'vendor' || endpoint.count === config.targets && endpoint.finite && endpoint.maxError <= 0.05) };
    } finally { clearTimeout(timeout); capture.teardown(); }
  }, config);
}
