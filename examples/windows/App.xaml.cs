using Microsoft.UI.Xaml;

namespace NativeWindow;

public partial class App : Application
{
    private Window? window;

    public App() => InitializeComponent();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new Window
        {
            Title = "LabMotion — проверка движения",
            Content = Environment.GetEnvironmentVariable("LAB_MOTION_PROBE_OUTPUT") is null
                ? new PressPage() : new MainPage(),
        };
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(640,
            Environment.GetEnvironmentVariable("LAB_MOTION_PROBE_OUTPUT") is null ? 440 : 360));
        window.Activate();
    }
}
