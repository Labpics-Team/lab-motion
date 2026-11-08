using System.Diagnostics;
using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;
using Microsoft.UI.Dispatching;

namespace LabMotion.WinUI;

public readonly record struct Spring(float ResponseMilliseconds, float Bounce);
public enum MotionEnd { Finished, Stopped }
public enum ScalarAxis { X, Y }
public enum MotionOrigin { Animation, Input, Initial, Snap, Stop }
public readonly record struct MotionResult(long Operation, MotionEnd End, string Reason);
public readonly record struct MotionObservation(
    long Operation, string Phase, double Seconds, float Position, float? NativeVelocity, float ReadbackPosition)
{
    public MotionOrigin Origin { get; init; }
    // Диагностика WinUI; управление каналом не требует этих native идентификаторов и векторов.
    public int NativeRequestId { get; init; }
    public Vector3 NativePosition { get; init; }
    public Vector3 NativeReadbackPosition { get; init; }
    public Vector3? NativeVelocityVector { get; init; }
}

/// <summary>Экспериментальный канал координаты. Скорость — в единицах координаты в секунду.</summary>
public sealed class ScalarMotion : IInteractionTrackerOwner, IDisposable
{
    private const float ProgressEndpointAccuracy = .001f;
    private sealed record Operation(long Id, int Request, TaskCompletionSource<MotionResult> Completion);
    private sealed record Request(int Id, MotionOrigin Origin, long Operation = 0)
    {
        public float? Target { get; init; }
        public bool IdleHandoffUsed { get; init; }
    }
    private readonly DispatcherQueue dispatcher;
    private readonly InteractionTracker tracker;
    private readonly CompositionPropertySet settings;
    private readonly InteractionTrackerInertiaMotion modifier;
    private readonly ExpressionAnimation condition;
    private readonly ExpressionAnimation force;
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly float minimum;
    private readonly float maximum;
    private readonly float coordinateScale;
    private readonly float endpointAccuracy;
    private readonly ScalarAxis axis;
    private Operation? active;
    private Request? request;
    private long generation;
    private bool disposed;
    private string phase = "idle";
    private bool configured;
    private bool interacting;
    private readonly HashSet<ScalarBinding> bindings = [];
    private readonly HashSet<ScalarPan> inputs = [];

    public event Action<MotionObservation>? Observed;
    public float Position { get { CheckAccess(); return Coordinate(tracker.Position) / coordinateScale; } }

    /// <summary>Привязка выполняется композитором: UI не пересчитывает кадры движения.</summary>
    public IDisposable BindOffsetX(Visual visual) => Bind(visual, ScalarProperty.OffsetX);

    /// <summary>Проецирует координату как position × multiplier + offset до освобождения привязки.</summary>
    public IDisposable Bind(Visual visual, ScalarProperty property, float multiplier = 1, float offset = 0)
    {
        CheckAccess();
        var binding = ScalarBinding.Create(dispatcher, tracker, visual, property, axis, coordinateScale, multiplier, offset,
            released => bindings.Remove(released));
        bindings.Add(binding);
        return binding;
    }

    /// <summary>Подключает неподвижный viewport к сырой координате; SetTarget задаёт движение после отпускания.</summary>
    public ScalarPan AttachPan(Visual viewport)
    {
        CheckAccess();
        if (coordinateScale != 1) throw new InvalidOperationException("Ввод требует сырой координаты; progress является проекцией.");
        if (!configured) throw new InvalidOperationException("Перед подключением ввода задайте цель и пружину через SetTarget.");
        var input = ScalarPan.Create(dispatcher, tracker, viewport, axis, released => inputs.Remove(released));
        inputs.Add(input);
        return input;
    }

    /// <summary>Безразмерный канал 0…1; скорость задаётся в единицах progress в секунду.</summary>
    public static ScalarMotion CreateProgress(Compositor compositor, float initial = 0)
        // Размах 1000 квалифицирован для точности progress; интегратор остаётся системным.
        => new(compositor, ScalarAxis.X, 0, 1, initial, 1000, ProgressEndpointAccuracy);

    public ScalarMotion(Compositor compositor, float minimum, float maximum, float initial, float endpointAccuracy)
        : this(compositor, ScalarAxis.X, minimum, maximum, initial, 1, endpointAccuracy) { }

    public ScalarMotion(Compositor compositor, ScalarAxis axis, float minimum, float maximum, float initial, float endpointAccuracy)
        : this(compositor, axis, minimum, maximum, initial, 1, endpointAccuracy) { }

