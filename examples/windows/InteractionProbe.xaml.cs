using System.Diagnostics;
using System.Numerics;
using System.Text;
using System.Text.Json;
using LabMotion.WinUI;
using Microsoft.UI.Composition;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace NativeWindow;

// У Grid нет собственного обязательного peer; harness получает границы именно неподвижного viewport.
public sealed class InteractionViewport : Grid
{
    protected override AutomationPeer OnCreateAutomationPeer() => new ViewportPeer(this);

    private sealed class ViewportPeer(InteractionViewport owner) : FrameworkElementAutomationPeer(owner)
    {
        protected override string GetClassNameCore() => nameof(InteractionViewport);
        protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Pane;
        protected override bool IsControlElementCore() => true;
        protected override bool IsContentElementCore() => true;
    }
}

// Настоящий Touch-потребитель публичного канала; фиксированная геометрия, без стилей LabUI.
public sealed partial class InteractionProbe : Page
{
    private const float ResponseMilliseconds = 350;
    private readonly InteractionTrace trace = new();
    private readonly List<CompositionObject> resources = [];
    private readonly List<(RoutedEvent Event, PointerEventHandler Handler)> inputHandlers = [];
    private readonly TaskCompletionSource<MotionObservation> initialPosition = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private ScalarMotion? motion;
    private ScalarPan? pan;
    private int direction;
    private int initialRequest;
    private float width;
    private float height;
    private double scale;
    private bool ready;
    private bool detached;

    public InteractionProbe()
    {
        InitializeComponent();
        Loaded += Attach;
        Unloaded += Detach;
    }

    private async void Attach(object sender, RoutedEventArgs args)
    {
        Loaded -= Attach;
        try
        {
            direction = Environment.GetEnvironmentVariable("LAB_MOTION_INTERACTION_DIRECTION") switch
            {
                "1" => 1, "-1" => -1,
                _ => throw new InvalidOperationException("LAB_MOTION_INTERACTION_DIRECTION должен быть 1 или -1."),
            };
            width = (float)TouchStage.ActualWidth;
            height = (float)TouchStage.ActualHeight;
            scale = XamlRoot.RasterizationScale;
            if (!float.IsFinite(width) || !float.IsFinite(height) || width <= 0 || height <= 0)
                throw new InvalidOperationException("Область ввода должна иметь ненулевой размер в DIP.");
            Configure();
            AttachInput();
            trace.Add("initialRequested", new { origin = "Initial", position = Vector(InitialCoordinates) });
            trace.Flush();
            var initial = await initialPosition.Task.WaitAsync(TimeSpan.FromSeconds(8));
            if (detached) return;
            var position = initial.NativeReadbackPosition;
            if (Vector3.Distance(position, InitialCoordinates) > .001f || Math.Abs(motion!.Position + height / 2) > .001f)
                throw new InvalidOperationException("После подтверждения начальной позиции readback не соответствует q = 0,5.");
            CheckGeometry();
            pan = motion.AttachPan(ElementCompositionPreview.GetElementVisual(TouchStage));
            LogMetadata();
            ready = true;
            Status.Text = "Ready";
            AutomationProperties.SetName(Status, "Ready");
            trace.Add("ready", new
            {
                requestId = initialRequest, position = Vector(position), progress = ToProgress(position),
                width, height, scale, coordinates = "native", unitsPerProgress = -height,
            });
            trace.Flush();
        }
        catch (Exception error) { if (!detached) Fail("attach", error); }
    }

    private T Keep<T>(T resource) where T : CompositionObject
    {
        resources.Add(resource);
        return resource;
    }

