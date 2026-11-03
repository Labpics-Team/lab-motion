using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace NativeWindow;

// Диагностика очереди собственного UI-потока: сообщения и маршрутизация не меняются.
internal sealed class PointerHistoryTrace : IDisposable
{
    private const int MaximumMessages = 512;
    private const int MaximumSamples = 4096;
    private readonly string path;
    private readonly HookProcedure callback;
    private readonly PointerInfo[] history = new PointerInfo[128];
    private readonly List<object> messages = new(MaximumMessages);
    private readonly List<object> samples = new(MaximumSamples);
    private readonly uint threadId = GetCurrentThreadId();
    private nint hook;
    private bool truncated;
    private bool disposed;
    private string? error;
    private uint? inputPointerId;

    public PointerHistoryTrace(string path)
    {
        this.path = path;
        // ABI фиксирован для win-x64, на котором собирается этот потребитель.
        if (Marshal.SizeOf<PointerInfo>() != 96 || Marshal.SizeOf<Message>() != 48)
            throw new InvalidOperationException("Не совпала x64-разметка Win32 pointer/message.");
        using (new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { }
        callback = Observe;
        hook = SetWindowsHookEx(3, callback, 0, threadId);
        if (hook == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        Write("attached");
    }

    public void Identify(uint pointerId) => inputPointerId = pointerId;

    private nint Observe(int code, nuint wParam, nint lParam)
    {
        // PM_NOREMOVE может возвращать тот же MSG многократно; читаем при извлечении.
        if (code == 0 && wParam == 1 && !disposed)
        {
            try
            {
                var message = Marshal.PtrToStructure<Message>(lParam);
                if (message.Kind is 0x0245 or 0x0246 or 0x0247 or 0x0249 or 0x024A or 0x024C
                    or 0x0251 or 0x0252 or 0x0253)
                    Capture(message);
            }
            // Исключение диагностического callback не пересекает native-границу.
            catch (Exception exception) { error ??= exception.ToString(); }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    private void Capture(Message message)
    {
        if (messages.Count == MaximumMessages) { truncated = true; return; }
        var observedQpc = Stopwatch.GetTimestamp();
        var pointerId = (uint)(message.WParam & 0xffff);
        uint available = (uint)history.Length;
        var success = GetPointerInfoHistory(pointerId, ref available, history);
        var win32Error = success ? 0 : Marshal.GetLastWin32Error();
        var messageIndex = messages.Count;
        if (success)
        {
            if (available > history.Length) truncated = true;
            for (var index = 0; index < Math.Min(available, history.Length); index++)
            {
                if (samples.Count == MaximumSamples) { truncated = true; break; }
                var sample = history[index];
                samples.Add(new
                {
                    messageIndex, historyIndex = index, sample.PointerType, sample.PointerId, sample.FrameId,
                    sample.PointerFlags, hwndTarget = sample.HwndTarget.ToInt64(),
                    raw = new { x = sample.PixelRaw.X, y = sample.PixelRaw.Y },
                    predicted = new { x = sample.Pixel.X, y = sample.Pixel.Y },
                    sample.Time, sample.PerformanceCount, sample.HistoryCount,
                });
            }
        }
        messages.Add(new
        {
            messageIndex, kind = message.Kind, hwnd = message.Hwnd.ToInt64(), pointerId,
            messageTime = message.Time, observedQpc, completedQpc = Stopwatch.GetTimestamp(),
            success, win32Error, available,
        });
    }

    public void Write(string stage)
    {
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            schema = 1, stage, observer = "WH_GETMESSAGE/current-thread/PM_REMOVE", threadId,
            stopwatchFrequency = Stopwatch.Frequency, inputPointerId, truncated, error,
            pointerInfoSize = Marshal.SizeOf<PointerInfo>(), messageSize = Marshal.SizeOf<Message>(),
            messages, samples,
        }, new JsonSerializerOptions { WriteIndented = true }));
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (!UnhookWindowsHookEx(hook)) error ??= new Win32Exception(Marshal.GetLastWin32Error()).ToString();
        hook = 0;
        Write("detached");
        GC.KeepAlive(callback);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public nint Hwnd;
        public uint Kind;
        public nuint WParam;
        public nint LParam;
        public uint Time;
        public Point Position;
        public uint Private;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PointerInfo
    {
        public uint PointerType, PointerId, FrameId, PointerFlags;
        public nint SourceDevice, HwndTarget;
        public Point Pixel, Himetric, PixelRaw, HimetricRaw;
        public uint Time, HistoryCount;
        public int InputData;
        public uint KeyStates;
        public ulong PerformanceCount;
        public uint ButtonChangeType;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate nint HookProcedure(int code, nuint wParam, nint lParam);
    [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
    private static extern nint SetWindowsHookEx(int id, HookProcedure callback, nint module, uint threadId);
    [DllImport("user32.dll")]
    private static extern nint CallNextHookEx(nint hook, int code, nuint wParam, nint lParam);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetPointerInfoHistory(uint pointerId, ref uint count, [Out] PointerInfo[] history);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
}