    private ScalarMotion(Compositor compositor, ScalarAxis axis, float minimum, float maximum, float initial,
        float coordinateScale, float endpointAccuracy)
    {
        dispatcher = DispatcherQueue.GetForCurrentThread()
            ?? throw new InvalidOperationException("Нужен поток с DispatcherQueue.");
        if (!float.IsFinite(minimum) || !float.IsFinite(maximum) || minimum >= maximum)
            throw new ArgumentOutOfRangeException(nameof(minimum));
        if (axis is not (ScalarAxis.X or ScalarAxis.Y)) throw new ArgumentOutOfRangeException(nameof(axis));
        var nativeAccuracy = endpointAccuracy * coordinateScale;
        var nativeAccuracySquared = nativeAccuracy * nativeAccuracy;
        if (!float.IsFinite(endpointAccuracy) || endpointAccuracy <= 0 ||
            !float.IsFinite(nativeAccuracySquared) || nativeAccuracySquared <= 0)
            throw new ArgumentOutOfRangeException(nameof(endpointAccuracy), "Точность должна быть конечной и положительной в координатах исполнителя.");
        this.axis = axis;
        this.minimum = minimum;
        this.maximum = maximum;
        this.coordinateScale = coordinateScale;
        this.endpointAccuracy = endpointAccuracy;
        ValidatePosition(initial);
        tracker = InteractionTracker.CreateWithOwner(compositor, this);
        tracker.MinPosition = Coordinates(minimum * coordinateScale);
        tracker.MaxPosition = Coordinates(maximum * coordinateScale);
        settings = compositor.CreatePropertySet();
        settings.InsertScalar("Target", initial * coordinateScale);
        settings.InsertScalar("Stiffness", 1);
        settings.InsertScalar("Damping", 1);
        settings.InsertScalar("BoundaryAccuracySquared", nativeAccuracySquared);
        // E = (x-target)^2 + v^2/k bounds squared remaining damped spring displacement.
        // A boundary residual within the coordinate's admitted accuracy belongs to native
        // bounded correction; reselecting the force there can prevent native Idle forever.
        var displacement = $"(this.Target.Position.{axis} - settings.Target)";
        var velocity = $"this.Target.PositionVelocityInPixelsPerSecond.{axis}";
        condition = compositor.CreateExpressionAnimation(
            $"!(((this.Target.Position.{axis} < this.Target.MinPosition.{axis} && settings.Target == this.Target.MinPosition.{axis}) || " +
            $"(this.Target.Position.{axis} > this.Target.MaxPosition.{axis} && settings.Target == this.Target.MaxPosition.{axis})) && " +
            $"({displacement} * {displacement} + {velocity} * {velocity} / settings.Stiffness <= settings.BoundaryAccuracySquared))");
        condition.SetReferenceParameter("settings", settings);
        force = compositor.CreateExpressionAnimation(
            $"-settings.Stiffness * (this.Target.Position.{axis} - settings.Target) - settings.Damping * this.Target.PositionVelocityInPixelsPerSecond.{axis}");
        force.SetReferenceParameter("settings", settings);
        modifier = InteractionTrackerInertiaMotion.Create(compositor);
        modifier.Condition = condition;
        modifier.Motion = force;
        if (axis == ScalarAxis.X) tracker.ConfigurePositionXInertiaModifiers(new[] { modifier });
        else tracker.ConfigurePositionYInertiaModifiers(new[] { modifier });
        request = new(tracker.TryUpdatePosition(Coordinates(initial * coordinateScale)), MotionOrigin.Initial);
    }

    /// <summary>Меняет текущую Inertia и следующий release; не начинает движение из Idle или Interacting.</summary>
    public void SetTarget(float target, Spring parameters)
    {
        CheckAccess();
        var coefficients = ValidateTarget(target, parameters);
        var continuation = phase == "inertia" &&
            (request?.Target is not null || request is null && interacting)
                ? request ?? new Request(0, MotionOrigin.Input) : null;
        var pendingIntent = request?.Target is not null;
        Finish(MotionEnd.Stopped, "target-changed");
        Configure(target, parameters, coefficients);
        if (continuation is not null)
        {
            // Modifier conditions are sampled on Inertia entry. A new target must also
            // replace a selected bounded correction, preserving native position/velocity.
            var nativeRequest = tracker.TryUpdatePositionWithAdditionalVelocity(Vector3.Zero);
            request = continuation with { Id = nativeRequest, Target = target, IdleHandoffUsed = false };
            interacting = false;
            Emit("requested", request);
        }
        else if (pendingIntent)
            request = request! with { Target = target, IdleHandoffUsed = false };
    }