    private void Configure()
    {
        var viewport = ElementCompositionPreview.GetElementVisual(TouchStage);
        var compositor = viewport.Compositor;
        motion = new ScalarMotion(compositor, ScalarAxis.Y, -2 * height, height, -height / 2);
        motion.Observed += Observe;
        motion.SetTarget(-height / 2, new Spring(ResponseMilliseconds, 0));

        // Источник ввода неподвижен; положение дочернего visual исполняет композитор.
        var sprite = Keep(compositor.CreateSpriteVisual());
        sprite.Size = new Vector2(width, 24);
        sprite.Brush = Keep(compositor.CreateColorBrush(((SolidColorBrush)Status.Foreground).Color));
        motion.Bind(sprite, ScalarProperty.OffsetY, -1);
        ElementCompositionPreview.SetElementChildVisual(TouchStage, sprite);
    }

    private void LogMetadata()
    {
        var target = direction > 0 ? -height : 0;
        trace.Add("metadata", new
        {
            axis = "y", coordinates = "native", direction, width, height, scale, unitsPerProgress = -height,
            minimum = -2 * height, maximum = height, initial = -height / 2, target,
            responseMilliseconds = ResponseMilliseconds, bounce = 0,
            consumer = "ScalarMotion", initialReleaseTarget = -height / 2,
            startedAtUtc = trace.StartedAtUtc, stopwatchFrequency = Stopwatch.Frequency,
            positionYSourceMode = pan!.SourceMode.ToString(),
            redirectionMode = pan.RedirectionMode.ToString(),
        });
    }

    private void AttachInput()
    {
        foreach (var (routedEvent, name) in new[]
        {
            (PointerPressedEvent, "pointerPressed"), (PointerReleasedEvent, "pointerReleased"),
            (PointerCanceledEvent, "pointerCanceled"), (PointerCaptureLostEvent, "pointerCaptureLost"),
        })
        {
            PointerEventHandler handler = (_, args) => Input(name, args);
            TouchStage.AddHandler(routedEvent, handler, true);
            inputHandlers.Add((routedEvent, handler));
        }
    }

    private void Input(string name, PointerRoutedEventArgs args)
    {
        try
        {
            CheckGeometry();
            var point = args.GetCurrentPoint(TouchStage);
            trace.Add("input", new
            {
                @event = name, device = args.Pointer.PointerDeviceType.ToString(),
                pointerId = args.Pointer.PointerId, x = point.Position.X, y = point.Position.Y,
                pointerTimestamp = point.Timestamp, frameId = point.FrameId, isInContact = point.IsInContact, ready,
            });
            trace.Flush();
            if (name != "pointerPressed" || args.Pointer.PointerDeviceType != PointerDeviceType.Touch) return;
            if (!ready) throw new InvalidOperationException("Touch пришёл до подтверждения начальной позиции.");
            try
            {
                pan!.Redirect(args.GetCurrentPoint(null));
                trace.Add("redirect", new { pointerId = args.Pointer.PointerId, result = "returned" });
                trace.Flush();
            }
            catch (Exception error)
            {
                trace.Add("redirect", new { pointerId = args.Pointer.PointerId, result = "error", error = error.ToString() });
                throw;
            }
        }
        catch (Exception error) { Fail("input", error); }
    }

    private void CheckGeometry()
    {
        if (TouchStage.ActualWidth != width || TouchStage.ActualHeight != height || XamlRoot.RasterizationScale != scale)
            throw new InvalidOperationException("Геометрия или DPI изменились во время опыта; нужен отдельный запуск.");
    }

    private Vector3 InitialCoordinates => new(0, -height / 2, 0);
    private float ToProgress(Vector3 value) => -value.Y / height;
    private static object Vector(Vector3 value) => new { x = value.X, y = value.Y, z = value.Z };

