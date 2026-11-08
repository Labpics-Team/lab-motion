import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../../examples/windows/native/PreferenceDiagnostics.cpp');
const native = source.slice(source.indexOf('namespace WindowPreferenceDiagnostics'));
const wrapper = read('../../examples/windows/WindowPreferenceDiagnostics.cs');
const adapter = read('../../examples/windows/SystemPreferenceNotifications.cs');
const page = read('../../examples/windows/PressPage.xaml.cs');
const harness = read('./verify-input.ps1');
const setter = read('./animation-settings.cs');

function violations(value) {
  return [
    ['forward original result', !value.includes('const LRESULT result = DefSubclassProc(window, message, wParam, lParam);') || !value.includes('return result;')],
    ['destroy revoke before forward', value.indexOf('record->window = nullptr; // До forwarding') > value.indexOf('const LRESULT result = DefSubclassProc')],
    ['separate control', !value.includes('Increment(state.controlCount, state);') || !value.includes('Increment(state.rawCount, state);') || !value.includes('if (action == ClientAreaAnimation)')],
    ['retain HWND through failed remove', !value.slice(value.indexOf('HRESULT Close('), value.indexOf('LRESULT CALLBACK WindowMessage(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR id, DWORD_PTR reference) noexcept\n    {')).includes('else state.flags |= Faulted;') || !value.includes('if (releaseWindow) record->Release();')],
    ['owner thread restriction', !value.includes('GetCurrentThreadId() != record->ownerThread') || !value.includes('GetWindowThreadProcessId')],
    ['qualified context', !value.includes('GetProcessIdOfThread(thread) == setterProcess') || !value.includes('ProcessIdToSessionId') || !value.includes('CompareStringOrdinal(ownStation, -1, setterStation, -1, TRUE)')],
    ['no raw message data or product effect', /reinterpret_cast<[^>]+>\(lParam\)|\blParam\s*\[|SystemParametersInfo|TryEnqueue|ApplySystemPreference|AnimationsEnabled/.test(value)],
  ].filter(([, failed]) => failed).map(([name]) => name);
}
test('passive HWND source boundaries detect sabotage (SOURCE, not native delivery)', () => {
  assert.deepEqual(violations(native), []);
  for (const [before, after, expected] of [
    ['const LRESULT result = DefSubclassProc(window, message, wParam, lParam);', 'const LRESULT result = 0;', 'forward original result'],
    ['Increment(state.rawCount, state);', 'Increment(state.controlCount, state);', 'separate control'],
    ['GetCurrentThreadId() != record->ownerThread', 'false', 'owner thread restriction'],
    ['CompareStringOrdinal(ownStation, -1, setterStation, -1, TRUE)', 'CSTR_EQUAL', 'qualified context'],
    ['else state.flags |= Faulted;\n        ReleaseSRWLockExclusive(&record->lock);\n        if (release)', 'else state.flags &= ~Attached;\n        ReleaseSRWLockExclusive(&record->lock);\n        if (release)', 'retain HWND through failed remove'],
  ]) {
    assert(native.includes(before));
    assert(violations(native.replace(before, after)).includes(expected));
  }
  assert(source.includes('static_assert(sizeof(Snapshot) == 72'));
  assert(source.includes('static_assert(sizeof(Snapshot) == 96'));
});
test('HWND wrapper and captured completion remain diagnostic-only and nullable', () => {
  assert(wrapper.includes('SafeHandleZeroOrMinusOneIsInvalid'));
  assert(wrapper.includes('Flag(2) ? Flag(4) : null'));
  assert(wrapper.includes('Flag(8) ? Flag(16) : null'));
  assert(wrapper.includes('GC.KeepAlive(window)'));
  assert(adapter.includes('if (captureDiagnostics && windowDiagnostics is null)'));
  assert(page.indexOf('notifications.AttachWindowDiagnostics(window);') > page.indexOf('notifications = new SystemPreferenceNotifications'));
  assert(page.includes('windowDiagnostics = ReadWindowDiagnosticsForTrace(subscriptionForTrace)'));
  const helper = page.slice(page.indexOf('private WindowPreferenceDiagnostics.Snapshot? ReadWindow'), page.indexOf('private bool? ReadSystemAnimationForTrace'));
  assert(helper.includes('DispatcherQueue.HasThreadAccess'));
  assert(!/Apply|TryEnqueue|Flush|settings\./.test(helper.replace(/\/\/[^\n]*/g, '')));
  assert(harness.indexOf('$windowSummary = $null', harness.indexOf('if ($captureProjection)')) < harness.indexOf("$windowProperty = $data.PSObject.Properties['windowDiagnostics']"));
  assert(harness.includes('window = $windowSummary'));
  assert(harness.includes('$summary.Length -le 1800'));
});
test('readonly setter context receipt leaves actual SPI/GET/effect contract unchanged', () => {
  assert(setter.includes('ContextStillMatches = ReadContextMatch();'));
  assert(setter.includes('new IntPtr(enabled ? 1 : 0), 2'));
  assert.equal((setter.match(/\bRead\(\)/g) ?? []).length, 2);
  assert(harness.includes('[ClientAreaAnimation]::CaptureWindowDiagnosticContext()'));
  assert(harness.includes('ContextStillMatches = [ClientAreaAnimation]::ContextStillMatches'));
  assert(harness.includes("Read-InputPhaseField $Setter 'ContextStillMatches' 'bool'"));
  for (const name of ['LAB_MOTION_SETTER_PID', 'LAB_MOTION_SETTER_TID', 'LAB_MOTION_SETTER_STATION']) {
    assert(harness.slice(0, harness.indexOf('$saved[$name]')).includes(name));
  }
});
test('prepared native and PowerShell controls exercise actual helper, not a provider replacement', () => {
  const controls = read('./native-preference-controls.cpp');
  for (const name of ['window-control-separate-from-message', 'window-raw-action-forward-not-control',
    'window-wrong-thread-no-remove', 'window-destroy-revoke-forward-reclaim', 'window-no-subclass-ref-overwrite']) assert(controls.includes(name));
  assert(controls.includes('SendMessageW(window.value, WM_SETTINGCHANGE'));
  assert(!controls.includes('SystemParametersInfo'));
  const reader = read('./native-preference.test.ps1');
  for (const name of ['window-reader-control-not-system-delivery', 'window-reader-unknown-not-match',
    'window-reader-composed-fixed-budget', 'window-reader-latest-null-clears-positive']) assert(reader.includes(name));
  assert(read('./build-native-preference.ps1').includes('comctl32.lib user32.lib'));
});

test('synthetic HWND setting messages retain admissible nullable lParam (SOURCE, not native RCA)', () => {
  const controls = read('./native-preference-controls.cpp');
  const invalid = value => [...value.matchAll(/SendMessageW\([^\n]*WM_SETTINGCHANGE[^\n]*LPARAM\(1\)/g)];
  assert.equal(invalid(controls).length, 0, 'WM_SETTINGCHANGE lParam is a string pointer or NULL, never address1');
  assert(controls.includes('WM_SETTINGCHANGE, action, LPARAM(0)'));
  assert(controls.includes('WM_SETTINGCHANGE, W::ClientAreaAnimation, LPARAM(0)'));
  assert(invalid(controls.replaceAll('LPARAM(0)', 'LPARAM(1)')).length > 0, 'invalid payload source mutant rejected');
  assert(controls.includes('<< value <<'));
  assert(controls.includes("'\\n' << std::flush"));
  assert(controls.indexOf('WindowControls::Run();') > controls.indexOf('Require(recordsAlive == 0, "all-records-reclaimed")'));
  const build = read('./build-native-preference.ps1');
  assert(build.includes('$nativeExitCode = $LASTEXITCODE'));
  assert(build.includes('if ($nativeExitCode -ne 0)'));
  assert(build.includes('Native exitCode=$nativeExitCode'));
});
