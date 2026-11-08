using Microsoft.UI.Dispatching;
using System.Runtime.ExceptionServices;
using System.Diagnostics;
using System.Threading;
using System.Text.Json.Serialization;
using Windows.UI.ViewManagement;

namespace NativeWindow;

// Один native property event; getter и policy остаются у потребителя на UI-потоке.
internal sealed class SystemPreferenceNotifications : IDisposable
{
    internal readonly record struct DiagnosticSnapshot(long? Registration, long? RawEntries, long? AdmittedEntries,
        [property: JsonIgnore] EntryOutcome Outcome, long? LastEntryQpc, long? QpcFrequency, bool Attached, bool Active, bool Faulted)
    {
        public string LastEntry => Outcome.ToString();
    }
    internal enum EntryOutcome { None, Admitted, Rejected }
    private const long MaximumSafeInteger = 9007199254740991;
    private static long nextRegistration;
    private readonly object gate = new();
    private readonly UISettings settings;
    private readonly DispatcherQueue dispatcher;
    private readonly Action<SystemPreferenceNotifications> notify;
    private readonly Action<SystemPreferenceNotifications, Exception> reportFailure;
    private readonly bool captureDiagnostics;
    private readonly long registration;
    private long rawEntries;
    private long admittedEntries;
    private EntryOutcome lastEntry;
    private long? lastEntryQpc;
    private bool subscribed;
    private bool retired;
    private bool removalAttempted;
    private ExceptionDispatchInfo? failure;
    private ExceptionDispatchInfo? reportingFailure;

    internal SystemPreferenceNotifications(UISettings settings, DispatcherQueue dispatcher,
        Action<SystemPreferenceNotifications> notify, Action<SystemPreferenceNotifications, Exception> reportFailure,
        bool captureDiagnostics = false)
    {
        this.settings = settings;
        this.dispatcher = dispatcher;
        this.notify = notify;
        this.reportFailure = reportFailure;
        this.captureDiagnostics = captureDiagnostics;
        registration = captureDiagnostics ? Interlocked.Increment(ref nextRegistration) : 0;
        CheckAccess();
        settings.AnimationsEnabledChanged += AnimationsChanged;
        lock (gate) subscribed = true;
    }

    // Отказ снятия не забывает транспорт; допуск к эффекту отзывается отдельно.
    internal bool IsAttached { get { lock (gate) return subscribed; } }
    internal bool IsActive { get { lock (gate) return subscribed && !retired; } }

    internal DiagnosticSnapshot ReadDiagnostics()
    {
        CheckAccess();
        lock (gate)
        {
            return new DiagnosticSnapshot(SafeNumber(registration, positive: true), SafeNumber(rawEntries),
                SafeNumber(admittedEntries), lastEntry, lastEntryQpc, ReadQpcFrequency(),
                subscribed, subscribed && !retired, failure is not null || reportingFailure is not null);
        }
    }

    private static long? SafeNumber(long value, bool positive = false)
        => value >= (positive ? 1 : 0) && value <= MaximumSafeInteger ? value : null;

    private static long? ReadEntryQpc()
    {
        try { return Stopwatch.IsHighResolution ? SafeNumber(Stopwatch.GetTimestamp(), positive: true) : null; }
        catch { return null; }
    }

    private static long? ReadQpcFrequency()
        => Stopwatch.IsHighResolution ? SafeNumber(Stopwatch.Frequency, positive: true) : null;

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
        lock (gate)
        {
            retired = true;
            remove = subscribed && !removalAttempted;
            if (remove) removalAttempted = true;
        }
        if (remove)
        {
            try
            {
                // После отказа projection повторный -= может быть no-op, а не native receipt.
                // Единственная попытка не держит gate: поздний callback увидит retired.
                settings.AnimationsEnabledChanged -= AnimationsChanged;
                lock (gate) subscribed = false;
            }
            catch (Exception error) { CaptureFailure(error); }
        }
        ThrowIfFaulted();
    }

    private void AnimationsChanged(UISettings sender, UISettingsAnimationsEnabledChangedEventArgs args)
    {
        var entryQpc = captureDiagnostics ? ReadEntryQpc() : null;
        Exception? deliveryFailure = null;
        lock (gate)
        {
            if (captureDiagnostics)
            {
                if (rawEntries <= MaximumSafeInteger) rawEntries++;
                lastEntryQpc = entryQpc;
                lastEntry = EntryOutcome.Rejected;
            }
            if (retired || !subscribed) return;
            if (captureDiagnostics)
            {
                if (admittedEntries <= MaximumSafeInteger) admittedEntries++;
                lastEntry = EntryOutcome.Admitted;
            }
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