    private void Observe(MotionObservation observation)
    {
        if (detached) return;
        var phase = observation.Phase == "custom" ? "customAnimation" : observation.Phase;
        var requestId = observation.NativeRequestId;
        var readback = observation.NativeReadbackPosition;
        var observed = observation.NativePosition;
        var velocity = observation.NativeVelocityVector;
        trace.Add("motion", new
        {
            phase, requestId, position = Vector(observed), readbackPosition = Vector(readback),
            origin = observation.Origin.ToString(),
            positionOrigin = phase == "value" ? "event" : "readback",
            progress = ToProgress(observed), readbackProgress = ToProgress(readback),
            nativeVelocity = velocity.HasValue ? Vector(velocity.Value) : null,
            progressVelocity = velocity.HasValue ? (float?)ToProgress(velocity.Value) : null,
        });
        if (phase != "value") trace.Flush();
        // TryUpdatePosition из Idle меняет значение без повторного входа в Idle.
        if (observation.Origin == MotionOrigin.Initial && phase == "value" &&
            Vector3.Distance(observed, InitialCoordinates) <= .001f &&
            Vector3.Distance(readback, InitialCoordinates) <= .001f)
        {
            initialRequest = requestId;
            initialPosition.TrySetResult(observation);
        }
        if (observation.Origin == MotionOrigin.Initial && phase == "ignored")
            initialPosition.TrySetException(new InvalidOperationException("Нативный исполнитель отклонил начальную позицию."));
        if (observation.Origin == MotionOrigin.Input && phase == "interacting")
        {
            var target = direction > 0 ? -height : 0;
            motion!.SetTarget(target, new Spring(ResponseMilliseconds, 0));
            trace.Add("targetChanged", new { target, phase, origin = observation.Origin.ToString() });
            trace.Flush();
        }
    }

    private void Fail(string phase, Exception error)
    {
        ready = false;
        Environment.ExitCode = 1;
        Status.Text = "Ошибка опыта";
        AutomationProperties.SetName(Status, "Error");
        trace.Add("error", new { phase, error = error.ToString() });
        trace.Flush();
        Application.Current.Exit();
    }

    private void Detach(object sender, RoutedEventArgs args)
    {
        if (detached) return;
        detached = true;
        ready = false;
        initialPosition.TrySetCanceled();
        foreach (var (routedEvent, handler) in inputHandlers) TouchStage.RemoveHandler(routedEvent, handler);
        inputHandlers.Clear();
        ElementCompositionPreview.SetElementChildVisual(TouchStage, null);
        if (motion is not null)
        {
            motion.Observed -= Observe;
            motion.Dispose();
        }
        for (var i = resources.Count - 1; i >= 0; i--) resources[i].Dispose();
        resources.Clear();
        trace.Add("detached", new { });
        trace.Flush();
        trace.Dispose();
    }

    // Callback значения буферизуется; ввод и смена состояния сбрасывают весь буфер.
    private sealed class InteractionTrace : IDisposable
    {
        private const int MaximumEvents = 65536;
        private readonly object gate = new();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly List<object> pending = [];
        private readonly string path;
        private long sequence;
        private bool disposed;
        public DateTimeOffset StartedAtUtc { get; } = DateTimeOffset.UtcNow;

        public InteractionTrace()
        {
            path = Environment.GetEnvironmentVariable("LAB_MOTION_INTERACTION_OUTPUT")
                ?? throw new InvalidOperationException("Нужен LAB_MOTION_INTERACTION_OUTPUT для JSONL опыта.");
            using var created = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
        }

        public void Add(string kind, object data)
        {
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (sequence >= MaximumEvents)
                {
                    pending.Add(new { sequence = ++sequence, seconds = clock.Elapsed.TotalSeconds, kind = "truncated", data = new { maximumEvents = MaximumEvents } });
                    Flush();
                    Environment.ExitCode = 1;
                    throw new InvalidOperationException("Лимит JSONL опыта исчерпан; результат неполон.");
                }
                pending.Add(new { sequence = ++sequence, seconds = clock.Elapsed.TotalSeconds, kind, data });
            }
        }

        public void Flush()
        {
            lock (gate)
            {
                if (disposed || pending.Count == 0) return;
                using var writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
                foreach (var entry in pending) writer.WriteLine(JsonSerializer.Serialize(entry));
                writer.Flush();
                pending.Clear();
            }
        }

        private void OnProcessExit(object? sender, EventArgs args)
        {
            Add("processExit", new { });
            Dispose();
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                Flush();
                disposed = true;
                AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
            }
        }
    }
}
