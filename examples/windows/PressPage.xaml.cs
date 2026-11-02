using LabMotion.WinUI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Hosting;
using Windows.UI.ViewManagement;

namespace NativeWindow;

// Демонстрация платформенного ввода и lifetime, без калибровок дизайн-системы.
public sealed partial class PressPage : Page
{
    private readonly UISettings settings = new();
    private ScalarMotion? motion;
    private long pressedToken;
    private long enabledToken;
    private long operation;

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
        pressedToken = Press.RegisterPropertyChangedCallback(ButtonBase.IsPressedProperty, Changed);
        enabledToken = Press.RegisterPropertyChangedCallback(Control.IsEnabledProperty, Changed);
        Animation.Checked += PreferenceChanged;
        Animation.Unchecked += PreferenceChanged;
        settings.AnimationsEnabledChanged += SystemPreferenceChanged;
        Update();
    }

    private void Changed(DependencyObject sender, DependencyProperty property) => Update();
    private void PreferenceChanged(object sender, RoutedEventArgs args) => Update();
    private void SystemPreferenceChanged(UISettings sender, UISettingsAnimationsEnabledChangedEventArgs args)
        => DispatcherQueue.TryEnqueue(Update);

    private async void Update()
    {
        var current = motion;
        if (current is null) return;
        var id = ++operation;
        var pressed = Press.IsEnabled && Press.IsPressed;
        State.Text = pressed ? "Нажато" : "Отпущено";
        try
        {
            if (Animation.IsChecked != true || !settings.AnimationsEnabled)
                current.SnapTo(pressed ? 1 : 0);
            else
                await current.AnimateTo(pressed ? 1 : 0, new Spring(350, 0));
        }
        catch (Exception error)
        {
            if (id == operation && ReferenceEquals(current, motion)) State.Text = error.Message;
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
        motion.Dispose();
        motion = null;
    }
}
