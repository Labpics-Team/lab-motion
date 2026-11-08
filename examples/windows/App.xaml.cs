using Microsoft.UI.Xaml;

namespace NativeWindow;

public partial class App : Application
{
    private Window? window;

    public App() => InitializeComponent();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var interaction = Environment.GetEnvironmentVariable("LAB_MOTION_INTERACTION_OUTPUT") is not null;
        window = new Window
        {
            Title = "LabMotion — проверка движения",
        };
        if (interaction) window.Content = new InteractionProbe();
        else if (Environment.GetEnvironmentVariable("LAB_MOTION_PROBE_OUTPUT") is null)
        {
            var press = new PressPage(window);
            window.Content = press;
            window.Closed += (_, _) => press.Close();
        }
        else window.Content = new MainPage();
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(640,
            interaction ? 560 : Environment.GetEnvironmentVariable("LAB_MOTION_PROBE_OUTPUT") is null ? 440 : 360));
        window.Activate();
    }
}
