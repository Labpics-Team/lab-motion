using Microsoft.UI.Dispatching;
using System.Runtime.ExceptionServices;
using Windows.UI.ViewManagement;

namespace NativeWindow;

// Один native property event; getter и policy остаются у потребителя на UI-потоке.
internal sealed class SystemPreferenceNotifications : IDisposable
{
    private readonly object gate = new();
    private readonly UISettings settings;
    private readonly DispatcherQueue dispatcher;
    private readonly Action<SystemPreferenceNotifications> notify;
    private readonly Action<SystemPreferenceNotifications, Exception> reportFailure;
    private bool subscribed;
    private bool retired;
    private ExceptionDispatchInfo? failure;
    private ExceptionDispatchInfo? reportingFailure;

    internal SystemPreferenceNotifications(UISettings settings, DispatcherQueue dispatcher,
        Action<SystemPreferenceNotifications> notify, Action<SystemPreferenceNotifications, Exception> reportFailure)
    {
        this.settings = settings;
        this.dispatcher = dispatcher;
        this.notify = notify;
        this.reportFailure = reportFailure;
        CheckAccess();
        settings.AnimationsEnabledChanged += AnimationsChanged;
        lock (gate) subscribed = true;
    }

    // Отказ снятия не забывает транспорт; допуск к эффекту отзывается отдельно.
    internal bool IsAttached { get { lock (gate) return subscribed; } }
    internal bool IsActive { get { lock (gate) return subscribed && !retired; } }

    internal void ThrowIfFaulted()
    {
        CheckAccess();
        ExceptionDispatchInfo? primary;
        ExceptionDispatchInfo? secondary;
        lock (gate) { primary = failure; secondary = reportingFailure; }
        if (primary is not null && secondary is not null)
            throw new AggregateException(primary.SourceException, secondary.SourceException);
        primary?.Throw();
    }

    public void Dispose()
    {
        CheckAccess();
        bool remove;
        lock (gate) { retired = true; remove = subscribed; }
        if (remove)
        {
            try
            {
                // Снятие не держит gate: поздний callback увидит retired.
                settings.AnimationsEnabledChanged -= AnimationsChanged;
                lock (gate) subscribed = false;
            }
            catch (Exception error) { CaptureFailure(error); }
        }
        ThrowIfFaulted();
    }

    private void AnimationsChanged(UISettings sender, UISettingsAnimationsEnabledChangedEventArgs args)
    {
        Exception? deliveryFailure = null;
        lock (gate)
        {
            if (retired || !subscribed) return;
            // notify только ставит managed работу в очередь; передаётся именно этот subscription.
            try { notify(this); }
            catch (Exception error)
            {
                if (SaveFailure(error)) deliveryFailure = error;
            }
        }
        if (deliveryFailure is not null) ReportFailure(deliveryFailure);
    }

    private bool SaveFailure(Exception error)
    {
        lock (gate)
        {
            retired = true;
            if (failure is not null) return false;
            failure = ExceptionDispatchInfo.Capture(error);
            return true;
        }
    }

    private void CaptureFailure(Exception error)
    {
        if (SaveFailure(error)) ReportFailure(error);
    }

    private void ReportFailure(Exception error)
    {
        try
        {
            if (dispatcher.HasThreadAccess) reportFailure(this, error);
            else if (!dispatcher.TryEnqueue(() => ReportFailure(error)))
                SaveReportingFailure(new InvalidOperationException("Очередь отказала сообщению об ошибке системной подписки."));
        }
        catch (Exception secondary) { SaveReportingFailure(secondary); }
    }

    private void SaveReportingFailure(Exception error)
    {
        lock (gate) reportingFailure ??= ExceptionDispatchInfo.Capture(error);
    }

    private void CheckAccess()
    {
        if (!dispatcher.HasThreadAccess)
            throw new InvalidOperationException("Подписка принадлежит UI-потоку владельца.");
    }
}
