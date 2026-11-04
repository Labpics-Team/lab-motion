using Microsoft.UI.Xaml;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;

namespace NativeWindow;

// Единственный источник системных уведомлений собственного окна; политику preference не выбирает.
internal sealed class SystemPreferenceNotifications : IDisposable
{
    private const uint SettingChange = 0x001A;
    private const uint NonClientDestroy = 0x0082;
    private readonly uint ownerThread;
    private readonly SubclassProcedure procedure;
    private readonly Action<Exception> reportFailure;
    private Action? notify;
    private nint handle;
    private GCHandle keepAlive;
    private bool retired;
    private ExceptionDispatchInfo? failure;
    private ExceptionDispatchInfo? reportingFailure;

    internal SystemPreferenceNotifications(Window window, Action notify, Action<Exception> reportFailure)
    {
        if (!window.DispatcherQueue.HasThreadAccess)
            throw new InvalidOperationException("Подписка требует поток собственного окна.");
        ownerThread = GetCurrentThreadId();
        handle = WinRT.Interop.WindowNative.GetWindowHandle(window);
        if (handle == 0 || GetWindowThreadProcessId(handle, out var process) != ownerThread || process != (uint)Environment.ProcessId)
            throw new InvalidOperationException("Не подтверждено собственное окно для системной подписки.");
        this.notify = notify;
        this.reportFailure = reportFailure;
        procedure = WindowMessage;
        // Native API не удерживает managed delegate: root живёт до подтверждённого снятия/destroy.
        keepAlive = GCHandle.Alloc(this);
        try
        {
            if (!SetWindowSubclass(handle, procedure, 1, 0))
                throw new InvalidOperationException("Не установлена подписка системной настройки.");
        }
        catch
        {
            handle = 0;
            keepAlive.Free();
            throw;
        }
    }

    internal bool IsAttached => handle != 0;

    internal void ThrowIfFaulted()
    {
        CheckAccess();
        if (failure is not null && reportingFailure is not null)
            throw new AggregateException(failure.SourceException, reportingFailure.SourceException);
        failure?.Throw();
    }

    public void Dispose()
    {
        CheckAccess();
        retired = true;
        notify = null;
        if (handle != 0)
        {
            try
            {
                if (RemoveWindowSubclass(handle, procedure, 1))
                {
                    handle = 0;
                    keepAlive.Free();
                }
                else CaptureFailure(new InvalidOperationException("Не снята подписка системной настройки."));
            }
            catch (Exception error) { CaptureFailure(error); }
        }
        // Даже после успешного снятия прежняя ошибка не превращается в успех cleanup.
        ThrowIfFaulted();
    }

    private nint WindowMessage(nint window, uint message, nuint wParam, nint lParam, nuint id, nuint reference)
    {
        var destroying = window == handle && message == NonClientDestroy;
        try
        {
            if (destroying)
            {
                retired = true;
                notify = null;
                // До forwarding отзываем адрес: поздний Dispose не тронет переиспользованный HWND.
                handle = 0;
                if (!RemoveWindowSubclass(window, procedure, 1))
                    CaptureFailure(new InvalidOperationException("Не снята подписка при уничтожении окна."));
            }
            else if (window == handle && id == 1 && !retired && message == SettingChange)
            {
                // Только доставка; getter и реакция остаются в прежней managed очереди.
                notify?.Invoke();
            }
        }
        catch (Exception error) { CaptureFailure(error); }

        try { return DefSubclassProc(window, message, wParam, lParam); }
        catch (Exception error)
        {
            CaptureFailure(error);
            return 0;
        }
        finally
        {
            if (destroying && keepAlive.IsAllocated) keepAlive.Free();
            GC.KeepAlive(this);
        }
    }

    private void CaptureFailure(Exception error)
    {
        retired = true;
        notify = null;
        if (failure is not null) return;
        failure = ExceptionDispatchInfo.Capture(error);
        try { reportFailure(error); }
        catch (Exception secondary) { reportingFailure = ExceptionDispatchInfo.Capture(secondary); }
    }

    private void CheckAccess()
    {
        if (GetCurrentThreadId() != ownerThread)
            throw new InvalidOperationException("Подписка принадлежит другому потоку окна.");
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate nint SubclassProcedure(nint window, uint message, nuint wParam, nint lParam, nuint id, nuint reference);

    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowSubclass(nint window, SubclassProcedure callback, nuint id, nuint reference);
    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RemoveWindowSubclass(nint window, SubclassProcedure callback, nuint id);
    [DllImport("comctl32.dll")]
    private static extern nint DefSubclassProc(nint window, uint message, nuint wParam, nint lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint window, out uint process);
}
