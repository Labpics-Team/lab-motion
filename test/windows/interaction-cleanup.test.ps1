# Исполняет настоящие cleanup-методы потребителя с отказными ресурсами, без WinUI runtime.
$ErrorActionPreference = 'Stop'
$source = Get-Content (Join-Path $PSScriptRoot '../../examples/windows/InteractionProbe.xaml.cs') -Raw
function Read-Method([string]$Start, [string]$End) {
    $first = $source.IndexOf($Start, [StringComparison]::Ordinal)
    $last = $source.IndexOf($End, $first, [StringComparison]::Ordinal)
    if ($first -lt 0 -or $last -le $first) { throw "Не найден настоящий метод: $Start" }
    return $source.Substring($first, $last - $first)
}
$detach = Read-Method '    private void Detach(' '    // Callback значения'
$exit = Read-Method '        private void OnProcessExit(' '        public void Dispose()'
$dispose = $source.Substring($source.IndexOf('        public void Dispose()', [StringComparison]::Ordinal))
# Последние две скобки закрывают trace и страницу, а не извлекаемый метод.
$dispose = $dispose.Substring(0, $dispose.LastIndexOf("`n    }", [StringComparison]::Ordinal))
$code = @'
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.ExceptionServices;
using System.Threading.Tasks;
namespace InteractionCleanupControls {
public sealed class RoutedEventArgs : EventArgs {}
public delegate void PointerEventHandler();
public sealed class MotionObservation {}
public sealed class Faults {
    public readonly List<string> Calls = new();
    public readonly Dictionary<string, Exception> Errors = new();
    public void Invoke(string name) { Calls.Add(name); if (Errors.TryGetValue(name, out var error)) throw error; }
}
public sealed class Stage(Faults faults) {
    public void RemoveHandler(string name, PointerEventHandler handler) => faults.Invoke(name);
}
public static class ElementCompositionPreview {
    public static Faults Faults = null!;
    public static void SetElementChildVisual(Stage stage, object? value) => Faults.Invoke("visual");
}
public sealed class Motion(Faults faults) {
    public event Action<MotionObservation> Observed { add {} remove { faults.Invoke("observer"); } }
    public void Dispose() => faults.Invoke("motion");
}
public sealed class Resource(Faults faults, string name) {
    public void Dispose() => faults.Invoke(name);
}
public sealed class Trace(Faults faults) {
    public void Add(string kind, object data) => faults.Invoke("trace-add");
    public void Flush() => faults.Invoke("trace-flush");
    public void Dispose() => faults.Invoke("trace-dispose");
}
public sealed class Probe {
    private bool detached;
    private bool ready = true;
    private readonly TaskCompletionSource<MotionObservation> initialPosition = new();
    private readonly List<(string routedEvent, PointerEventHandler handler)> inputHandlers = new();
    private readonly List<Resource> resources = new();
    private readonly Stage TouchStage;
    private readonly Motion motion;
    private readonly Trace trace;
    public Probe(Faults faults) {
        ElementCompositionPreview.Faults = faults;
        TouchStage = new(faults); motion = new(faults); trace = new(faults);
        foreach (var name in new[] { "handler0", "handler1", "handler2" }) inputHandlers.Add((name, () => {}));
        foreach (var name in new[] { "resource0", "resource1", "resource2" }) resources.Add(new(faults, name));
    }
    private void Observe(MotionObservation observation) {}
    public void Run() => Detach(this, new());
    public bool Retired => detached && !ready && initialPosition.Task.IsCanceled && inputHandlers.Count == 0 && resources.Count == 0;
__DETACH__
}
public sealed class TraceProbe {
    private readonly object gate = new();
    private bool disposed;
    public readonly Faults Faults = new();
    public TraceProbe() { AppDomain.CurrentDomain.ProcessExit += OnProcessExit; }
    private void Add(string kind, object data) => Faults.Invoke("add");
    private void Flush() => Faults.Invoke("flush");
    public void Exit() => OnProcessExit(this, EventArgs.Empty);
    public bool Retired => disposed;
__EXIT__
__DISPOSE__
}
public static class Controls {
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
    private static Exception? Capture(Action operation) { try { operation(); return null; } catch (Exception error) { return error; } }
    public static int Run() {
        var passed = 0;
        var order = new[] { "handler0", "handler1", "handler2", "visual", "observer", "motion", "resource2", "resource1", "resource0", "trace-add", "trace-flush", "trace-dispose" };
        // Каждый одиночный отказ и все отказы одновременно, включая здоровый исход.
        foreach (var failures in new[] { Array.Empty<string>() }.Concat(order.Select(name => new[] { name })).Append(order)) {
            var faults = new Faults();
            foreach (var name in failures) faults.Errors[name] = new InvalidOperationException(name);
            var probe = new Probe(faults);
            var error = Capture(probe.Run);
            Require(faults.Calls.SequenceEqual(order), "Пропущена или повторена cleanup-попытка");
            Require(probe.Retired, "Retirement или очистка ownership неполны");
            if (failures.Length == 0) Require(error is null, "Здоровый cleanup отказал");
            else {
                Require(ReferenceEquals(error, faults.Errors[failures[0]]), "Потеряна первая ошибка");
                Require(error!.StackTrace!.Contains(nameof(Faults.Invoke)), "Потерян исходный stack");
                if (failures.Length > 1) Require(((Exception[])error.Data["InteractionProbe.CleanupFailures"]!).SequenceEqual(failures.Skip(1).Select(name => faults.Errors[name])), "Потеряны вторичные ошибки");
            }
            Require(Capture(probe.Run) is null && faults.Calls.SequenceEqual(order), "Повторный Detach повторил эффект");
            Environment.ExitCode = 0;
            passed++;
        }
        foreach (var failures in new[] { Array.Empty<string>(), new[] { "flush" }, new[] { "add" }, new[] { "add", "flush" } }) {
            var trace = new TraceProbe();
            foreach (var name in failures) trace.Faults.Errors[name] = new InvalidOperationException(name);
            var error = Capture(trace.Exit);
            Require(trace.Retired && trace.Faults.Calls.SequenceEqual(new[] { "add", "flush" }), "Trace не завершил все попытки");
            Require(failures.Length == 0 ? error is null : ReferenceEquals(error, trace.Faults.Errors[failures[0]]), "Trace подменил первую ошибку");
            if (failures.Length > 1) Require(((Exception[])error!.Data["InteractionTrace.CleanupFailures"]!)[0] == trace.Faults.Errors["flush"], "Trace потерял вторичный отказ");
            Require(Capture(trace.Dispose) is null && trace.Faults.Calls.Count == 2, "Trace повторил Flush после retirement");
            passed++;
        }
        return passed;
    }
}
}
'@
$code = $code.Replace('__DETACH__', $detach).Replace('__EXIT__', $exit).Replace('__DISPOSE__', $dispose)
Add-Type -TypeDefinition $code -Language CSharp
$count = [InteractionCleanupControls.Controls]::Run()
if ($count -ne 18) { throw "Неполный состав interaction cleanup controls: $count" }
Write-Output "interaction cleanup: $count controls passed"
