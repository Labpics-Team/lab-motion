// Temporary diagnostic H1 arm. Not selected by qualification measurements.
// Three passes preserve the existing observer's DOM read and exception order.
const seed = 0x4f425331;
let state = seed;
const first = ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right'];
for (let index = first.length - 1; index > 0; index--) {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  const other = (state >>> 0) % (index + 1);
  [first[index], first[other]] = [first[other], first[index]];
}
export const OBSERVER_ABLATION = Object.freeze({
  id: 'observer-allocation-ablation-1', qualification: false, seed,
  pairs: 8, scenes: ['s2', 's3'], orders: first.map(arm => [arm, arm === 'left' ? 'right' : 'left']),
  arms: { left: 'H0', right: 'H1' },
  estimand: 'paired fresh-realm cancelMs mean of all8 repetitions after1warmup; observer after cancel may affect later heap/state only',
  retry: false, tracing: false,
});
export function observerSnapshotH1(els) {
  let connectedTargets = 0;
  els.forEach(element => { if (element.isConnected) connectedTargets++; });
  const activeWaapi = els.reduce((sum, element) => sum + element.getAnimations().length, 0);
  let count = 0, first, previous, runs;
  els.forEach(element => {
    const value = new DOMMatrixReadOnly(getComputedStyle(element).transform).e;
    if (count === 0) first = value;
    else if (!runs && !Object.is(value, first)) runs = [[count, first]];
    if (runs) {
      if (Object.is(value, previous)) runs.at(-1)[0]++;
      else runs.push([1, value]);
    }
    previous = value;
    count++;
  });
  return { connectedTargets, activeWaapi,
    transforms: runs ? { encoding: 'rle', count, runs } : { encoding: 'repeat', count, value: first } };
}
