import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('canonical animation property event replaces WM-only transport on supported Windows', () => {
  const adapter = read('../../examples/windows/SystemPreferenceNotifications.cs');
  const page = read('../../examples/windows/PressPage.xaml.cs');
  assert(adapter.includes('settings.AnimationsEnabledChanged += AnimationsChanged;'));
  assert(adapter.includes('UISettingsAnimationsEnabledChangedEventArgs args'));
  assert(adapter.includes('notify(this);'));
  assert(!/DllImport|SetWindowSubclass|WindowMessage|GCHandle/.test(adapter));
  assert(page.includes('new SystemPreferenceNotifications(settings, DispatcherQueue, SystemPreferenceChanged, NotificationFailed)'));
  assert(page.includes('private void SystemPreferenceChanged(SystemPreferenceNotifications subscription)'));
  assert(page.includes('source = "UISettings.AnimationsEnabledChanged"'));
});

function timingViolations({ setter, adapter, page, harness }) {
  return [
    ['native SET boundaries and existing GET receipt', !/SetEnteredQpc = ReadQpc\(\);\s*var success = Set\(0x1043, 0, new IntPtr\(enabled \? 1 : 0\), 2\);/.test(setter)
      || !setter.includes('SetReturnedQpc = ReadQpc();') || !setter.includes('ReadbackEnabled = Read();')
      || !setter.includes('ReadbackQpc = ReadQpc();') || !setter.includes('SetSucceeded = success;')
      || !/var error = success \? 0 : Marshal.GetLastWin32Error\(\);\s*SetReturnedQpc = ReadQpc\(\);/.test(setter)],
    ['no-profile and unchanged getter count', (setter.match(/Get\(0x1042/g) ?? []).length !== 1
      || (setter.match(/\bRead\(\)/g) ?? []).length !== 2 || setter.includes('new IntPtr(enabled ? 1 : 0), 3')],
    ['canonical native receipt retains source identity', !adapter.includes('notify(this);')
      || !adapter.includes('settings.AnimationsEnabledChanged += AnimationsChanged;')
      || !page.includes('source = "UISettings.AnimationsEnabledChanged"')],
    ['actual sparse QPC and closed Apply outcomes', !page.includes('SystemPreferenceOutcome { Missing, Stale, Detached, Deduplicated, Update }')
      || !page.includes('Stopwatch.GetTimestamp()') || !page.includes('Stopwatch.IsHighResolution')
      || !page.includes('qpcFrequency = ReadQpcFrequencyForTrace()')
      || !page.includes('ObserveSystemApply(notification, SystemPreferenceOutcome.Deduplicated, enabled, observed);')
      || !page.includes('ObserveSystemApply(notification, SystemPreferenceOutcome.Update, enabled, observed);')],
    ['completed uses absolute timestamp, not frame sampling', !/trace\?\.Add\("completed", new\s*\{\s*qpc = ReadQpcForTrace\(\)/.test(page)
      || /private void Observe\(MotionObservation[^]*?qpc/.test(page.slice(page.indexOf('private void Observe(MotionObservation'), page.indexOf('private void Input(')))],
    ['existing failure projection carries setter and sparse timing', !harness.includes('-Setter $systemSetterReceipt')
      || !harness.includes('timingOmitted = $timingCount - $timing.Count')
      || !harness.includes("'systemApply' { $timingPhase = 'systemApply' }")
      || !harness.includes("Read-InputPhaseField $data 'outcome' 'outcome'")
      || !harness.includes('SetEnteredQpc = [ClientAreaAnimation]::SetEnteredQpc')
      || !harness.includes('$summary.Length -le 1800')],
    ['outcome logging cannot become policy or per-frame effect', !/Update\("systemPreference"\);\s*ObserveSystemApply\(notification, SystemPreferenceOutcome.Update, enabled, observed\);/.test(page)
      || !/catch \{ Interlocked.Exchange\(ref notificationDiagnosticFailed, 1\); \}/.test(page)
      || !page.includes('trace.Flush();')],
  ].filter(([, bad]) => bad).map(([name]) => name);
}

test('SET/native-event/Apply/completed сохраняют различающую QPC проекцию при замене транспорта', () => {
  const actual = { setter: read('./animation-settings.cs'), adapter: read('../../examples/windows/SystemPreferenceNotifications.cs'),
    page: read('../../examples/windows/PressPage.xaml.cs'), harness: read('./verify-input.ps1') };
  assert.deepEqual(timingViolations(actual), []);
  for (const [file, before, after, violation] of [
    ['setter', 'SetEnteredQpc = ReadQpc();', 'SetEnteredQpc = null;', 'native SET boundaries and existing GET receipt'],
    ['setter', 'SetSucceeded = success;', 'SetSucceeded = true;', 'native SET boundaries and existing GET receipt'],
    ['setter', 'new IntPtr(enabled ? 1 : 0), 2', 'new IntPtr(enabled ? 1 : 0), 3', 'no-profile and unchanged getter count'],
    ['adapter', 'notify(this);', 'notify(null!);', 'canonical native receipt retains source identity'],
    ['page', 'Stopwatch.GetTimestamp()', 'Stopwatch.StartNew().ElapsedTicks', 'actual sparse QPC and closed Apply outcomes'],
    ['page', 'SystemPreferenceOutcome.Deduplicated, enabled, observed', 'SystemPreferenceOutcome.Update, enabled, observed', 'actual sparse QPC and closed Apply outcomes'],
    ['page', 'qpc = ReadQpcForTrace()', 'qpc = null', 'completed uses absolute timestamp, not frame sampling'],
    ['harness', '-Setter $systemSetterReceipt', '', 'existing failure projection carries setter and sparse timing'],
    ['harness', "Read-InputPhaseField $data 'outcome' 'outcome'", '$data.outcome', 'existing failure projection carries setter and sparse timing'],
    ['page', 'Update("systemPreference");\n        ObserveSystemApply', 'ObserveSystemApply', 'outcome logging cannot become policy or per-frame effect'],
  ]) assert(timingViolations({ ...actual, [file]: actual[file].replaceAll(before, after) }).includes(violation), violation);
  const controls = read('./cleanup.test.ps1');
  for (const name of ['phase-qpc-healthy-control', 'phase-qpc-outcome-or-unavailable-control',
    'phase-qpc-unrelated-unavailable-frequency-control', 'phase-qpc-malformed-control', 'phase-qpc-bounded-control']) assert(controls.includes(name), name);
});

function inputSuiteWiringViolations(source) {
  const invocations = [...source.matchAll(/^    & node --test (.+)\n    if \(\$LASTEXITCODE -ne 0\) \{ throw 'Проверки различающей силы input oracle не прошли\.' \}/gm)];
  const wanted = "(Join-Path $PSScriptRoot 'assert-input.test.mjs') (Join-Path $PSScriptRoot 'system-preference.test.mjs') (Join-Path $PSScriptRoot 'dispose.test.mjs')";
  return invocations.length === 1 && invocations[0][1] === wanted
    && (source.match(/& node --test/g) ?? []).length === 1 ? [] : ['one mandatory invocation executes both suites and retains failure guard'];
}

test('mandatory input entry executes all three source suites exactly once in the existing Node guard', () => {
  const healthy = "    & node --test (Join-Path $PSScriptRoot 'assert-input.test.mjs') (Join-Path $PSScriptRoot 'system-preference.test.mjs') (Join-Path $PSScriptRoot 'dispose.test.mjs')\n"
    + "    if ($LASTEXITCODE -ne 0) { throw 'Проверки различающей силы input oracle не прошли.' }";
  assert.deepEqual(inputSuiteWiringViolations(healthy), []);
  for (const mutant of [
    healthy.replace(" (Join-Path $PSScriptRoot 'system-preference.test.mjs')", ''),
    healthy.replace(" (Join-Path $PSScriptRoot 'dispose.test.mjs')", ''),
    healthy.replace('$LASTEXITCODE -ne 0', '$false'),
    healthy + "\n    & node --test (Join-Path $PSScriptRoot 'system-preference.test.mjs')",
  ]) assert.equal(inputSuiteWiringViolations(mutant).length, 1);
  assert.deepEqual(inputSuiteWiringViolations(read('./verify-input.ps1')), []);
  assert(!read('./assert-input.test.mjs').includes("from './system-preference.test.mjs'"));
});

function routeViolations(page, app) {
  const callback = page.slice(page.indexOf('private void SystemPreferenceChanged('), page.indexOf('private void ApplySystemPreference('));
  const apply = page.slice(page.indexOf('private void ApplySystemPreference('), page.indexOf('private void NotificationFailed('));
  const reporting = page.slice(page.indexOf('private void NotificationFailed('), page.indexOf('private void ObserveSystemNotification('));
  return [
    ['one owned-settings notification source', !page.includes('new SystemPreferenceNotifications(settings, DispatcherQueue, SystemPreferenceChanged, NotificationFailed)')
      || page.includes('settings.AnimationsEnabledChanged') || !app.includes('new PressPage(window)')],
    ['callback carries its exact subscription', !callback.includes('private void SystemPreferenceChanged(SystemPreferenceNotifications subscription)')
      || callback.includes('var subscription = notifications') || !callback.includes('ApplySystemPreference(subscription)')],
    ['unchanged preference does not issue animation command', !/var enabled = settings\.AnimationsEnabled;\s*var observed = observedSystemAnimation;\s*if \(observed == enabled\)/.test(apply)
      || !apply.includes('SystemPreferenceOutcome.Deduplicated') || !apply.includes('Update("systemPreference");')
      || !page.includes('observedSystemAnimation = systemAnimation;')],
    ['honest property-event origin and retained managed queue', !page.includes('source = "UISettings.AnimationsEnabledChanged"')
      || !callback.includes('DispatcherQueue.TryEnqueue') || /settings\.|Animation\.|State\.|motion\.|notifications/.test(callback)],
    ['stale or retired queued callback cannot enter reloaded page', !apply.includes('!ReferenceEquals(notifications, subscription)')
      || !apply.includes('!subscription.IsAttached') || !apply.includes('if (!subscription.IsActive)')
      || apply.indexOf('subscription.ThrowIfFaulted();') > apply.indexOf('var enabled = settings.AnimationsEnabled;')],
    ['failure UI guards both thread and subscription identity', !reporting.includes('if (!DispatcherQueue.HasThreadAccess)')
      || !reporting.includes('if (!ReferenceEquals(notifications, subscription)) return;')],
    ['managed admission retains notification failure', !page.includes('notifications?.ThrowIfFaulted();')],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('property-event source contract rejects duplicate, stale, inline and misattributed delivery', () => {
  const page = read('../../examples/windows/PressPage.xaml.cs');
  const app = read('../../examples/windows/App.xaml.cs');
  assert.deepEqual(routeViolations(page, app), []);
  for (const [before, after, violation] of [
    ['new SystemPreferenceNotifications(settings, DispatcherQueue', 'new SystemPreferenceNotifications(new UISettings(), DispatcherQueue', 'one owned-settings notification source'],
    ['SystemPreferenceChanged(SystemPreferenceNotifications subscription)', 'SystemPreferenceChanged(SystemPreferenceNotifications ignored)\n    { var subscription = notifications;', 'callback carries its exact subscription'],
    ['if (observed == enabled)', 'if (false)', 'unchanged preference does not issue animation command'],
    ['source = "UISettings.AnimationsEnabledChanged"', 'source = "WM_SETTINGCHANGE"', 'honest property-event origin and retained managed queue'],
    ['DispatcherQueue.TryEnqueue', 'RunInline', 'honest property-event origin and retained managed queue'],
    ['!ReferenceEquals(notifications, subscription)', 'false', 'stale or retired queued callback cannot enter reloaded page'],
    ['!subscription.IsAttached', 'false', 'stale or retired queued callback cannot enter reloaded page'],
    ['if (!subscription.IsActive)', 'if (false)', 'stale or retired queued callback cannot enter reloaded page'],
    ['if (!DispatcherQueue.HasThreadAccess)', 'if (false)', 'failure UI guards both thread and subscription identity'],
    ['notifications?.ThrowIfFaulted();', '', 'managed admission retains notification failure'],
  ]) assert(routeViolations(page.replaceAll(before, after), app).includes(violation), violation);
  assert(routeViolations(page, 'new PressPage()').includes('one owned-settings notification source'));
});

test('actual PressPage uses only the owned-settings event and preserves real preference transitions', () => {
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
  const dispose = source.slice(source.indexOf('public void Dispose()'), source.indexOf('private void AnimationsChanged'));
  const callback = source.slice(source.indexOf('private void AnimationsChanged'), source.indexOf('private bool SaveFailure'));
  const saving = source.slice(source.indexOf('private bool SaveFailure'), source.indexOf('private void CaptureFailure'));
  const reporting = source.slice(source.indexOf('private void ReportFailure'), source.indexOf('private void CheckAccess'));
  return [
    ['single typed native event on owned UISettings', !source.includes('UISettingsAnimationsEnabledChangedEventArgs args')
      || (source.match(/settings\.AnimationsEnabledChanged \+= AnimationsChanged;/g) ?? []).length !== 1
      || !source.includes('settings.AnimationsEnabledChanged -= AnimationsChanged;')
      || /DllImport|SetWindowSubclass|GCHandle|WindowMessage|Timer|Task\.Delay|args\./.test(source)],
    ['owner UI admission before native registration', registration.indexOf('CheckAccess();') < 0
      || registration.indexOf('CheckAccess();') > registration.indexOf('settings.AnimationsEnabledChanged +=')],
    ['actual transport and active effect are separate synchronized states', !source.includes('lock (gate) return subscribed;')
      || !source.includes('lock (gate) return subscribed && !retired;')],
    ['revoke before native removal and retain failed transport', !/CheckAccess\(\);\s*bool remove;\s*lock \(gate\) \{ retired = true; remove = subscribed; \}/.test(dispose)
      || !/settings\.AnimationsEnabledChanged -= AnimationsChanged;\s*lock \(gate\) subscribed = false;/.test(dispose)
      || !dispose.includes('catch (Exception error) { CaptureFailure(error); }') || !dispose.includes('ThrowIfFaulted();')],
    ['delivery shares retirement lock and carries exact identity without UI getter', !/lock \(gate\)\s*\{\s*if \(retired \|\| !subscribed\) return;/.test(callback)
      || !callback.includes('try { notify(this); }') || !callback.includes('if (SaveFailure(error)) deliveryFailure = error;')
      || /settings\.|AnimationsEnabled\b|Update\(|State\./.test(callback)],
    ['first fault retired and retained under shared lock', !/lock \(gate\)\s*\{\s*retired = true;\s*if \(failure is not null\) return false;\s*failure = ExceptionDispatchInfo.Capture\(error\);/.test(saving)
      || !source.includes('lock (gate) { primary = failure; secondary = reportingFailure; }')
      || !source.includes('primary?.Throw();')],
    ['reporting uses owner UI queue and preserves secondary failure', !reporting.includes('if (dispatcher.HasThreadAccess) reportFailure(this, error);')
      || !reporting.includes('else if (!dispatcher.TryEnqueue(() => ReportFailure(error)))')
      || !reporting.includes('catch (Exception secondary) { SaveReportingFailure(secondary); }')
      || !reporting.includes('lock (gate) reportingFailure ??= ExceptionDispatchInfo.Capture(error);')],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('native property adapter preserves retirement, actual revocation and background-fault reporting under sabotage', () => {
  const source = read('../../examples/windows/SystemPreferenceNotifications.cs');
  for (const healthy of [source, source.replaceAll('\n', '\r\n').replaceAll('\r\n', '\n')]) {
    assert.deepEqual(adapterViolations(healthy), []);
    for (const [before, after, violation] of [
      ['settings.AnimationsEnabledChanged += AnimationsChanged;', '', 'single typed native event on owned UISettings'],
      ['CheckAccess();\n        settings.AnimationsEnabledChanged', 'settings.AnimationsEnabledChanged', 'owner UI admission before native registration'],
      ['lock (gate) return subscribed;', 'return !retired;', 'actual transport and active effect are separate synchronized states'],
      ['lock (gate) return subscribed && !retired;', 'lock (gate) return subscribed;', 'actual transport and active effect are separate synchronized states'],
      ['retired = true; remove = subscribed;', 'retired = false; remove = subscribed;', 'revoke before native removal and retain failed transport'],
      ['settings.AnimationsEnabledChanged -= AnimationsChanged;', 'IgnoreRemove();', 'single typed native event on owned UISettings'],
      ['if (retired || !subscribed) return;', 'if (false) return;', 'delivery shares retirement lock and carries exact identity without UI getter'],
      ['notify(this);', 'notify(null!);', 'delivery shares retirement lock and carries exact identity without UI getter'],
      ['if (failure is not null) return false;', '', 'first fault retired and retained under shared lock'],
      ['if (dispatcher.HasThreadAccess) reportFailure(this, error);', 'reportFailure(this, error);', 'reporting uses owner UI queue and preserves secondary failure'],
      ['lock (gate) reportingFailure ??= ExceptionDispatchInfo.Capture(error);', 'reportingFailure = null;', 'reporting uses owner UI queue and preserves secondary failure'],
    ]) assert(adapterViolations(healthy.replace(before, after)).includes(violation), violation);
  }
});

test('managed lifecycle source rejects stale/reloaded/window-closed notification ownership and preserves cleanup error', () => {
  const source = read('../../examples/windows/PressPage.xaml.cs');
  assert(source.includes('if (windowClosed) throw new InvalidOperationException'));
  assert(source.includes('if (notifications is not null) throw new InvalidOperationException'));
  assert.match(source, /if \(subscription is null \|\| !ReferenceEquals\(notifications, subscription\) \|\| !subscription.IsAttached\)\s*\{[^]*?ObserveSystemApply\(notification, outcome, null, null\);\s*return;/);
  assert(source.includes('Attempt(subscription.Dispose);'));
  assert(source.includes('if (!subscription.IsAttached && ReferenceEquals(notifications, subscription)) notifications = null;'));
  assert(source.includes('Attempt(motion.Dispose);'));
  assert(source.includes('failure ??= ExceptionDispatchInfo.Capture(error);'));
  assert(source.includes('failure?.Throw();'));
  assert(source.includes('finally { State.Text = message; }'));
  assert(!source.slice(source.indexOf('private void NotificationFailed'), source.indexOf('private void ObserveSystemNotification')).includes('error.Message'));
});

test('independent lifetime control covers queued stale identity, failed unsubscribe, retry and repeated disposal', () => {
  // Модель ожидаемого контракта; это не исполнение C#/WinRT adapter.
  const current = { subscribed: true, retired: false, fault: null };
  const queue = [];
  let active = current, changes = 0, removals = 0;
  const receive = subscription => {
    if (!subscription.subscribed || subscription.retired) return;
    queue.push(subscription); // Sender identity не подменяется поздним active.
  };
  const apply = subscription => {
    if (subscription !== active || !subscription.subscribed || subscription.retired) return;
    changes++;
  };
  const dispose = (subscription, succeeds) => {
    subscription.retired = true;
    if (subscription.subscribed) {
      removals++;
      if (succeeds) subscription.subscribed = false;
      else subscription.fault ??= 'unsubscribe-primary';
    }
  };
  receive(current);
  dispose(current, false);
  assert.deepEqual(current, { subscribed: true, retired: true, fault: 'unsubscribe-primary' });
  receive(current);
  queue.forEach(apply);
  assert.equal(changes, 0);
  dispose(current, true);
  dispose(current, true);
  assert.deepEqual([current.subscribed, current.retired, current.fault, removals], [false, true, 'unsubscribe-primary', 2]);
  active = { subscribed: true, retired: false, fault: null };
  queue.forEach(apply);
  assert.equal(changes, 0, 'старый queued callback не принимает новую subscription');
  receive(active);
  apply(queue.at(-1));
  assert.equal(changes, 1, 'здоровый native callback допускает полезную реакцию');
  const unrelated = { subscribed: true, retired: false, fault: null };
  receive(unrelated);
  apply(queue.at(-1));
  assert.equal(changes, 1, 'чужая subscription не получает эффект current page');
});
