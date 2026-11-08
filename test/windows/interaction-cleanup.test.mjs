import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = read('../../examples/windows/InteractionProbe.xaml.cs');
const body = value => value.slice(value.indexOf('    private void Detach('), value.indexOf('    // Callback значения'));
function violations(value) {
  const cleanup = body(value);
  return [
    ['retirement', !/if \(detached\) return;\s+detached = true;\s+ready = false;/.test(cleanup)],
    ...['TouchStage.RemoveHandler(routedEvent, handler)', 'ElementCompositionPreview.SetElementChildVisual(TouchStage, null)',
      'motion.Observed -= Observe'].map(operation => [operation, !cleanup.includes(`Attempt(() => ${operation});`)]),
    ...['motion.Dispose', 'resources[i].Dispose', 'trace.Flush', 'trace.Dispose'].map(operation => [operation, !cleanup.includes(`Attempt(${operation});`)]),
    ['primary', !cleanup.includes('failure = ExceptionDispatchInfo.Capture(error);') || !cleanup.includes('failure.Throw();')],
    ['secondary', !cleanup.includes('secondaryFailures.Add(error);') || !cleanup.includes('secondaryFailures.ToArray();')],
    ['trace retirement', !/try \{ Flush\(\); \}\s+finally\s+\{\s+disposed = true;\s+AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;/.test(value)],
  ].filter(([, invalid]) => invalid).map(([name]) => name);
}

test('cleanup потребителя сохраняет независимые attempts и trace retirement: SOURCE controls', () => {
  assert.deepEqual(violations(source), []);
  for (const [before, after, name] of [
    ['Attempt(motion.Dispose);', 'motion.Dispose();', 'motion.Dispose'],
    ['Attempt(resources[i].Dispose);', 'resources[i].Dispose();', 'resources[i].Dispose'],
    ['Attempt(trace.Dispose);', 'trace.Dispose();', 'trace.Dispose'],
    ['secondaryFailures.Add(error);', '', 'secondary'],
    ['failure.Throw();', '', 'primary'],
    ['finally\n                {\n                    disposed = true;', 'finally\n                {', 'trace retirement'],
  ]) {
    const mutant = source.replace(before, after);
    assert.notEqual(mutant, source, name);
    assert(violations(mutant).includes(name), name);
  }
});

test('runtime controls извлекают настоящие методы и проверяют healthy/одиночные/compound/repeat', () => {
  const controls = read('./interaction-cleanup.test.ps1');
  for (const required of ["Read-Method '    private void Detach('", "Read-Method '        private void OnProcessExit('",
    "source.IndexOf('        public void Dispose()'", 'Add-Type -TypeDefinition $code',
    'faults.Calls.SequenceEqual(order)', 'ReferenceEquals(error, faults.Errors[failures[0]])',
    'error!.StackTrace!.Contains(nameof(Faults.Invoke))', 'Capture(probe.Run)', 'trace.Retired',
    'InteractionProbe.CleanupFailures', 'InteractionTrace.CleanupFailures', '$count -ne 18']) assert(controls.includes(required), required);
});
