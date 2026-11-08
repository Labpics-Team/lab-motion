#nullable enable
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;

namespace NativeWindow;

// Временное наблюдение managed throw, не receipt ABI/event и не policy приложения.
internal sealed class ProjectionDiagnostics : IDisposable
{
    internal sealed record AssemblyIdentity(string State, string? Version, Guid? Mvid, string? Sha256);
    internal sealed record ThrowRecord(long Order, long? Qpc, string? Type, int HResult, string? ThrowingOwner);
    private sealed record State(long Count, long ProjectionCount, ThrowRecord? Last, ThrowRecord? LastProjection);
    internal sealed record Snapshot(AssemblyIdentity UISettingsAssembly, AssemblyIdentity WinRTRuntimeAssembly,
        long? StartedQpc, long? QpcFrequency, bool Active, bool Faulted, long ReentrantSkipped,
        long Count, long Omitted, long ProjectionCount, long ProjectionOmitted, ThrowRecord? Last, ThrowRecord? LastProjection);

    private const long MaximumSafeInteger = 9007199254740991;
    private const long MaximumAssemblyBytes = 128 * 1024 * 1024;
    [ThreadStatic] private static bool insideObserver;
    private readonly Assembly settingsAssembly;
    private readonly Assembly? runtimeAssembly;
    private readonly bool runtimeAmbiguous;
    private readonly Assembly applicationAssembly = typeof(ProjectionDiagnostics).Assembly;
    private readonly Assembly coreAssembly = typeof(Exception).Assembly;
    private readonly AssemblyIdentity settingsIdentity;
    private readonly AssemblyIdentity runtimeIdentity;
    private readonly long? startedQpc;
    private readonly long? frequency;
    private State state = new(0, 0, null, null);
    private long nextOrder;
    private long reentrantSkipped;
    private int active;
    private int attached;
    private int faulted;

