using LabMotion.WinUI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using System.Threading;
using System.Runtime.ExceptionServices;
using Windows.UI.ViewManagement;

namespace NativeWindow;

// Демонстрация платформенного ввода и lifetime, без калибровок дизайн-системы.
public sealed partial class PressPage : Page
{
    private readonly UISettings settings = new();
    private readonly PressTrace? trace = PressTrace.FromEnvironment();
    private readonly Window window;
    private SystemPreferenceNotifications? notifications;
    private bool? observedSystemAnimation;
    private bool windowClosed;
    private ScalarMotion? motion;
    private long pressedToken;
    private long enabledToken;
    private long operation;
    private long systemNotification;
    private int notificationDiagnosticFailed;
    private enum SystemNotificationPhase { Received, Queued, Delegate }
    private List<(RoutedEvent Event, Delegate Handler)>? inputHandlers;

    public PressPage(Window window)
    {
        this.window = window;
        InitializeComponent();
        Loaded += Attach;
        Unloaded += Detach;
    }

    private void Attach(object sender, RoutedEventArgs args)
    {
        if (windowClosed) throw new InvalidOperationException("Окно системной подписки уже закрыто.");
        notifications?.ThrowIfFaulted();
        if (motion is not null) return;
        if (notifications is not null) throw new InvalidOperationException("Прежняя системная подписка ещё не снята.");
        notifications = new SystemPreferenceNotifications(window, SystemPreferenceChanged, NotificationFailed);
        var visual = ElementCompositionPreview.GetElementVisual(Highlight);
        motion = ScalarMotion.CreateProgress(visual.Compositor);
        motion.Bind(visual, ScalarProperty.Opacity, .45f);
        if (trace is not null)
        {
            motion.Observed += Observe;
            AttachInputTrace();
        }
        pressedToken = Press.RegisterPropertyChangedCallback(ButtonBase.IsPressedProperty, Changed);
        enabledToken = Press.RegisterPropertyChangedCallback(Control.IsEnabledProperty, Changed);
        Animation.Checked += PreferenceChanged;
        Animation.Unchecked += PreferenceChanged;
        trace?.Add("attached", new { scale = XamlRoot.RasterizationScale });
        Update("attach");
    }

    private void Changed(DependencyObject sender, DependencyProperty property)
        => Update(property == ButtonBase.IsPressedProperty ? "pressed" : "enabled");
    private void PreferenceChanged(object sender, RoutedEventArgs args) => Update("localPreference");
    private void SystemPreferenceChanged()
    {
        var subscription = notifications;
        if (trace is null)
        {
            if (!DispatcherQueue.TryEnqueue(() => ApplySystemPreference(subscription)))
                throw new InvalidOperationException("Очередь отказала системному уведомлению.");
            return;
        }
        var notification = Interlocked.Increment(ref systemNotification);
        ObserveSystemNotification(notification, SystemNotificationPhase.Received);
        var queued = DispatcherQueue.TryEnqueue(() =>
        {
            ObserveSystemNotification(notification, SystemNotificationPhase.Delegate);
            ApplySystemPreference(subscription);
        });
        // Отказ очереди не имеет будущего Update/Flush; фиксируем также его bool.
        ObserveSystemNotification(notification, SystemNotificationPhase.Queued, queued, flush: true);
        if (!queued) throw new InvalidOperationException("Очередь отказала системному уведомлению.");
    }

    private void ApplySystemPreference(SystemPreferenceNotifications? subscription)
    {
        if (subscription is null || !ReferenceEquals(notifications, subscription) || !subscription.IsAttached) return;
        subscription.ThrowIfFaulted();
        var enabled = settings.AnimationsEnabled;
        if (observedSystemAnimation == enabled) return;
        Update("systemPreference");
    }

    private void NotificationFailed(Exception error)
    {
        const string message = "Ошибка уведомления системной настройки.";
        try
        {
            trace?.Add("error", new { type = error.GetType().Name, message });
            trace?.Flush();
        }
        finally { State.Text = message; }
    }

    private void ObserveSystemNotification(long notification, SystemNotificationPhase phase, bool? queued = null, bool flush = false)
    {
        if (trace is null) return;
        var validIdentity = notification > 0 && notification <= 9007199254740991;
        if (!validIdentity) Interlocked.Exchange(ref notificationDiagnosticFailed, 1);
        try
        {
            // Настоящий WM callback: запись не утверждает изменение preference или исполнение queue.
            trace.Add("systemNotification", new
            {
                notification = validIdentity ? (long?)notification : null,
                source = "WM_SETTINGCHANGE", phase = phase.ToString(), queued,
                diagnosticFailed = Volatile.Read(ref notificationDiagnosticFailed) != 0,
            });
            if (flush) trace.Flush();
        }
        catch
        {
            // Следующая доступная запись покажет сбой; ошибка диагностики не заменяет callback.
            Interlocked.Exchange(ref notificationDiagnosticFailed, 1);
        }
    }

    private void Observe(MotionObservation value)
    {
        trace?.Add("motion", new
        {
            pageOperation = operation,
            nativeOperation = value.Operation,
            phase = value.Phase,
            position = value.Position,
            nativeVelocity = value.NativeVelocity,
            readbackPosition = value.ReadbackPosition,
            nativeSeconds = value.Seconds,
        });
        if (value.Phase == "idle") trace?.Flush();
    }

