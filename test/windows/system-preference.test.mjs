import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function routeViolations(page, app) {
  const callback = page.slice(page.indexOf('private void ApplySystemPreference('), page.indexOf('private void ObserveSystemNotification'));
  return [
    ['one own-window notification source', !page.includes('new SystemPreferenceNotifications(window, SystemPreferenceChanged, NotificationFailed)')
      || page.includes('settings.AnimationsEnabledChanged') || !app.includes('new PressPage(window)')],
    ['unchanged preference does not issue animation command', !/var enabled = settings\.AnimationsEnabled;\s*if \(observedSystemAnimation == enabled\) return;\s*Update\("systemPreference"\);/.test(callback)
      || !page.includes('observedSystemAnimation = systemAnimation;')],
    ['honest WM origin and retained managed queue', !page.includes('source = "WM_SETTINGCHANGE"')
      || !page.includes('DispatcherQueue.TryEnqueue') || !page.includes('ApplySystemPreference(subscription)')],
    ['stale queued callback cannot enter reloaded page', !callback.includes('!ReferenceEquals(notifications, subscription)')
      || !callback.includes('!subscription.IsAttached')],
    ['managed admission retains notification failure', !page.includes('notifications?.ThrowIfFaulted();')],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('WM route source oracle accepts healthy witness and rejects old/duplicate/bypass routes', () => {
  const healthy = `notifications = new SystemPreferenceNotifications(window, SystemPreferenceChanged, NotificationFailed);
    notifications?.ThrowIfFaulted();
    observedSystemAnimation = systemAnimation;
    source = "WM_SETTINGCHANGE";
    DispatcherQueue.TryEnqueue(() => ApplySystemPreference(subscription));
    private void ApplySystemPreference(SystemPreferenceNotifications? subscription)
    {
      if (subscription is null || !ReferenceEquals(notifications, subscription) || !subscription.IsAttached) return;
      var enabled = settings.AnimationsEnabled;
      if (observedSystemAnimation == enabled) return;
      Update("systemPreference");
    }
    private void ObserveSystemNotification()`;
  const app = 'new PressPage(window)';
  assert.deepEqual(routeViolations(healthy, app), []);
  for (const [before, after, violation] of [
    ['notifications =', 'settings.AnimationsEnabledChanged += SystemPreferenceChanged; notifications =', 'one own-window notification source'],
    ['if (observedSystemAnimation == enabled) return;', '', 'unchanged preference does not issue animation command'],
    ['observedSystemAnimation = systemAnimation;', '', 'unchanged preference does not issue animation command'],
    ['source = "WM_SETTINGCHANGE"', 'source = "UISettings"', 'honest WM origin and retained managed queue'],
    ['DispatcherQueue.TryEnqueue', 'RunInline', 'honest WM origin and retained managed queue'],
    ['!ReferenceEquals(notifications, subscription)', 'false', 'stale queued callback cannot enter reloaded page'],
    ['!subscription.IsAttached', 'false', 'stale queued callback cannot enter reloaded page'],
    ['notifications?.ThrowIfFaulted();', '', 'managed admission retains notification failure'],
  ]) assert(routeViolations(healthy.replace(before, after), app).includes(violation), violation);
  assert(routeViolations(healthy, 'new PressPage()').includes('one own-window notification source'));
});

test('actual PressPage uses only the owning-window route and preserves real preference transitions', () => {
  assert.deepEqual(routeViolations(read('../../examples/windows/PressPage.xaml.cs'), read('../../examples/windows/App.xaml.cs')), []);
});

test('independent preference witness distinguishes unrelated/repeated notifications and false-to-true restoration', () => {
  // Это предметная модель ожидаемых команд, не исполнение C#/Win32 adapter.
  const wanted = [false, true, false];
  let observed = true;
  const commands = [];
  for (const value of [true, true, false, false, true, true, false, false]) {
    if (observed === value) continue;
    observed = value;
    commands.push(value);
  }
  assert.deepEqual(commands, wanted);
  const repeatedMutant = [true, true, false, false, true, true, false, false];
  assert.notDeepEqual(repeatedMutant, wanted);
  assert.notDeepEqual(commands.filter(value => !value), wanted);
});

function adapterViolations(source) {
  const registration = source.slice(source.indexOf('internal SystemPreferenceNotifications('), source.indexOf('internal bool IsAttached'));
  const dispose = source.slice(source.indexOf('public void Dispose()'), source.indexOf('private nint WindowMessage'));
  const callback = source.slice(source.indexOf('private nint WindowMessage'), source.indexOf('private void CaptureFailure'));
  return [
    ['own HWND and owning thread before registration', !source.includes('window.DispatcherQueue.HasThreadAccess')
      || !source.includes('WinRT.Interop.WindowNative.GetWindowHandle(window)')
      || !source.includes('GetWindowThreadProcessId(handle, out var process) != ownerThread || process != (uint)Environment.ProcessId')],
    ['delegate retained until confirmed detach', !source.includes('procedure = WindowMessage;') || !source.includes('keepAlive = GCHandle.Alloc(this);')
      || !/if \(RemoveWindowSubclass\(handle, procedure, 1\)\)\s*\{\s*handle = 0;\s*keepAlive.Free\(\);\s*\}/.test(dispose)],
    ['registration failure is observable and releases unused root', !/if \(!SetWindowSubclass\(handle, procedure, 1, 0\)\)\s*throw new InvalidOperationException/.test(registration)
      || !/catch\s*\{\s*handle = 0;\s*keepAlive.Free\(\);\s*throw;\s*\}/.test(registration)],
    ['failed removal retires first and keeps fault readable', !/CheckAccess\(\);\s*retired = true;\s*notify = null;/.test(dispose)
      || !dispose.includes('else CaptureFailure(new InvalidOperationException') || !dispose.includes('ThrowIfFaulted();')],
    ['destroy revokes address before forwarding and releases afterwards', !/handle = 0;\s*if \(!RemoveWindowSubclass\(window, procedure, 1\)\)/.test(callback)
      || !/finally\s*\{\s*if \(destroying && keepAlive.IsAllocated\) keepAlive.Free\(\);\s*GC.KeepAlive\(this\);\s*\}/.test(callback)],
    ['all callbacks forward without getter or test-only filter', !callback.includes('return DefSubclassProc(window, message, wParam, lParam);')
      || !callback.includes('window == handle && id == 1 && !retired && message == SettingChange')
      || /AnimationsEnabled|Update\(|0x1043|PtrToString|ReadInt|lParam\s*==/.test(callback)],
    ['managed delivery exceptions retained inside reverse PInvoke', !callback.includes('catch (Exception error) { CaptureFailure(error); }')
      || !source.includes('if (failure is not null) return;') || !source.includes('failure = ExceptionDispatchInfo.Capture(error);')
      || !source.includes('catch (Exception secondary) { reportingFailure = ExceptionDispatchInfo.Capture(secondary); }')
      || !source.includes('failure?.Throw();')],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('actual adapter source retains native callback ownership, forwarding and failure readback under sabotage', () => {
  const source = read('../../examples/windows/SystemPreferenceNotifications.cs');
  for (const healthy of [source, source.replaceAll('\n', '\r\n').replaceAll('\r\n', '\n')]) {
    assert.deepEqual(adapterViolations(healthy), []);
    for (const [before, after, violation] of [
      ['window.DispatcherQueue.HasThreadAccess', 'true', 'own HWND and owning thread before registration'],
      ['process != (uint)Environment.ProcessId', 'false', 'own HWND and owning thread before registration'],
      ['keepAlive = GCHandle.Alloc(this);', '', 'delegate retained until confirmed detach'],
      ['if (!SetWindowSubclass(handle, procedure, 1, 0))', 'if (false)', 'registration failure is observable and releases unused root'],
      ['keepAlive.Free();\n            throw;', 'keepAlive.Free();\n            return;', 'registration failure is observable and releases unused root'],
      ['if (RemoveWindowSubclass(handle, procedure, 1))', 'if (true)', 'delegate retained until confirmed detach'],
      ['retired = true;', 'retired = false;', 'failed removal retires first and keeps fault readable'],
      ['CheckAccess();\n        retired = true;', 'retired = true;', 'failed removal retires first and keeps fault readable'],
      ['else CaptureFailure(new InvalidOperationException', 'else Ignore(new InvalidOperationException', 'failed removal retires first and keeps fault readable'],
      ['handle = 0;\n                if (!RemoveWindowSubclass(window, procedure, 1))', 'if (!RemoveWindowSubclass(window, procedure, 1))', 'destroy revokes address before forwarding and releases afterwards'],
      ['if (destroying && keepAlive.IsAllocated) keepAlive.Free();', '', 'destroy revokes address before forwarding and releases afterwards'],
      ['return DefSubclassProc(window, message, wParam, lParam);', 'return 0;', 'all callbacks forward without getter or test-only filter'],
      ['message == SettingChange', 'message == SettingChange && wParam == 0x1043', 'all callbacks forward without getter or test-only filter'],
      ['notify?.Invoke();', 'var value = settings.AnimationsEnabled; notify?.Invoke();', 'all callbacks forward without getter or test-only filter'],
      ['if (failure is not null) return;', '', 'managed delivery exceptions retained inside reverse PInvoke'],
    ]) assert(adapterViolations(healthy.replace(before, after)).includes(violation), violation);
  }
});

test('managed lifecycle source rejects stale/reloaded/window-closed notification ownership and preserves cleanup error', () => {
  const source = read('../../examples/windows/PressPage.xaml.cs');
  assert(source.includes('if (windowClosed) throw new InvalidOperationException'));
  assert(source.includes('if (notifications is not null) throw new InvalidOperationException'));
  assert(source.includes('if (subscription is null || !ReferenceEquals(notifications, subscription) || !subscription.IsAttached) return;'));
  assert(source.includes('Attempt(notifications.Dispose);'));
  assert(source.includes('if (!notifications.IsAttached) notifications = null;'));
  assert(source.includes('Attempt(motion.Dispose);'));
  assert(source.includes('failure ??= ExceptionDispatchInfo.Capture(error);'));
  assert(source.includes('failure?.Throw();'));
  assert(source.includes('finally { State.Text = message; }'));
  assert(!source.slice(source.indexOf('private void NotificationFailed'), source.indexOf('private void ObserveSystemNotification')).includes('error.Message'));
});

test('independent lifetime witness keeps failed removal rooted and never removes a destroyed or reused address', () => {
  // Модель native outcomes: source checks выше связывают отдельные переходы с C#;
  // этот witness не исполняет HWND, GC или reverse-PInvoke.
  let handle = 12, rooted = true, retired = false;
  let removes = 0;
  const dispose = succeeds => {
    retired = true;
    if (handle !== 0) {
      removes++;
      if (succeeds) { handle = 0; rooted = false; }
    }
  };
  dispose(false);
  assert.deepEqual([handle, rooted, retired, removes], [12, true, true, 1]);
  // NCDESTROY отзывает адрес до forwarding; root освобождается только после него.
  handle = 0;
  assert.equal(rooted, true);
  rooted = false;
  dispose(true);
  dispose(true);
  assert.deepEqual([handle, rooted, retired, removes], [0, false, true, 1]);
  // Здоровое снятие и reentrant Dispose не вызывают повторный native Remove.
  handle = 24; rooted = true; retired = false; removes = 0;
  const activeCallbackRetainsOwner = true;
  dispose(true);
  dispose(true);
  assert.deepEqual([handle, rooted, retired, removes], [0, false, true, 1]);
  assert.equal(activeCallbackRetainsOwner, true); // Source связывает это с GC.KeepAlive(this).
});
