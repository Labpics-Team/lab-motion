#nullable enable
using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace NativeWindow;

// Настоящий AppDomain event; WinRT/Windows здесь не подменяются и не исполняются.
public static class ProjectionDiagnosticControls
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ThrowProjection() => throw new COMException("private-control-not-for-diagnostics", unchecked((int)0x80004002));
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void ThrowUnknown() => throw new ApplicationException("raw-name-stack-must-not-be-output");
    private static void Catch(Action action) { try { action(); } catch { } }
    private static void Require(bool value, string control)
    {
        if (!value) throw new InvalidOperationException("projection-control: " + control);
    }

    public static string Run()
    {
        using var observer = ProjectionDiagnostics.Create(typeof(ProjectionDiagnosticControls).Assembly);
        Require(observer is not null, "attached");
        var before = observer!.ReadSnapshot();
        Catch(ThrowProjection);
        var after = observer.ReadSnapshot();
        Require(after.Count > before.Count && after.LastProjection?.Type == "COM"
            && after.LastProjection.HResult == unchecked((int)0x80004002)
            && after.LastProjection.ThrowingOwner == "UISettings", "caught-throw-before-handler");
        Require(after.LastProjection.Qpc is > 0 && after.QpcFrequency is > 0, "qpc");
        var first = after.LastProjection.Order;
        for (var i = 0; i < 32; i++) Catch(ThrowProjection);
        var newest = observer.ReadSnapshot();
        Require(newest.LastProjection!.Order > first && newest.ProjectionCount >= 33 && newest.ProjectionOmitted >= 32,
            "newest-overflow-not-first-n");
        Catch(ThrowUnknown);
        Require(observer.ReadSnapshot().LastProjection?.Type is null, "unknown-type-null");
        // Thread-local guard контролируется перед реальным CLR throw, не вместо observer callback.
        var guard = typeof(ProjectionDiagnostics).GetField("insideObserver", BindingFlags.Static | BindingFlags.NonPublic)!;
        guard.SetValue(null, true);
        try { Catch(ThrowProjection); }
        finally { guard.SetValue(null, false); }
        var recursive = observer.ReadSnapshot();
        Require(recursive.Faulted && recursive.ReentrantSkipped > 0, "recursive-incomplete");
        observer.Dispose();
        var disposed = observer.ReadSnapshot();
        Catch(ThrowProjection);
        Require(!observer.ReadSnapshot().Active && observer.ReadSnapshot().Count == disposed.Count, "unsubscribe");
        observer.Dispose();
        Require(observer.ReadSnapshot().Count == disposed.Count, "idempotent-unsubscribe");
        // Не выводим assembly Location/Name; loaded type assembly — известный input этого control.
        Require(before.UISettingsAssembly.Version is not null && before.UISettingsAssembly.Mvid is not null
            && before.UISettingsAssembly.State is "Hashed" or "NoLocation", "loaded-identity");
        foreach (var property in typeof(ProjectionDiagnostics.ThrowRecord).GetProperties())
            Require(property.PropertyType != typeof(Exception) && property.PropertyType != typeof(Assembly), "closed-record");
        return "projection diagnostics: actual CLR first-chance/caught/identity/newest/unknown/recursion/unsubscribe controls PASS";
    }
}