    private void AttachInputTrace()
    {
        inputHandlers = [];
        foreach (var (routedEvent, name) in new[]
        {
            (PointerPressedEvent, "pointerPressed"), (PointerReleasedEvent, "pointerReleased"),
            (PointerExitedEvent, "pointerExited"), (PointerCanceledEvent, "pointerCanceled"),
            (PointerCaptureLostEvent, "pointerCaptureLost"),
        })
        {
            PointerEventHandler handler = (_, args) => Input(new
            {
                @event = name, device = args.Pointer.PointerDeviceType.ToString(), pointerId = args.Pointer.PointerId,
            });
            Press.AddHandler(routedEvent, handler, true);
            inputHandlers.Add((routedEvent, handler));
        }
        foreach (var (routedEvent, name) in new[] { (KeyDownEvent, "keyDown"), (KeyUpEvent, "keyUp") })
        {
            KeyEventHandler handler = (_, args) => Input(new { @event = name, device = "Keyboard", key = args.Key.ToString() });
            Press.AddHandler(routedEvent, handler, true);
            inputHandlers.Add((routedEvent, handler));
        }
    }

    private void Input(object data)
    {
        trace!.Add("input", data);
        trace.Flush();
    }

    private async void Update(string trigger)
    {
        notifications?.ThrowIfFaulted();
        var current = motion;
        if (current is null) return;
        var id = ++operation;
        var pressed = Press.IsEnabled && Press.IsPressed;
        var localAnimation = Animation.IsChecked == true;
        var systemAnimation = settings.AnimationsEnabled;
        observedSystemAnimation = systemAnimation;
        State.Text = pressed ? "Нажато" : "Отпущено";
        trace?.Add("intent", new
        {
            operation = id, trigger, pressed, enabled = Press.IsEnabled,
            localAnimation, systemAnimation, target = pressed ? 1 : 0,
        });
        try
        {
            if (!localAnimation || !systemAnimation)
            {
                current.SnapTo(pressed ? 1 : 0);
                trace?.Add("snapRequested", new { operation = id, target = pressed ? 1 : 0 });
                trace?.Flush();
                if (trace is not null) await ObserveSnap(current, id, pressed ? 1 : 0);
            }
            else
            {
                var pending = current.AnimateTo(pressed ? 1 : 0, new Spring(350, 0));
                trace?.Flush();
                var result = await pending;
                trace?.Add("completed", new
                {
                    operation = id, nativeOperation = result.Operation,
                    end = result.End.ToString(), reason = result.Reason,
                    isCurrent = id == operation && ReferenceEquals(current, motion),
                    systemAnimation = ReadSystemAnimationForTrace(),
                    // Выборки независимы; last-issued id не подтверждает receipt для текущего SPI.
                    notification = ReadSystemNotificationForTrace(),
                    diagnosticFailed = Volatile.Read(ref notificationDiagnosticFailed) != 0,
                });
                trace?.Flush();
            }
        }
        catch (Exception error)
        {
            trace?.Add("error", new { operation = id, type = error.GetType().Name, message = error.Message });
            trace?.Flush();
            if (id == operation && ReferenceEquals(current, motion)) State.Text = error.Message;
        }
    }

    private long? ReadSystemNotificationForTrace()
    {
        var notification = Volatile.Read(ref systemNotification);
        return notification > 0 && notification <= 9007199254740991
            ? (long?)notification : null;
    }

    private bool? ReadSystemAnimationForTrace()
    {
        try
        {
            // Значение относится к этой completed-выборке, не к моменту SPI или native idle.
            if (!DispatcherQueue.HasThreadAccess) return null;
            return settings.AnimationsEnabled;
        }
        catch { return null; } // Недоступное диагностическое чтение не меняет исход движения.
    }

    // Только тестовое чтение: не задаёт положение и не исполняет кадры анимации.
    private async Task ObserveSnap(ScalarMotion current, long id, float target)
    {
        for (var attempt = 0; attempt < 20; attempt++)
        {
            await Task.Delay(50);
            if (id != operation || !ReferenceEquals(current, motion)) return;
            var position = current.Position;
            if (Math.Abs(position - target) > .001f && attempt < 19) continue;
            trace!.Add("snapReadback", new { operation = id, target, position });
            trace.Flush();
            return;
        }
    }

    private void Detach(object sender, RoutedEventArgs args)
        => Detach();

    internal void Close()
    {
        windowClosed = true;
        Detach();
    }

    private void Detach()
    {
        ExceptionDispatchInfo? failure = null;
        void Attempt(Action action)
        {
            try { action(); }
            catch (Exception error) { failure ??= ExceptionDispatchInfo.Capture(error); }
        }
        var subscription = notifications;
        if (subscription is not null)
        {
            Attempt(subscription.Dispose);
            if (!subscription.IsAttached && ReferenceEquals(notifications, subscription)) notifications = null;
        }
        if (motion is not null)
        {
            Attempt(() => Press.UnregisterPropertyChangedCallback(ButtonBase.IsPressedProperty, pressedToken));
            Attempt(() => Press.UnregisterPropertyChangedCallback(Control.IsEnabledProperty, enabledToken));
            Animation.Checked -= PreferenceChanged;
            Animation.Unchecked -= PreferenceChanged;
            ++operation;
            if (trace is not null) motion.Observed -= Observe;
            if (inputHandlers is not null)
            {
                foreach (var (routedEvent, handler) in inputHandlers) Attempt(() => Press.RemoveHandler(routedEvent, handler));
                inputHandlers = null;
            }
            Attempt(motion.Dispose);
            motion = null;
            observedSystemAnimation = null;
            Attempt(() => trace?.Add("detached", new { operation }));
            Attempt(() => trace?.Flush());
        }
        failure?.Throw();
    }
}