    /// <summary>Новая цель сохраняет текущую native-скорость; initialVelocity допустима из покоя.</summary>
    public Task<MotionResult> AnimateTo(float target, Spring parameters, float? initialVelocity = null)
    {
        CheckAccess();
        var coefficients = ValidateTarget(target, parameters);
        if (initialVelocity is { } velocity)
        {
            if (!float.IsFinite(velocity * coordinateScale))
                throw new ArgumentOutOfRangeException(nameof(initialVelocity), "Скорость должна быть конечной в координатах исполнителя.");
            if (phase != "idle" || active is not null)
                throw new ArgumentException("Начальная скорость задаётся только из покоя.", nameof(initialVelocity));
        }
        // Намерение сохраняется и при RequestIgnored: попытка запуска не является транзакцией настроек.
        Finish(MotionEnd.Stopped, "replaced");
        Configure(target, parameters, coefficients);
        var nativeRequest = tracker.TryUpdatePositionWithAdditionalVelocity(Coordinates((initialVelocity ?? 0) * coordinateScale));
        var operation = new Operation(++generation, nativeRequest, new TaskCompletionSource<MotionResult>(TaskCreationOptions.RunContinuationsAsynchronously));
        active = operation;
        request = new(nativeRequest, MotionOrigin.Animation, operation.Id) { Target = target };
        Emit("requested", request);
        return operation.Completion.Task;
    }

    public void SnapTo(float value)
    {
        CheckAccess();
        ValidatePosition(value);
        request = new(tracker.TryUpdatePosition(Coordinates(value * coordinateScale)), MotionOrigin.Snap);
        Finish(MotionEnd.Stopped, "snap");
        Emit("requested", request);
    }

    public void Stop()
    {
        CheckAccess();
        request = new(tracker.TryUpdatePositionBy(Vector3.Zero), MotionOrigin.Stop);
        Finish(MotionEnd.Stopped, "stopped");
        Emit("requested", request);
    }

    public void Dispose()
    {
        if (disposed) return;
        CheckAccess();
        disposed = true;
        Finish(MotionEnd.Stopped, "disposed");
        foreach (var input in inputs.ToArray()) input.Dispose();
        foreach (var binding in bindings.ToArray()) binding.Dispose();
        tracker.Dispose();
        modifier.Dispose();
        condition.Dispose();
        force.Dispose();
        settings.Dispose();
        Observed = null;
    }

