import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function ownerViolations(source) {
  const body = source.slice(source.indexOf('    public void Dispose()'), source.indexOf('    private void CheckAccess()'));
  return [
    ['admission before disposal', !/if \(disposed\) return;\s+CheckAccess\(\);\s+disposed = true;/.test(body)],
    ['every binding attempted', !body.includes('foreach (var binding in bindings.ToArray()) Attempt(binding.Dispose);')],
    ...['tracker', 'modifier', 'condition', 'force', 'settings'].map(name =>
      [name + ' attempted', !body.includes(`Attempt(${name}.Dispose);`)]),
    ['terminal result attempted', !body.includes('Attempt(() => Finish(MotionEnd.Stopped, "disposed"));')],
    ['observer always cleared', !/finally\s*\{\s*Observed = null;\s*\}/.test(body)],
    ['first error and stack retained', !body.includes('failure ??= ExceptionDispatchInfo.Capture(error);') || !body.includes('failure?.Throw();')],
  ].filter(([, invalid]) => invalid).map(([name]) => name);
}

test('Dispose владельца пытается закрыть все ресурсы и сохраняет первую ошибку', () => {
  const source = read('../../native/windows/ScalarMotion.cs');
  assert.deepEqual(ownerViolations(source), []);
  for (const [before, after, name] of [
    ['CheckAccess();\n        disposed = true;', 'disposed = true;\n        CheckAccess();', 'admission before disposal'],
    ['Attempt(binding.Dispose);', 'binding.Dispose();', 'every binding attempted'],
    ['Attempt(tracker.Dispose);', 'tracker.Dispose();', 'tracker attempted'],
    ['finally { Observed = null; }', 'Observed = null;', 'observer always cleared'],
    ['failure ??= ExceptionDispatchInfo.Capture(error);', 'failure = ExceptionDispatchInfo.Capture(error);', 'first error and stack retained'],
  ]) assert(ownerViolations(source.replaceAll(before, after)).includes(name), name);
});

test('binding сохраняет Stop/выражение primary и обязательно вызывает released', () => {
  const source = read('../../native/windows/ScalarBinding.cs');
  const dispose = source.slice(source.indexOf('    public void Dispose()'), source.indexOf('    private void CheckAccess()'));
  const release = source.slice(source.indexOf('    private void Release()'));
  assert(dispose.includes('finally'));
  assert(dispose.includes('try { Release(); }'));
  assert(dispose.includes('failure ??= ExceptionDispatchInfo.Capture(error);'));
  assert(dispose.includes('failure?.Throw();'));
  assert(release.includes('disposed = true;'));
  assert(release.includes('if (disposed) return;'));
  assert(release.includes('finally'));
  assert(release.includes('try { released(this); }'));
  assert(release.includes('failure ??= ExceptionDispatchInfo.Capture(error);'));
  assert(release.includes('failure?.Throw();'));
});

test('существующий C# consumer включает faults, healthy, reentrance и wrong-thread controls', () => {
  const runner = read('./runner.cs');
  assert(runner.includes('var disposals = DisposeTests.Run();'));
  assert(runner.includes('disposals.Count == 11 && disposals.All(result => result.Passed)'));
  const controls = read('./dispose-tests.cs');
  for (const name of ['healthy', 'stop', 'tracker', 'modifier', 'condition', 'force', 'settings', 'all',
    'dispose-reentrant-callback', 'dispose-wrong-thread-preserves-owner', 'binding-compound-failure-primary']) assert(controls.includes('"' + name + '"'), name);
  assert(controls.includes('ReferenceEquals(error, primary)'));
  assert(controls.includes('ReferenceEquals(error, stopFailure)'));
  assert(controls.includes('DisposeCount == 1'));
  assert(controls.includes('GetInvocationList()'));
  assert(controls.includes('pending.Result == new MotionResult(1, MotionEnd.Stopped, "disposed")'));
});