    private ProjectionDiagnostics(Assembly settingsAssembly)
    {
        this.settingsAssembly = settingsAssembly;
        // Только уже загруженная assembly. Не загружаем ожидаемую версию из NuGet/пути.
        try
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (assembly.GetName().Name != "WinRT.Runtime") continue;
                if (runtimeAssembly is not null) { runtimeAssembly = null; runtimeAmbiguous = true; faulted = 1; break; }
                runtimeAssembly = assembly;
            }
        }
        catch { faulted = 1; }
        settingsIdentity = CaptureIdentity(settingsAssembly);
        runtimeIdentity = runtimeAmbiguous ? new("Ambiguous", null, null, null) : CaptureIdentity(runtimeAssembly);
        startedQpc = ReadQpc();
        frequency = Stopwatch.IsHighResolution ? SafeNumber(Stopwatch.Frequency) : null;
    }

    internal static ProjectionDiagnostics? Create(Assembly settingsAssembly)
    {
        ProjectionDiagnostics? observer = null;
        try
        {
            // Metadata и hash читаются до observer и native регистрации, вне callback.
            observer = new ProjectionDiagnostics(settingsAssembly);
            Volatile.Write(ref observer.active, 1);
            Volatile.Write(ref observer.attached, 1);
            AppDomain.CurrentDomain.FirstChanceException += observer.FirstChance;
            return observer;
        }
        catch
        {
            if (observer is not null) { Interlocked.Exchange(ref observer.faulted, 1); observer.Dispose(); }
            return observer;
        }
    }

    private AssemblyIdentity CaptureIdentity(Assembly? assembly)
    {
        if (assembly is null) return new("NotLoaded", null, null, null);
        string? version = null;
        Guid? mvid = null;
        try
        {
            var value = assembly.GetName().Version;
            if (value is not null && value.Major is >= 0 and <= 65535 && value.Minor is >= 0 and <= 65535
                && value.Build is >= 0 and <= 65535 && value.Revision is >= 0 and <= 65535)
                version = $"{value.Major}.{value.Minor}.{value.Build}.{value.Revision}";
            mvid = assembly.ManifestModule.ModuleVersionId;
            var location = assembly.Location;
            if (string.IsNullOrEmpty(location)) return new("NoLocation", version, mvid, null);
            using var file = File.OpenRead(location);
            if (file.Length > MaximumAssemblyBytes) return new("TooLarge", version, mvid, null);
            var hash = Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant();
            return new("Hashed", version, mvid, hash);
        }
        catch { Interlocked.Exchange(ref faulted, 1); return new("Unavailable", version, mvid, null); }
    }

    private void FirstChance(object? sender, FirstChanceExceptionEventArgs args)
    {
        if (Volatile.Read(ref active) == 0) return;
        if (insideObserver)
        {
            Interlocked.Exchange(ref faulted, 1);
            IncrementBounded(ref reentrantSkipped);
            return;
        }
        insideObserver = true;
        try
        {
            var order = IncrementBounded(ref nextOrder);
            var error = args.Exception;
            // TargetSite — throwing method, не stack/caller/event identity.
            var owner = error.TargetSite?.Module.Assembly;
            var ownerCategory = owner is null ? null : ReferenceEquals(owner, settingsAssembly) ? "UISettings"
                : ReferenceEquals(owner, runtimeAssembly) ? "WinRTRuntime"
                : ReferenceEquals(owner, applicationAssembly) ? "Application"
                : ReferenceEquals(owner, coreAssembly) ? "CoreRuntime" : "Other";
            var entry = new ThrowRecord(order, ReadQpc(), ClassifyType(error), error.HResult, ownerCategory);
            var projection = ownerCategory is "UISettings" or "WinRTRuntime";
            State before;
            State after;
            do
            {
                before = Volatile.Read(ref state);
                var count = BoundedNext(before.Count);
                var projectionCount = projection ? BoundedNext(before.ProjectionCount) : before.ProjectionCount;
                // Retained memory постоянна: newest overall и newest projection; старые явно omitted.
                var latest = before.Last is null || entry.Order > before.Last.Order ? entry : before.Last;
                var latestProjection = projection && (before.LastProjection is null || entry.Order > before.LastProjection.Order)
                    ? entry : before.LastProjection;
                after = new State(count, projectionCount, latest, latestProjection);
            } while (!ReferenceEquals(Interlocked.CompareExchange(ref state, after, before), before));
        }
        catch { Interlocked.Exchange(ref faulted, 1); }
        finally { insideObserver = false; }
    }

    private long BoundedNext(long value)
    {
        if (value < MaximumSafeInteger) return value + 1;
        Interlocked.Exchange(ref faulted, 1);
        return value;
    }

    private long IncrementBounded(ref long counter)
    {
        long before;
        long after;
        do { before = Volatile.Read(ref counter); after = BoundedNext(before); }
        while (Interlocked.CompareExchange(ref counter, after, before) != before);
        return after;
    }

    private static string? ClassifyType(Exception error)
    {
        var type = error.GetType();
        return type == typeof(COMException) ? "COM" : type == typeof(InvalidCastException) ? "InvalidCast"
            : type == typeof(ArgumentException) ? "Argument" : type == typeof(InvalidOperationException) ? "InvalidOperation"
            : type == typeof(TypeLoadException) ? "TypeLoad" : type == typeof(MissingMethodException) ? "MissingMethod"
            : type == typeof(FileNotFoundException) ? "FileNotFound" : type == typeof(NotSupportedException) ? "NotSupported"
            : null;
    }

    internal Snapshot ReadSnapshot()
    {
        var captured = Volatile.Read(ref state);
        return new(settingsIdentity, runtimeIdentity, startedQpc, frequency, Volatile.Read(ref active) != 0,
            Volatile.Read(ref faulted) != 0, Volatile.Read(ref reentrantSkipped), captured.Count,
            Math.Max(0, captured.Count - 1), captured.ProjectionCount, Math.Max(0, captured.ProjectionCount - 1),
            captured.Last, captured.LastProjection);
    }

    public void Dispose()
    {
        Volatile.Write(ref active, 0);
        if (Interlocked.Exchange(ref attached, 0) == 0) return;
        try { AppDomain.CurrentDomain.FirstChanceException -= FirstChance; }
        catch { Interlocked.Exchange(ref faulted, 1); }
    }

    private static long? SafeNumber(long value) => value > 0 && value <= MaximumSafeInteger ? value : null;
    private static long? ReadQpc()
    {
        try { return Stopwatch.IsHighResolution ? SafeNumber(Stopwatch.GetTimestamp()) : null; }
        catch { return null; }
    }
}
