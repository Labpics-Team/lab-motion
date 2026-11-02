using System.Diagnostics;
using System.Numerics;
using System.Text;
using System.Text.Json;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;
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

// Изолированный опыт нативной координаты Y; не API движения и не компонент LabUI.
public sealed partial class InteractionProbe : Page, IInteractionTrackerOwner
{
    private const float ResponseMilliseconds = 350;
    private readonly InteractionTrace trace = new();
    private readonly List<CompositionObject> resources = [];
    private readonly List<(RoutedEvent Event, PointerEventHandler Handler)> inputHandlers = [];
    private readonly TaskCompletionSource<bool> initialPosition = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private InteractionTracker? tracker;
    private VisualInteractionSource? source;
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
            initialRequest = tracker!.TryUpdatePosition(InitialCoordinates);
            trace.Add("initialRequested", new { requestId = initialRequest, position = Vector(InitialCoordinates) });
            trace.Flush();
            await initialPosition.Task.WaitAsync(TimeSpan.FromSeconds(8));
            if (detached) return;
            var position = tracker.Position;
            if (Vector3.Distance(position, InitialCoordinates) > .001f)
                throw new InvalidOperationException("После подтверждения начальной позиции readback не соответствует q = 0,5.");
            CheckGeometry();
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
        tracker = Keep(InteractionTracker.CreateWithOwner(compositor, this));
        tracker.MinPosition = new Vector3(0, -2 * height, 0);
        tracker.MaxPosition = new Vector3(0, height, 0);
        source = Keep(VisualInteractionSource.Create(viewport));
        source.PositionXSourceMode = InteractionSourceMode.Disabled;
        source.PositionYSourceMode = InteractionSourceMode.EnabledWithInertia;
        source.ScaleSourceMode = InteractionSourceMode.Disabled;
        source.PositionXChainingMode = InteractionChainingMode.Never;
        source.PositionYChainingMode = InteractionChainingMode.Never;
        source.ScaleChainingMode = InteractionChainingMode.Never;
        source.IsPositionXRailsEnabled = false;
        source.IsPositionYRailsEnabled = true;
        source.ManipulationRedirectionMode = VisualInteractionSourceRedirectionMode.CapableTouchpadOnly;

        tracker.InteractionSources.Add(source);

        var frequency = (float)(2 * Math.PI * 1000 / ResponseMilliseconds);
        var stiffness = frequency * frequency;
        var damping = 2 * frequency;
        var target = direction > 0 ? -height : 0;
        var settings = Keep(compositor.CreatePropertySet());
        settings.InsertScalar("Target", target);
        settings.InsertScalar("Stiffness", stiffness);
        settings.InsertScalar("Damping", damping);
        var force = Keep(compositor.CreateExpressionAnimation(
            "-settings.Stiffness * (this.Target.Position.Y - settings.Target) - settings.Damping * this.Target.PositionVelocityInPixelsPerSecond.Y"));
        force.SetReferenceParameter("settings", settings);
        var motion = Keep(InteractionTrackerInertiaMotion.Create(compositor));
        motion.Condition = Keep(compositor.CreateExpressionAnimation("true"));
        motion.Motion = force;
        tracker.ConfigurePositionYInertiaModifiers(new[] { motion });

        // Источник ввода неподвижен; положение дочернего visual исполняет композитор.
        var sprite = Keep(compositor.CreateSpriteVisual());
        sprite.Size = new Vector2(width, 24);
        sprite.Brush = Keep(compositor.CreateColorBrush(((SolidColorBrush)Status.Foreground).Color));
        var projection = Keep(compositor.CreateExpressionAnimation("-tracker.Position.Y"));
        projection.SetReferenceParameter("tracker", tracker);
        sprite.StartAnimation("Offset.Y", projection);
        ElementCompositionPreview.SetElementChildVisual(TouchStage, sprite);
        trace.Add("metadata", new
        {
            axis = "y", coordinates = "native", direction, width, height, scale, unitsPerProgress = -height,
            minimum = -2 * height, maximum = height, initial = -height / 2, target,
            responseMilliseconds = ResponseMilliseconds, bounce = 0, frequency, stiffness, damping,
            startedAtUtc = trace.StartedAtUtc, stopwatchFrequency = Stopwatch.Frequency,
            positionYSourceMode = source.PositionYSourceMode.ToString(),
            redirectionMode = source.ManipulationRedirectionMode.ToString(),
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
                source!.TryRedirectForManipulation(args.GetCurrentPoint(null));
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

    private void Observe(InteractionTracker sender, string phase, int requestId, Vector3? position = null, Vector3? velocity = null)
    {
        if (detached) return;
        var readback = sender.Position;
        var observed = position ?? readback;
        trace.Add("motion", new
        {
            phase, requestId, position = Vector(observed), readbackPosition = Vector(readback),
            positionOrigin = position.HasValue ? "event" : "readback",
            progress = ToProgress(observed), readbackProgress = ToProgress(readback),
            nativeVelocity = velocity.HasValue ? Vector(velocity.Value) : null,
            progressVelocity = velocity.HasValue ? (float?)ToProgress(velocity.Value) : null,
        });
        if (phase != "value") trace.Flush();
    }

    public void ValuesChanged(InteractionTracker sender, InteractionTrackerValuesChangedArgs args)
    {
        Observe(sender, "value", args.RequestId, args.Position);
        // TryUpdatePosition из Idle меняет значение без повторного входа в Idle.
        if (!detached && args.RequestId == initialRequest &&
            Vector3.Distance(args.Position, InitialCoordinates) <= .001f &&
            Vector3.Distance(sender.Position, InitialCoordinates) <= .001f)
            initialPosition.TrySetResult(true);
    }
    public void InertiaStateEntered(InteractionTracker sender, InteractionTrackerInertiaStateEnteredArgs args)
        => Observe(sender, "inertia", args.RequestId, velocity: args.PositionVelocityInPixelsPerSecond);
    public void InteractingStateEntered(InteractionTracker sender, InteractionTrackerInteractingStateEnteredArgs args)
        => Observe(sender, "interacting", args.RequestId);
    public void CustomAnimationStateEntered(InteractionTracker sender, InteractionTrackerCustomAnimationStateEnteredArgs args)
        => Observe(sender, "customAnimation", args.RequestId);
    public void IdleStateEntered(InteractionTracker sender, InteractionTrackerIdleStateEnteredArgs args)
        => Observe(sender, "idle", args.RequestId);
    public void RequestIgnored(InteractionTracker sender, InteractionTrackerRequestIgnoredArgs args)
    {
        Observe(sender, "ignored", args.RequestId);
        if (args.RequestId == initialRequest)
            initialPosition.TrySetException(new InvalidOperationException("Нативный исполнитель отклонил начальную позицию."));
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
        tracker?.InteractionSources.RemoveAll();
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
