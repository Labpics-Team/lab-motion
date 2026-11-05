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
    private sealed record Operation(long Id, int Request, TaskCompletionSource<MotionResult> Completion);
    private sealed record Request(int Id, MotionOrigin Origin, long Operation = 0);
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

    // Временный private witness входящего Idle. Удалить вместе с diagnostic pin после локализации.
    private sealed record IncomingIdleReceipt(long Sequence, long TimestampTicks, int CallbackRequestId,
        int? CurrentRequestId, long? Operation, bool Disposed, bool Interacting, string Disposition);
    private readonly object incomingIdleGate = new();
    private readonly IncomingIdleReceipt?[] incomingIdleReceipts = new IncomingIdleReceipt?[8];
    private long incomingIdleCount;

    private void RecordIncomingIdle(int callbackRequestId, string disposition)
    {
        lock (incomingIdleGate)
        {
            var sequence = ++incomingIdleCount;
            incomingIdleReceipts[(int)((sequence - 1) % incomingIdleReceipts.Length)] = new(
                sequence, Stopwatch.GetTimestamp(), callbackRequestId, request?.Id, request?.Operation,
                disposed, interacting, disposition);
        }
    }

    private object CaptureIncomingIdle()
    {
        // Только managed snapshot: существующий private probe читает его и после Dispose.
        if (!dispatcher.HasThreadAccess) throw new InvalidOperationException("Idle witness читается на потоке владельца.");
        lock (incomingIdleGate)
        {
            var retained = (int)Math.Min(incomingIdleCount, incomingIdleReceipts.Length);
            var receipts = new IncomingIdleReceipt[retained];
            for (var index = 0; index < retained; index++)
                receipts[index] = incomingIdleReceipts[(int)((incomingIdleCount - retained + index) % incomingIdleReceipts.Length)]
                    ?? throw new InvalidOperationException("Idle witness потерял сохранённую запись.");
            return new { schemaVersion = 1, callbackCount = incomingIdleCount,
                capturedTicks = Stopwatch.GetTimestamp(), clockFrequency = Stopwatch.Frequency, receipts };
        }
    }

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
        => new(compositor, ScalarAxis.X, 0, 1, initial, 1000);

    public ScalarMotion(Compositor compositor, float minimum, float maximum, float initial = 0)
        : this(compositor, ScalarAxis.X, minimum, maximum, initial, 1) { }

    public ScalarMotion(Compositor compositor, ScalarAxis axis, float minimum, float maximum, float initial = 0)
        : this(compositor, axis, minimum, maximum, initial, 1) { }

    private ScalarMotion(Compositor compositor, ScalarAxis axis, float minimum, float maximum, float initial, float coordinateScale)
    {
        dispatcher = DispatcherQueue.GetForCurrentThread()
            ?? throw new InvalidOperationException("Нужен поток с DispatcherQueue.");
        if (!float.IsFinite(minimum) || !float.IsFinite(maximum) || minimum >= maximum)
            throw new ArgumentOutOfRangeException(nameof(minimum));
        if (axis is not (ScalarAxis.X or ScalarAxis.Y)) throw new ArgumentOutOfRangeException(nameof(axis));
        this.axis = axis;
        this.minimum = minimum;
        this.maximum = maximum;
        this.coordinateScale = coordinateScale;
        ValidatePosition(initial);
        tracker = InteractionTracker.CreateWithOwner(compositor, this);
        tracker.MinPosition = Coordinates(minimum * coordinateScale);
        tracker.MaxPosition = Coordinates(maximum * coordinateScale);
        settings = compositor.CreatePropertySet();
        settings.InsertScalar("Target", initial * coordinateScale);
        settings.InsertScalar("Stiffness", 1);
        settings.InsertScalar("Damping", 1);
        condition = compositor.CreateExpressionAnimation("true");
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

    /// <summary>Меняет намерение для текущей Inertia и следующего release, не посылая запрос запуска.</summary>
    public void SetTarget(float target, Spring parameters)
    {
        CheckAccess();
        var coefficients = ValidateTarget(target, parameters);
        Finish(MotionEnd.Stopped, "target-changed");
        Configure(target, parameters, coefficients);
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
        request = new(nativeRequest, MotionOrigin.Animation, operation.Id);
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
        if (disposed) { RecordIncomingIdle(args.RequestId, "disposed"); return; }
        if (args.RequestId == 0 && interacting)
        {
            RecordIncomingIdle(args.RequestId, "input");
            phase = "idle";
            interacting = false;
            Emit(phase, new(0, MotionOrigin.Input), Vector3.Zero);
            return;
        }
        if (args.RequestId != request?.Id) { RecordIncomingIdle(args.RequestId, "mismatch"); return; }
        RecordIncomingIdle(args.RequestId, "accepted");
        phase = "idle";
        interacting = false;
        var source = request;
        // Observer может начать новое движение; результат завершённого уже окончателен.
        if (args.RequestId == active?.Request) Finish(MotionEnd.Finished, "settled");
        Emit(phase, source, Vector3.Zero);
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
