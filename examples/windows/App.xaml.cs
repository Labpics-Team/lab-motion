using Microsoft.UI.Xaml;

namespace NativeWindow;

public partial class App : Application
{
    private Window? window;

    public App() => InitializeComponent();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new Window { Title = "LabMotion — проверка движения", Content = new MainPage() };
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(640, 360));
        window.Activate();
    }
}
