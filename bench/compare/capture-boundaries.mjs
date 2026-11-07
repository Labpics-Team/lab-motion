// Disposable build-local observer; never imported by the production entry.
const clock = performance.now.bind(performance);
const names = ['styles', 'transformProperty', 'matrixDecode'];
const stride = 64, spanCapacity = 128, timerPairs = 16, fields = 5;
let timed = false, boundaries = {}, timers, clockErrors = 0, overflow = 0;
const fresh = () => Object.fromEntries(names.map(name => [name, {
  calls: 0, returned: 0, threw: 0, records: 0,
  storage: new Float64Array(spanCapacity * fields).fill(NaN),
  inputs: { empty: 0, none: 0, nonidentity: 0, unknown: 0 },
}]));
function readClock() {
  try { return clock(); }
  catch { clockErrors++; return null; }
}
export function captureBoundary(name, original) {
  const bucket = boundaries[name];
  // The original semantic probes do not initialize this observer.
  if (!bucket) return original();
  const call = ++bucket.calls;
  const sampled = (call - 1) % stride === 0;
  const slot = sampled ? bucket.records++ : -1;
  if (slot >= spanCapacity) overflow++;
  const before = sampled && timed ? readClock() : null;
  let returned = false;
  try {
    const value = original();
    returned = true;
    bucket.returned++;
    if (name === 'transformProperty') {
      if (value === '') bucket.inputs.empty++;
      else if (value === 'none') bucket.inputs.none++;
      else if (typeof value === 'string') bucket.inputs.nonidentity++;
      else bucket.inputs.unknown++;
    }
    return value;
  } finally {
    if (!returned) bucket.threw++;
    if (sampled) {
      const after = timed ? readClock() : null;
      if (slot < spanCapacity) {
        const at = slot * fields, data = bucket.storage;
        data[at] = call;
        data[at + 1] = before === null ? NaN : before;
        data[at + 2] = after === null ? NaN : after;
        data[at + 3] = before === null || after === null ? NaN : after - before;
        data[at + 4] = returned ? 1 : 0;
      }
    }
  }
}
const nullable = value => Number.isNaN(value) ? null : value;
const materialize = (data, offset) => ({ beforeMs: nullable(data[offset]),
  afterMs: nullable(data[offset + 1]), elapsedMs: nullable(data[offset + 2]) });
export const captureObserver = {
  begin(timing) {
    timed = timing; boundaries = fresh();
    timers = new Float64Array(timerPairs * 3).fill(NaN); clockErrors = 0; overflow = 0;
  },
  snapshot() {
    // Both modes materialize identical record counts only after original lifecycle/drain.
    return { mode: timed ? 'sparse' : 'counter', stride, spanCapacity, overflow, clockErrors,
      boundaries: Object.fromEntries(names.map(name => {
        const bucket = boundaries[name];
        return [name, { calls: bucket.calls, returned: bucket.returned, threw: bucket.threw,
          inputs: { ...bucket.inputs }, spans: Array.from({ length: Math.min(bucket.records, spanCapacity) }, (_, i) => ({
            call: bucket.storage[i * fields], ...materialize(bucket.storage, i * fields + 1),
            returned: bucket.storage[i * fields + 4] === 1, timed,
          })) }];
      })),
      timerControl: Array.from({ length: timerPairs }, (_, i) => ({ ...materialize(timers, i * 3), timed })),
    };
  },
  timerControl() {
    // Same record writes in both modes; clocks only in sparse, after lifecycle/drain.
    for (let sample = 0; sample < timerPairs; sample++) {
      const before = timed ? readClock() : null, after = timed ? readClock() : null;
      timers[sample * 3] = before === null ? NaN : before;
      timers[sample * 3 + 1] = after === null ? NaN : after;
      timers[sample * 3 + 2] = before === null || after === null ? NaN : after - before;
    }
  },
};
export function qualifyCapture(snapshot, mode, positiveMatrix = false) {
  if (!snapshot || snapshot.mode !== mode || snapshot.stride !== stride || snapshot.overflow !== 0 ||
      snapshot.clockErrors !== 0 || snapshot.timerControl?.length !== timerPairs) return false;
  const buckets = names.map(name => snapshot.boundaries?.[name]);
  if (buckets.some(bucket => !bucket || !Number.isInteger(bucket.calls) || bucket.calls < 0 ||
      bucket.returned + bucket.threw !== bucket.calls || bucket.threw !== 0 ||
      bucket.spans.length !== Math.ceil(bucket.calls / stride))) return false;
  const [styles, property, matrix] = buckets;
  if (!styles.calls || !property.calls || styles.returned !== property.calls) return false;
  const inputs = property.inputs;
  // nonidentity denotes a nonempty/non-'none' string, not a numeric matrix-identity claim.
  if (!inputs || inputs.unknown !== 0 || inputs.empty + inputs.none + inputs.nonidentity !== property.returned ||
      matrix.calls !== inputs.nonidentity || (positiveMatrix && matrix.calls === 0)) return false;
  const spans = buckets.flatMap(bucket => bucket.spans);
  return spans.every(span => span.timed === (mode === 'sparse') && span.returned &&
      (mode === 'sparse' ? Number.isFinite(span.elapsedMs) && span.elapsedMs >= 0 :
        span.beforeMs === null && span.afterMs === null && span.elapsedMs === null)) &&
    snapshot.timerControl.every(pair => pair.timed === (mode === 'sparse') &&
      (mode === 'sparse' ? Number.isFinite(pair.elapsedMs) && pair.elapsedMs >= 0 :
        pair.beforeMs === null && pair.afterMs === null && pair.elapsedMs === null));
}
