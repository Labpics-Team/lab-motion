using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Microsoft.UI.Xaml;

namespace NativeWindow;

// Пассивный HWND recorder для trace; не источник policy и не замена UISettings.
internal sealed class WindowPreferenceDiagnostics : IDisposable
{
    internal sealed record Snapshot(string State, bool? OwnerMatched, bool? SameSession, bool? SameDesktop,
        int OwnerHResult, int ContextHResult, int? ControlHResult, int? AddHResult, int? RemoveHResult,
        bool ControlPassed, long? ControlCount, long? ControlQpc, long? RawCount, long? ActionCount,
        long? LastRawQpc, long? LastActionQpc, long? QpcFrequency, long? ForwardCount,
        bool Attached, bool Active, bool Faulted, bool Destroyed);
    private const long MaximumSafeInteger = 9007199254740991;
    private readonly object gate = new();
    private ReceiverHandle? handle;
    private Snapshot last;
    private bool disposed;
    private WindowPreferenceDiagnostics(Snapshot snapshot) { last = snapshot; }

    internal static WindowPreferenceDiagnostics Create(Window window)
    {
        ReceiverHandle? owner = null;
        IntPtr pointer = IntPtr.Zero;
        WindowPreferenceDiagnostics result;
        try
        {
            if (IntPtr.Size != 8 ||
                !uint.TryParse(Environment.GetEnvironmentVariable("LAB_MOTION_SETTER_PID"), NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid == 0 ||
                !uint.TryParse(Environment.GetEnvironmentVariable("LAB_MOTION_SETTER_TID"), NumberStyles.None, CultureInfo.InvariantCulture, out var tid) || tid == 0)
                return new WindowPreferenceDiagnostics(Unavailable(unchecked((int)0x80070057)));
            var station = Environment.GetEnvironmentVariable("LAB_MOTION_SETTER_STATION");
            if (string.IsNullOrEmpty(station) || station.Length > 255 || station.Contains('\0'))
                return new WindowPreferenceDiagnostics(Unavailable(unchecked((int)0x80070057)));
            var hr = CreateNative(WinRT.Interop.WindowNative.GetWindowHandle(window), pid, tid, station, out pointer, out var captured);
            if (pointer != IntPtr.Zero) { owner = new ReceiverHandle(pointer); pointer = IntPtr.Zero; }
            result = new WindowPreferenceDiagnostics(Project(captured)) { handle = owner };
            owner = null;
            if (hr < 0) result.last = result.last with { State = "Faulted", Faulted = true };
        }
        catch (Exception error) { result = new WindowPreferenceDiagnostics(Unavailable(error.HResult)); }
        finally
        {
            try { owner?.Dispose(); if (pointer != IntPtr.Zero) ReleaseNative(pointer); }
            finally { GC.KeepAlive(window); }
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
                    last = hr >= 0 ? Project(captured) : last with { State = "Faulted", Faulted = true };
                }
                catch (Exception error) { last = last with { State = "Unavailable", Faulted = true, ContextHResult = error.HResult }; }
            }
            return last;
        }
    }

    public void Dispose()
    {
        Exception? failure = null;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (handle is null) return;
            try
            {
                var hr = CloseNative(handle, out var captured);
                last = Project(captured);
                if (hr < 0) failure = new COMException("HWND diagnostic remove не подтверждён.", hr);
            }
            catch (Exception error)
            {
                last = last with { State = "Unavailable", Active = false, Faulted = true, RemoveHResult = error.HResult };
                failure = error;
            }
            finally
            {
                handle.Dispose();
                if (handle.ReleaseFailure is int hr)
                {
                    last = last with { State = "Unavailable", Active = false, Faulted = true };
                    var release = new COMException("HWND diagnostic owner release не подтверждён.", hr);
                    failure = failure is null ? release : new AggregateException(failure, release);
                }
                handle = null;
            }
        }
        if (failure is not null) throw failure;
    }

    private static long? Safe(long value, bool positive = false)
        => value >= (positive ? 1 : 0) && value <= MaximumSafeInteger ? value : null;
    private static Snapshot Project(NativeSnapshot value)
    {
        bool Flag(uint bit) => (value.Flags & bit) != 0;
        if (value.Schema != 1) return Unavailable(unchecked((int)0x80004005));
        return new Snapshot(Flag(512) ? "Faulted" : "Ready", value.OwnerHResult == unchecked((int)0x8000000a) ? null : Flag(1),
            Flag(2) ? Flag(4) : null, Flag(8) ? Flag(16) : null, value.OwnerHResult, value.ContextHResult,
            value.ControlHResult == unchecked((int)0x8000000a) ? null : value.ControlHResult,
            Flag(64) ? value.AddHResult : null, Flag(1024) ? value.RemoveHResult : null, Flag(32),
            Safe(value.ControlCount), Safe(value.ControlQpc, true), Safe(value.RawCount), Safe(value.ActionCount),
            Safe(value.LastRawQpc, true), Safe(value.LastActionQpc, true), Safe(value.Frequency, true), Safe(value.ForwardCount),
            Flag(128), Flag(256), Flag(512), Flag(2048));
    }
    private static Snapshot Unavailable(int hr) => new("Unavailable", null, null, null, hr, hr, null, null, null,
        false, null, null, null, null, null, null, null, null, false, false, true, false);
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSnapshot
    {
        public uint Schema, Flags;
        public int OwnerHResult, ContextHResult, ControlHResult, AddHResult, RemoveHResult;
        public uint Reserved;
        public long ControlCount, ControlQpc, RawCount, ActionCount, LastRawQpc, LastActionQpc, Frequency, ForwardCount;
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
    private const string Library = "LabMotion.PreferenceDiagnostics.dll";
    [DllImport(Library, EntryPoint = "WindowPreferenceDiagnosticsCreate", ExactSpelling = true, CharSet = CharSet.Unicode)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern int CreateNative(IntPtr window, uint pid, uint tid, string station, out IntPtr handle, out NativeSnapshot snapshot);
    [DllImport(Library, EntryPoint = "WindowPreferenceDiagnosticsRead", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern int ReadNative(ReceiverHandle handle, out NativeSnapshot snapshot);
    [DllImport(Library, EntryPoint = "WindowPreferenceDiagnosticsClose", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern int CloseNative(ReceiverHandle handle, out NativeSnapshot snapshot);
    [DllImport(Library, EntryPoint = "WindowPreferenceDiagnosticsRelease", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.AssemblyDirectory | DllImportSearchPath.SafeDirectories)]
    private static extern void ReleaseNative(IntPtr handle);
}
