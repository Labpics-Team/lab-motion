using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Windows.UI.ViewManagement;

namespace NativeWindow;

// Второй receiver только для trace: он не вызывает product callback и не применяет policy.
internal sealed class NativePreferenceDiagnostics : IDisposable
{
    internal sealed record Snapshot(string State, bool SameSource, bool ControlPassed,
        int SourceHResult, int DelegateHResult, int MarshalHResult, int ControlHResult,
        long? ControlCount, long? ControlQpc, long? QpcFrequency, int? AddHResult,
        long? Count, long? LastEntryQpc, bool Attached, bool Active, bool Faulted, int? RemoveHResult);
    private const long MaximumSafeInteger = 9007199254740991;
    private readonly object gate = new();
    private ReceiverHandle? handle;
    private Snapshot last;
    private bool disposed;

    private NativePreferenceDiagnostics(Snapshot snapshot) { last = snapshot; }

    internal static NativePreferenceDiagnostics Create(UISettings settings)
    {
        if (IntPtr.Size != 8) return new NativePreferenceDiagnostics(Unavailable(unchecked((int)0x8007000b)));
        NativePreferenceDiagnostics result;
        ReceiverHandle? owner = null;
        IntPtr pointer = IntPtr.Zero;
        try
        {
            // Borrowed только в synchronous Create; native QI удерживает этот же source.
            var native = ((WinRT.IWinRTObject)settings).NativeObject;
            var hr = CreateNative(native.ThisPtr, out pointer, out var captured);
            if (pointer != IntPtr.Zero) { owner = new ReceiverHandle(pointer); pointer = IntPtr.Zero; }
            result = new NativePreferenceDiagnostics(Project(captured));
            result.handle = owner;
            owner = null;
            if (hr < 0) result.last = result.last with { State = "Faulted", Faulted = true };
        }
        catch (Exception error)
        {
            result = new NativePreferenceDiagnostics(Unavailable(error.HResult));
        }
        finally
        {
            try { owner?.Dispose(); if (pointer != IntPtr.Zero) ReleaseNative(pointer); }
            finally { GC.KeepAlive(settings); }
        }
        return result;
    }

    internal Snapshot ReadSnapshot()
    {
        lock (gate)
        {
            if (handle is not null && !disposed)
            {
                try
                {
                    var hr = ReadNative(handle, out var captured);
                    if (hr >= 0) last = Project(captured);
                    else last = last with { State = "Faulted", Faulted = true };
                }
                catch (Exception error) { last = last with { State = "Unavailable", Faulted = true, SourceHResult = error.HResult }; }
            }
            return last;
        }
    }

    public void Dispose()
    {
        Exception? cleanupFailure = null;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (handle is null) return;
            try
            {
                var hr = CloseNative(handle, out var captured);
                last = Project(captured);
                if (hr < 0)
                {
                    last = last with { State = "Faulted", Faulted = true };
                    cleanupFailure = new COMException("Native diagnostic receiver не подтвердил remove.", hr);
                }
            }
            catch (Exception error)
            {
                last = last with { State = "Unavailable", Active = false, Faulted = true, RemoveHResult = error.HResult };
                cleanupFailure = error;
            }
            finally
            {
                handle.Dispose();
                if (handle.ReleaseFailure is int hr)
                {
                    last = last with { State = "Unavailable", Active = false, Faulted = true };
                    var release = new COMException("Native diagnostic owner release не подтверждён.", hr);
                    cleanupFailure = cleanupFailure is null ? release : new AggregateException(cleanupFailure, release);
                }
                handle = null;
            }
        }
        if (cleanupFailure is not null) throw cleanupFailure;
    }

    private static long? Safe(long value, bool positive = false)
        => value >= (positive ? 1 : 0) && value <= MaximumSafeInteger ? value : null;

    private static Snapshot Project(NativeSnapshot value)
    {
        bool Flag(uint bit) => (value.Flags & bit) != 0;
        if (value.Schema != 1) return Unavailable(unchecked((int)0x80004005));
        return new Snapshot(Flag(32) ? "Faulted" : "Ready", Flag(1), Flag(2),
            value.SourceHResult, value.DelegateHResult, value.MarshalHResult, value.ControlHResult,
            Safe(value.ControlCount), Safe(value.ControlQpc, true), Safe(value.Frequency, true),
            Flag(4) ? value.AddHResult : null, Safe(value.Count), Safe(value.LastQpc, true),
            Flag(8), Flag(16), Flag(32), Flag(64) ? value.RemoveHResult : null);
    }

    private static Snapshot Unavailable(int hr) => new("Unavailable", false, false, hr, hr, hr, hr,
        null, null, null, null, null, null, false, false, true, null);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSnapshot
    {
        public uint Schema, Flags;
        public int SourceHResult, DelegateHResult, MarshalHResult, ControlHResult, AddHResult, RemoveHResult;
        public long ControlCount, ControlQpc, Count, LastQpc, Frequency;
    }

    private sealed class ReceiverHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        internal int? ReleaseFailure { get; private set; }
        internal ReceiverHandle(IntPtr value) : base(true) { SetHandle(value); }
        protected override bool ReleaseHandle()
        {
            try { ReleaseNative(handle); return true; }
            catch (Exception error) { ReleaseFailure = error.HResult; return false; }
        }
    }

    // CLR держит DLL до конца процесса: после failed remove ещё возможен callback.
    private const string Library = "LabMotion.PreferenceDiagnostics.dll";
    [DllImport(Library, EntryPoint = "PreferenceDiagnosticsCreate", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern int CreateNative(IntPtr borrowed, out IntPtr handle, out NativeSnapshot snapshot);
    [DllImport(Library, EntryPoint = "PreferenceDiagnosticsRead", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern int ReadNative(ReceiverHandle handle, out NativeSnapshot snapshot);
    [DllImport(Library, EntryPoint = "PreferenceDiagnosticsClose", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern int CloseNative(ReceiverHandle handle, out NativeSnapshot snapshot);
    [DllImport(Library, EntryPoint = "PreferenceDiagnosticsRelease", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern void ReleaseNative(IntPtr handle);
}
