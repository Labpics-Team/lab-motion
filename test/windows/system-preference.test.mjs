import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('lifecycle consumer compiles only its own fixtures and linked motion sources', () => {
  const project = read('./lifecycle.csproj');
  const expected = ['runner.cs', 'boundary-doubles.cs', 'binding-tests.cs', 'dispose-tests.cs',
    '../../native/windows/ScalarMotion.cs', '../../native/windows/ScalarBinding.cs'].sort();
  const admitsOnlyOwnedSources = xml => {
    const explicit = /<EnableDefaultCompileItems>\s*false\s*<\/EnableDefaultCompileItems>/.test(xml);
    const included = [...xml.matchAll(/<Compile\b[^>]*\bInclude="([^"]+)"/g)]
      .flatMap(match => match[1].split(';')).sort();
    return explicit && JSON.stringify(included) === JSON.stringify(expected);
  };
  assert(admitsOnlyOwnedSources(project), 'unrelated Add-Type controls must not enter lifecycle compilation');
  assert(!admitsOnlyOwnedSources(project.replace('<EnableDefaultCompileItems>false</EnableDefaultCompileItems>', '')));
  assert(!admitsOnlyOwnedSources(project.replace('</ItemGroup>', '<Compile Include="projection-diagnostics-controls.cs" /></ItemGroup>')));
  // Это SOURCE admission, не запуск MSBuild; реальный compiler проверяет existing Windows CI.
});

