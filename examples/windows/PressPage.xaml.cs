using LabMotion.WinUI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Windows.UI.ViewManagement;

namespace NativeWindow;

// Демонстрация платформенного ввода и lifetime, без калибровок дизайн-системы.
public sealed partial class PressPage : Page
{
    private readonly UISettings settings = new();
    private readonly PressTrace? trace = PressTrace.FromEnvironment();
    private ScalarMotion? motion;
    private long pressedToken;
    private long enabledToken;
    private long operation;
    private List<(RoutedEvent Event, Delegate Handler)>? inputHandlers;

    public PressPage()
    {
        InitializeComponent();
        Loaded += Attach;
        Unloaded += Detach;
    }

    private void Attach(object sender, RoutedEventArgs args)
    {
        if (motion is not null) return;
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
        settings.AnimationsEnabledChanged += SystemPreferenceChanged;
        trace?.Add("attached", new { scale = XamlRoot.RasterizationScale });
        Update("attach");
    }

    private void Changed(DependencyObject sender, DependencyProperty property)
        => Update(property == ButtonBase.IsPressedProperty ? "pressed" : "enabled");
    private void PreferenceChanged(object sender, RoutedEventArgs args) => Update("localPreference");
    private void SystemPreferenceChanged(UISettings sender, UISettingsAnimationsEnabledChangedEventArgs args)
        => DispatcherQueue.TryEnqueue(() => Update("systemPreference"));

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
        var current = motion;
        if (current is null) return;
        var id = ++operation;
        var pressed = Press.IsEnabled && Press.IsPressed;
        var localAnimation = Animation.IsChecked == true;
        var systemAnimation = settings.AnimationsEnabled;
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
    {
        if (motion is null) return;
        Press.UnregisterPropertyChangedCallback(ButtonBase.IsPressedProperty, pressedToken);
        Press.UnregisterPropertyChangedCallback(Control.IsEnabledProperty, enabledToken);
        Animation.Checked -= PreferenceChanged;
        Animation.Unchecked -= PreferenceChanged;
        settings.AnimationsEnabledChanged -= SystemPreferenceChanged;
        ++operation;
        if (trace is not null) motion.Observed -= Observe;
        if (inputHandlers is not null)
        {
            foreach (var (routedEvent, handler) in inputHandlers) Press.RemoveHandler(routedEvent, handler);
            inputHandlers = null;
        }
        motion.Dispose();
        motion = null;
        trace?.Add("detached", new { operation });
        trace?.Flush();
    }
}