    private void CheckAccess()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!dispatcher.HasThreadAccess) throw new InvalidOperationException("Вызов должен остаться на потоке владельца.");
    }

    private void ValidatePosition(float value)
    {
        if (!float.IsFinite(value) || value < minimum || value > maximum)
            throw new ArgumentOutOfRangeException(nameof(value));
    }

    private (float Frequency, float Stiffness) ValidateTarget(float target, Spring parameters)
    {
        ValidatePosition(target);
        if (!float.IsFinite(parameters.ResponseMilliseconds) || parameters.ResponseMilliseconds <= 0
            || !float.IsFinite(parameters.Bounce) || parameters.Bounce < 0 || parameters.Bounce >= 1)
            throw new ArgumentOutOfRangeException(nameof(parameters));
        var frequency = (float)(2 * Math.PI * 1000 / parameters.ResponseMilliseconds);
        var stiffness = frequency * frequency;
        if (!float.IsFinite(stiffness) || stiffness <= 0)
            throw new ArgumentOutOfRangeException(nameof(parameters));
        return (frequency, stiffness);
    }

    private void Configure(float target, Spring parameters, (float Frequency, float Stiffness) coefficients)
    {
        // Параметризация владельца src/motion/model.ts; интегрирование выполняет Composition.
        settings.InsertScalar("Target", target * coordinateScale);
        settings.InsertScalar("Stiffness", coefficients.Stiffness);
        settings.InsertScalar("Damping", 2 * (1 - parameters.Bounce) * coefficients.Frequency);
        configured = true;
    }

    private float Coordinate(Vector3 value) => axis == ScalarAxis.X ? value.X : value.Y;
    private Vector3 Coordinates(float value) => axis == ScalarAxis.X ? new(value, 0, 0) : new(0, value, 0);

    private void Emit(string kind, Request source, Vector3? velocity = null, Vector3? eventPosition = null)
    {
        if (disposed || source.Origin == MotionOrigin.Input && inputs.Count == 0) return;
        var readback = tracker.Position;
        var position = eventPosition ?? readback;
        Observed?.Invoke(new(source.Operation, kind, clock.Elapsed.TotalSeconds,
            Coordinate(position) / coordinateScale, velocity is { } v ? Coordinate(v) / coordinateScale : null,
            Coordinate(readback) / coordinateScale)
        {
            Origin = source.Origin, NativeRequestId = source.Id, NativePosition = position,
            NativeReadbackPosition = readback, NativeVelocityVector = velocity,
        });
    }

    private void Finish(MotionEnd end, string reason)
    {
        var operation = active;
        active = null;
        operation?.Completion.TrySetResult(new(operation.Id, end, reason));
    }

    public void ValuesChanged(InteractionTracker sender, InteractionTrackerValuesChangedArgs args)
    {
        if (disposed) return;
        if (args.RequestId == 0 && interacting) Emit("value", new(0, MotionOrigin.Input), eventPosition: args.Position);
        else if (args.RequestId == request?.Id) Emit("value", request, eventPosition: args.Position);
    }
    public void InertiaStateEntered(InteractionTracker sender, InteractionTrackerInertiaStateEnteredArgs args)
    {
        if (disposed) return;
        if (args.RequestId == 0 && interacting)
        {
            phase = "inertia";
            Emit(phase, new(0, MotionOrigin.Input), args.PositionVelocityInPixelsPerSecond);
            return;
        }
        if (args.RequestId != request?.Id) return;
        phase = "inertia";
        interacting = false;
        Emit(phase, request, args.PositionVelocityInPixelsPerSecond);
    }
    public void IdleStateEntered(InteractionTracker sender, InteractionTrackerIdleStateEnteredArgs args)
    {
        if (disposed) return;
        if (args.RequestId == 0 && interacting)
        {
            phase = "idle";
            interacting = false;
            Emit(phase, new(0, MotionOrigin.Input), Vector3.Zero);
            return;
        }
        if (args.RequestId != request?.Id) return;
        phase = "idle";
        interacting = false;
        var source = request;
        if (source.Target is { } target)
        {
            var position = Coordinate(tracker.Position) / coordinateScale;
            if (!float.IsFinite(position) || Math.Abs(position - target) > endpointAccuracy)
            {
                if (!source.IdleHandoffUsed)
                {
                    // A request ID can be acknowledged by the end of the previous bounded
                    // correction without admitting the new motion. Resume once from actual
                    // native Idle, whose velocity is zero, preserving the logical intent.
                    var handoff = source with { IdleHandoffUsed = true };
                    request = handoff;
                    int nextRequest;
                    try
                    {
                        nextRequest = tracker.TryUpdatePositionWithAdditionalVelocity(Vector3.Zero);
                    }
                    catch (Exception error) { FailContinuation(handoff, error); return; }
                    if (!ReferenceEquals(request, handoff)) return;
                    request = handoff with { Id = nextRequest };
                    if (active?.Request == source.Id) active = active with { Request = nextRequest };
                    Emit("requested", request);
                    return;
                }
                FailContinuation(source, new InvalidOperationException("Нативное движение завершилось вне заданной точности цели."));
                return;
            }
        }
        request = null;
        // Observer может начать новое движение; результат завершённого уже окончателен.
        if (args.RequestId == active?.Request) Finish(MotionEnd.Finished, "settled");
        Emit(phase, source, Vector3.Zero);
    }

    private void FailContinuation(Request source, Exception error)
    {
        if (!ReferenceEquals(request, source)) return;
        request = null;
        if (active?.Request == source.Id)
        {
            var operation = active;
            active = null;
            operation.Completion.TrySetException(error);
        }
        Emit("continuation-failed", source, Vector3.Zero);
    }
    public void InteractingStateEntered(InteractionTracker sender, InteractionTrackerInteractingStateEnteredArgs args)
    {
        if (disposed) return;
        phase = "interacting";
        interacting = true;
        Finish(MotionEnd.Stopped, "interaction");
        request = null;
        Emit(phase, new(0, MotionOrigin.Input));
    }
    public void CustomAnimationStateEntered(InteractionTracker sender, InteractionTrackerCustomAnimationStateEnteredArgs args)
    {
        if (disposed || args.RequestId != request?.Id) return;
        phase = "custom";
        interacting = false;
        Emit(phase, request);
    }
    public void RequestIgnored(InteractionTracker sender, InteractionTrackerRequestIgnoredArgs args)
    {
        if (disposed || args.RequestId != request?.Id) return;
        var source = request;
        request = null;
        if (args.RequestId == active?.Request)
        {
            active.Completion.TrySetException(new InvalidOperationException("Нативный исполнитель отклонил запрос движения."));
            active = null;
        }
        Emit("ignored", source);
    }
}