function projectionViolations(observer, adapter) {
  const callback = observer.slice(observer.indexOf('private void FirstChance('), observer.indexOf('private long BoundedNext'));
  return [
    ['trace-only-before-registration', !adapter.includes('captureDiagnostics ? ProjectionDiagnostics.Create(typeof(UISettings).Assembly) : null')
      || adapter.indexOf('ProjectionDiagnostics.Create(') > adapter.indexOf('settings.AnimationsEnabledChanged +=')],
    ['scoped-cleanup', !observer.includes('FirstChanceException += observer.FirstChance;')
      || !observer.includes('FirstChanceException -= FirstChance;')
      || !adapter.includes('catch { projectionDiagnostics?.Dispose(); throw; }')
      || !adapter.includes('finally { projectionDiagnostics?.Dispose(); }')],
    ['guard-and-closed-throwing-site', !observer.includes('[ThreadStatic]')
      || !observer.includes('finally { insideObserver = false; }')
      || !observer.includes('error.TargetSite?.Module.Assembly')
      || /error\.(Message|StackTrace|Source)|GetBaseException\(|new UISettings/.test(observer)],
    ['no-callback-effects', /File\.|HashData|lock\s*\(|Dispatcher|Console\.|\.Invoke\(/.test(callback)],
    ['newest-bounded-and-incomplete', !callback.includes('entry.Order > before.Last.Order')
      || !observer.includes('Math.Max(0, captured.Count - 1)')
      || !observer.includes('Interlocked.Exchange(ref faulted, 1)')],
  ].filter(([, bad]) => bad).map(([name]) => name);
}

test('latest completed resets projection before nullable-data admission, not only inside its reader', () => {
  const reader = read('./verify-input.ps1');
  const admission = reader.indexOf("if ($phase -eq 'completed' -and $null -ne $data)");
  const reset = reader.indexOf('$projectionSequence = $sequence');
  assert(reset >= 0 && reset < admission, 'null completed must clear old positive evidence');
  // Предметная модель expected selection; это не исполнение PowerShell helper.
  const events = [{ sequence: 395, completed: true, data: { projection: 'old-positive' } },
    { sequence: 400, completed: true, data: null }];
  const select = onlyNonNull => {
    let latest = -1, projection = null;
    for (const event of events) {
      if (!event.completed || event.sequence <= latest || (onlyNonNull && event.data === null)) continue;
      latest = event.sequence;
      projection = event.data?.projection ?? null;
    }
    return projection;
  };
  assert.equal(select(false), null);
  assert.equal(select(true), 'old-positive');
  assert(read('./projection-diagnostics.test.ps1').includes('projection-reader-latest-null-data'));
});

test('trace-only projection diagnostics preserve scope, thrown-owner fidelity and newest bounded evidence under sabotage', () => {
  const observer = read('../../examples/windows/ProjectionDiagnostics.cs');
  const adapter = read('../../examples/windows/SystemPreferenceNotifications.cs');
  assert.deepEqual(projectionViolations(observer, adapter), []);
  for (const [part, from, to, wanted] of [
    ['adapter', 'captureDiagnostics ? ProjectionDiagnostics.Create(typeof(UISettings).Assembly) : null', 'ProjectionDiagnostics.Create(typeof(UISettings).Assembly)', 'trace-only-before-registration'],
    ['adapter', 'finally { projectionDiagnostics?.Dispose(); }', 'finally { }', 'scoped-cleanup'],
    ['adapter', 'catch { projectionDiagnostics?.Dispose(); throw; }', 'catch { throw; }', 'scoped-cleanup'],
    ['observer', 'FirstChanceException -= FirstChance;', 'FirstChanceException += FirstChance;', 'scoped-cleanup'],
    ['observer', 'error.TargetSite?.Module.Assembly', 'error.Source', 'guard-and-closed-throwing-site'],
    ['observer', 'finally { insideObserver = false; }', 'finally { }', 'guard-and-closed-throwing-site'],
    ['observer', 'entry.Order > before.Last.Order', 'entry.Order < before.Last.Order', 'newest-bounded-and-incomplete'],
    ['observer', 'var error = args.Exception;', 'File.OpenRead("private"); var error = args.Exception;', 'no-callback-effects'],
  ]) {
    const changed = { observer, adapter, [part]: (part === 'observer' ? observer : adapter).replace(from, to) };
    assert(projectionViolations(changed.observer, changed.adapter).includes(wanted), wanted);
  }
  const reader = read('./verify-input.ps1');
  assert(reader.includes('projection = $projectionSummary'));
  assert(reader.includes('$sequence -gt $projectionSequence'));
  assert(reader.includes("'hresult' { if (($value -is [int] -or $value -is [long])"));
  assert(reader.includes("& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'projection-diagnostics.test.ps1')"));
  const controls = read('./projection-diagnostics-controls.cs');
  for (const name of ['caught-throw-before-handler', 'newest-overflow-not-first-n', 'unknown-type-null',
    'recursive-incomplete', 'unsubscribe', 'idempotent-unsubscribe', 'loaded-identity']) assert(controls.includes(name));
});

test('canonical animation property event replaces WM-only transport on supported Windows', () => {
  const adapter = read('../../examples/windows/SystemPreferenceNotifications.cs');
  const page = read('../../examples/windows/PressPage.xaml.cs');
  assert(adapter.includes('settings.AnimationsEnabledChanged += AnimationsChanged;'));
  assert(adapter.includes('UISettingsAnimationsEnabledChangedEventArgs args'));
  assert(adapter.includes('notify(this);'));
  assert(!/DllImport|SetWindowSubclass|WindowMessage|GCHandle/.test(adapter));
  assert(page.includes('new SystemPreferenceNotifications(settings, DispatcherQueue, SystemPreferenceChanged, NotificationFailed, trace is not null)'));
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
    ['one owned-settings notification source', !page.includes('new SystemPreferenceNotifications(settings, DispatcherQueue, SystemPreferenceChanged, NotificationFailed, trace is not null)')
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
    ['revoke before native removal and retain failed transport', !/CheckAccess\(\);\s*bool remove;\s*lock \(gate\)\s*\{\s*retired = true;\s*remove = subscribed && !removalAttempted;/.test(dispose)
      || !/settings\.AnimationsEnabledChanged -= AnimationsChanged;\s*lock \(gate\) subscribed = false;/.test(dispose)
      || !dispose.includes('catch (Exception error) { CaptureFailure(error); }') || !dispose.includes('ThrowIfFaulted();')],
    ['one revoke attempt cannot accept projected retry as physical detach', !source.includes('private bool removalAttempted;')
      || !dispose.includes('remove = subscribed && !removalAttempted;')
      || !dispose.includes('if (remove) removalAttempted = true;')],
    ['delivery shares retirement lock and carries exact identity without UI getter', !/lock \(gate\)[^]*?if \(retired \|\| !subscribed\) return;/.test(callback)
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
      ['CheckAccess();', '', 'owner UI admission before native registration'],
      ['lock (gate) return subscribed;', 'return !retired;', 'actual transport and active effect are separate synchronized states'],
      ['lock (gate) return subscribed && !retired;', 'lock (gate) return subscribed;', 'actual transport and active effect are separate synchronized states'],
      ['retired = true;\n            remove = subscribed', 'retired = false;\n            remove = subscribed', 'revoke before native removal and retain failed transport'],
      ['remove = subscribed && !removalAttempted;', 'remove = subscribed;', 'one revoke attempt cannot accept projected retry as physical detach'],
      ['if (remove) removalAttempted = true;', '', 'one revoke attempt cannot accept projected retry as physical detach'],
      ['settings.AnimationsEnabledChanged -= AnimationsChanged;', 'IgnoreRemove();', 'single typed native event on owned UISettings'],
      ['if (retired || !subscribed) return;', 'if (false) return;', 'delivery shares retirement lock and carries exact identity without UI getter'],
      ['notify(this);', 'notify(null!);', 'delivery shares retirement lock and carries exact identity without UI getter'],
      ['if (failure is not null) return false;', '', 'first fault retired and retained under shared lock'],
      ['if (dispatcher.HasThreadAccess) reportFailure(this, error);', 'reportFailure(this, error);', 'reporting uses owner UI queue and preserves secondary failure'],
      ['lock (gate) reportingFailure ??= ExceptionDispatchInfo.Capture(error);', 'reportingFailure = null;', 'reporting uses owner UI queue and preserves secondary failure'],
    ]) assert(adapterViolations(healthy.replace(before, after)).includes(violation), violation);
  }
});

test('CsWinRT failed native revoke makes a later projected remove a no-op, not a detach receipt', () => {
  // Source-контрпример EventSource<T>.Unsubscribe, pinned CsWinRT ff5227a4:
  // targetDelegate удаляется до native RemoveHandler/ThrowExceptionForHR.
  // Это модель порядка projection, не исполнение C#/WinRT.
  let targetDelegate = true, nativeHandler = true, nativeCalls = 0;
  const projectedRemove = () => {
    if (!targetDelegate) return;
    targetDelegate = false;
    nativeCalls++;
    throw new Error('native-remove-failed');
  };
  assert.throws(projectedRemove, /native-remove-failed/);
  assert.doesNotThrow(projectedRemove);
  assert.deepEqual([targetDelegate, nativeHandler, nativeCalls], [false, true, 1]);
  assert(adapterViolations(read('../../examples/windows/SystemPreferenceNotifications.cs'))
    .every(violation => violation !== 'one revoke attempt cannot accept projected retry as physical detach'));
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

test('independent lifetime control retains unknown revoke after repeated disposal and permits healthy detach', () => {
  // Модель ожидаемого контракта; это не исполнение C#/WinRT adapter.
  const current = { subscribed: true, retired: false, removalAttempted: false, fault: null };
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
    if (subscription.subscribed && !subscription.removalAttempted) {
      subscription.removalAttempted = true;
      removals++;
      if (succeeds) subscription.subscribed = false;
      else subscription.fault ??= 'unsubscribe-primary';
    }
  };
  receive(current);
  dispose(current, false);
  assert.deepEqual(current, { subscribed: true, retired: true, removalAttempted: true, fault: 'unsubscribe-primary' });
  receive(current);
  queue.forEach(apply);
  assert.equal(changes, 0);
  dispose(current, true);
  dispose(current, true);
  assert.deepEqual([current.subscribed, current.retired, current.fault, removals], [true, true, 'unsubscribe-primary', 1]);
  assert(current.subscribed, 'unknown revoke блокирует забывание transport и новый Attach');
  // Независимый healthy owner — не разрешение Attach поверх неизвестного current.
  active = { subscribed: true, retired: false, removalAttempted: false, fault: null };
  queue.forEach(apply);
  assert.equal(changes, 0, 'старый queued callback не принимает новую subscription');
  receive(active);
  apply(queue.at(-1));
  assert.equal(changes, 1, 'здоровый native callback допускает полезную реакцию');
  const unrelated = { subscribed: true, retired: false, fault: null };
  receive(unrelated);
  apply(queue.at(-1));
  assert.equal(changes, 1, 'чужая subscription не получает эффект current page');
  dispose(active, true);
  dispose(active, true);
  assert.deepEqual([active.subscribed, active.retired, active.fault, removals], [false, true, null, 2]);
});

function entrySnapshotViolations(source, page) {
  const callback = source.slice(source.indexOf('private void AnimationsChanged'), source.indexOf('private bool SaveFailure'));
  const guard = callback.indexOf('if (retired || !subscribed) return;');
  const raw = callback.indexOf('rawEntries++');
  const rejected = callback.indexOf('lastEntry = EntryOutcome.Rejected;');
  const admitted = callback.indexOf('admittedEntries++');
  const outcome = callback.indexOf('lastEntry = EntryOutcome.Admitted;');
  const helper = page.match(/private SystemPreferenceNotifications\.DiagnosticSnapshot\? ReadSubscriptionDiagnosticsForTrace\(SystemPreferenceNotifications\? subscription\)\s*\{([^]*?)\n    \}/)?.[1] ?? '';
  return [
    ['closed immutable snapshot', !source.includes('internal readonly record struct DiagnosticSnapshot(')
      || !source.includes('internal enum EntryOutcome { None, Admitted, Rejected }')],
    ['raw before admission; rejected cannot count as admitted', !(raw >= 0 && raw < rejected && rejected < guard && guard < admitted && admitted < outcome && outcome < callback.indexOf('try { notify(this); }'))],
    ['diagnostic-only bounded counters', !/if \(captureDiagnostics\)\s*\{\s*if \(rawEntries <= MaximumSafeInteger\) rawEntries\+\+;/.test(callback)
      || !/if \(captureDiagnostics\)\s*\{\s*if \(admittedEntries <= MaximumSafeInteger\) admittedEntries\+\+;/.test(callback)
      || !source.includes('bool captureDiagnostics = false') || !source.includes('private readonly long registration;')],
    ['captured subscription before await', !page.includes('var subscriptionForTrace = trace is not null ? notifications : null;')
      || page.indexOf('var subscriptionForTrace =') > page.indexOf('await pending')
      || !page.includes('subscriptionDiagnostics = ReadSubscriptionDiagnosticsForTrace(subscriptionForTrace)')
      || !page.includes('ReferenceEquals(notifications, subscriptionForTrace)')],
    ['read-only owner snapshot of captured adapter', !/if \(!DispatcherQueue.HasThreadAccess \|\| subscription is null\) return null;\s*return subscription.ReadDiagnostics\(\);/.test(helper)
      || !helper.includes('catch { return null; }') || /Update\(|Flush\(|ThrowIfFaulted\(/.test(helper)],
  ].filter(([, failed]) => failed).map(([name]) => name);
}

test('adapter diagnostic snapshot distinguishes raw entry before admission and retains subscription identity', () => {
  const source = read('../../examples/windows/SystemPreferenceNotifications.cs');
  const page = read('../../examples/windows/PressPage.xaml.cs');
  assert.deepEqual(entrySnapshotViolations(source, page), []);
  for (const [before, after, expected] of [
    ['rawEntries++', 'admittedEntries++', 'raw before admission; rejected cannot count as admitted'],
    ['lastEntry = EntryOutcome.Rejected;', 'lastEntry = EntryOutcome.Admitted;', 'raw before admission; rejected cannot count as admitted'],
    ['if (retired || !subscribed) return;', '', 'raw before admission; rejected cannot count as admitted'],
    ['if (rawEntries <= MaximumSafeInteger)', 'if (true)', 'diagnostic-only bounded counters'],
    ['readonly record struct DiagnosticSnapshot', 'record struct DiagnosticSnapshot', 'closed immutable snapshot'],
  ]) assert(entrySnapshotViolations(source.replace(before, after), page).includes(expected), expected);
  for (const [before, after, expected] of [
    ['ReadSubscriptionDiagnosticsForTrace(subscriptionForTrace)', 'ReadSubscriptionDiagnosticsForTrace(notifications)', 'captured subscription before await'],
    ['return subscription.ReadDiagnostics();', 'return notifications.ReadDiagnostics();', 'read-only owner snapshot of captured adapter'],
    ['return subscription.ReadDiagnostics();', 'Update("systemPreference"); return subscription.ReadDiagnostics();', 'read-only owner snapshot of captured adapter'],
  ]) assert(entrySnapshotViolations(source, page.replace(before, after)).includes(expected), expected);
});

test('prepared actual projection controls retain original columns and closed nullable entry tuple', () => {
  const controls = read('./cleanup.test.ps1');
  const section = controls.slice(controls.indexOf('$subscriptionCases ='), controls.indexOf('$received ='));
  for (const name of ['no-entry', 'admitted', 'rejected-retired', 'old-subscription', 'malformed', 'missing-fields', 'missing-snapshot'])
    assert(section.includes(`name = '${name}'`), name);
  for (const expected of ['$summary.rows[0][0..12]', '$summary.rows[0][13]', '$summary.rows[0].Count -ne 14',
    '$text.Length -gt 1800', '$summary.rows.Count -gt 12', '$summary.omitted -ne (100 - $summary.rows.Count)',
    'phase-subscription-bounded-control', 'Get-InputPhaseSummary -Name']) assert(section.includes(expected), expected);
});

test('independent entry model separates retired raw callback from healthy admission without changing new registration', () => {
  // Модель контракта, не исполнение C#/WinRT и не native receipt.
  const create = registration => ({ registration, raw: 0, admitted: 0, last: 'None', attached: true, active: true });
  const enter = subscription => {
    subscription.raw++;
    subscription.last = 'Rejected';
    if (!subscription.attached || !subscription.active) return false;
    subscription.admitted++;
    subscription.last = 'Admitted';
    return true;
  };
  const old = create(7);
  const captured = old;
  assert.equal(enter(old), true);
  old.active = false;
  old.attached = false;
  const current = create(8);
  assert.equal(enter(old), false);
  assert.deepEqual([captured.registration, captured.raw, captured.admitted, captured.last, captured === current], [7, 2, 1, 'Rejected', false]);
  assert.deepEqual([current.registration, current.raw, current.admitted, current.last], [8, 0, 0, 'None']);
  assert.equal(enter(current), true);
  assert.deepEqual([current.raw, current.admitted, current.last], [1, 1, 'Admitted']);
});
