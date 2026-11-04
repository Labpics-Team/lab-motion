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

    // Временный private trace для закреплённого Space-опыта. Удалить вместе с diagnostic pin
    // после различающего hosted результата; это не публичная возможность продукта.
    private RawTraceBuffer? rawTrace;
    private enum RawKind { Values, Inertia, Idle, Interacting, Custom, Ignored }
    private enum RawDisposition { Pending, Disposed, Input, Request, Mismatch, Unconditional }
    private enum RawPhase { Idle, Inertia, Interacting, Custom, Unknown }
    private readonly record struct RawVector(float? X, float? Y, float? Z)
    {
        internal static RawVector From(Vector3 value) => new(
            float.IsFinite(value.X) ? value.X : null, float.IsFinite(value.Y) ? value.Y : null,
            float.IsFinite(value.Z) ? value.Z : null);
    }
    private readonly record struct RawState(int? RequestId, MotionOrigin? RequestOrigin, long? RequestOperation,
        int? ActiveRequest, long? ActiveOperation, bool Disposed, bool Interacting, RawPhase Phase);
    private readonly record struct RawRecord(long Sequence, long Timestamp, int ThreadId, RawKind Kind,
        RawState Before, int? IncomingRequestId = null, RawVector? Position = null, RawVector? Velocity = null,
        RawDisposition Disposition = RawDisposition.Pending);
    private readonly record struct RawCount(RawKind Kind, RawDisposition Disposition, long Count);
    private readonly record struct RawTerminal(RawKind Kind, RawDisposition Disposition, RawRecord First, RawRecord Last);
    private sealed record RawTraceSnapshot(int SchemaVersion, int ProcessId, long StartedTicks, long EndedTicks,
        long Frequency, int OwnerThreadId, bool Stopped, long CallbackCount, long CompletedCount, long OtherThreadCount,
        bool CountersComplete, bool RecordsTruncated, long DroppedRecords, RawState Initial,
        RawRecord[] Records, RawCount[] Counts, RawTerminal[] Terminals);

    private RawState RawPreState() => new(request?.Id, request?.Origin, request?.Operation, active?.Request, active?.Id,
        disposed, interacting, phase switch { "idle" => RawPhase.Idle, "inertia" => RawPhase.Inertia,
            "interacting" => RawPhase.Interacting, "custom" => RawPhase.Custom, _ => RawPhase.Unknown });
    private void BeginRawTrace()
    {
        CheckAccess();
        rawTrace = new(RawPreState());
    }
    private RawTraceSnapshot CaptureRawTrace(bool stop)
    {
        // Managed readback допустим и после Dispose: tracker и args здесь не читаются.
        if (!dispatcher.HasThreadAccess) throw new InvalidOperationException("Trace читается на потоке владельца.");
        return (rawTrace ?? throw new InvalidOperationException("Raw trace не включён.")).Snapshot(stop);
    }

    private sealed class RawTraceBuffer(RawState initial)
    {
        private const int FirstCapacity = 8, LastCapacity = 16, Dispositions = 6;
        private readonly object gate = new();
        private readonly long started = Stopwatch.GetTimestamp();
        private readonly int ownerThread = Environment.CurrentManagedThreadId;
        private readonly RawRecord?[] first = new RawRecord?[FirstCapacity];
        private readonly RawRecord?[] last = new RawRecord?[LastCapacity];
        private readonly long[] counts = new long[6 * Dispositions];
        private readonly RawTerminal?[] terminals = new RawTerminal?[6 * Dispositions];
        private long callbacks, completed, otherThreads;
        private long? ended;

        internal RawRecord Enter(ScalarMotion motion, RawKind kind)
        {
            lock (gate)
            {
                if (ended is not null) return default;
                var row = new RawRecord(++callbacks, Stopwatch.GetTimestamp(), Environment.CurrentManagedThreadId, kind, motion.RawPreState());
                if (row.ThreadId != ownerThread) otherThreads++;
                counts[(int)kind * Dispositions]++;
                if (row.Sequence <= FirstCapacity) first[(int)row.Sequence - 1] = row;
                last[(int)((row.Sequence - 1) % LastCapacity)] = row;
                return row;
            }
        }

        internal void Complete(RawRecord row, RawDisposition disposition)
        {
            if (row.Sequence == 0) return;
            lock (gate)
            {
                row = row with { Disposition = disposition };
                counts[(int)row.Kind * Dispositions]--;
                var index = (int)row.Kind * Dispositions + (int)disposition;
                counts[index]++;
                completed++;
                if (row.Sequence <= FirstCapacity) first[(int)row.Sequence - 1] = row;
                var slot = (int)((row.Sequence - 1) % LastCapacity);
                if (last[slot]?.Sequence == row.Sequence) last[slot] = row;
                if (row.Kind is RawKind.Idle or RawKind.Ignored)
                {
                    var previous = terminals[index];
                    terminals[index] = new(row.Kind, disposition,
                        previous is { } earliest && earliest.First.Sequence < row.Sequence ? earliest.First : row,
                        previous is { } latest && latest.Last.Sequence > row.Sequence ? latest.Last : row);
                }
            }
        }

        internal RawTraceSnapshot Snapshot(bool stop)
        {
            lock (gate)
            {
                if (stop) ended ??= Stopwatch.GetTimestamp();
                var records = first.Concat(last.Where(row => row?.Sequence > FirstCapacity))
                    .Where(row => row.HasValue).Select(row => row!.Value).OrderBy(row => row.Sequence).ToArray();
                return new(1, Environment.ProcessId, started, ended ?? Stopwatch.GetTimestamp(), Stopwatch.Frequency,
                    ownerThread, ended is not null, callbacks, completed, otherThreads, callbacks == completed,
                    callbacks > records.Length, callbacks - records.Length, initial, records,
                    counts.Select((count, index) => new RawCount((RawKind)(index / Dispositions),
                        (RawDisposition)(index % Dispositions), count)).ToArray(),
                    terminals.Where(row => row.HasValue).Select(row => row!.Value).ToArray());
            }
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
        var trace = rawTrace;
        var entry = trace?.Enter(this, RawKind.Values) ?? default;
        if (disposed) { trace?.Complete(entry, RawDisposition.Disposed); return; }
        if (entry.Sequence != 0) entry = entry with { IncomingRequestId = args.RequestId, Position = RawVector.From(args.Position) };
        if (args.RequestId == 0 && interacting)
        {
            trace?.Complete(entry, RawDisposition.Input);
            Emit("value", new(0, MotionOrigin.Input), eventPosition: args.Position);
        }
        else if (args.RequestId == request?.Id)
        {
            trace?.Complete(entry, RawDisposition.Request);
            Emit("value", request, eventPosition: args.Position);
        }
        else trace?.Complete(entry, RawDisposition.Mismatch);
    }
    public void InertiaStateEntered(InteractionTracker sender, InteractionTrackerInertiaStateEnteredArgs args)
    {
        var trace = rawTrace;
        var entry = trace?.Enter(this, RawKind.Inertia) ?? default;
        if (disposed) { trace?.Complete(entry, RawDisposition.Disposed); return; }
        if (entry.Sequence != 0) entry = entry with { IncomingRequestId = args.RequestId, Velocity = RawVector.From(args.PositionVelocityInPixelsPerSecond) };
        if (args.RequestId == 0 && interacting)
        {
            trace?.Complete(entry, RawDisposition.Input);
            phase = "inertia";
            Emit(phase, new(0, MotionOrigin.Input), args.PositionVelocityInPixelsPerSecond);
            return;
        }
        if (args.RequestId != request?.Id) { trace?.Complete(entry, RawDisposition.Mismatch); return; }
        trace?.Complete(entry, RawDisposition.Request);
        phase = "inertia";
        interacting = false;
        Emit(phase, request, args.PositionVelocityInPixelsPerSecond);
    }
    public void IdleStateEntered(InteractionTracker sender, InteractionTrackerIdleStateEnteredArgs args)
    {
        var trace = rawTrace;
        var entry = trace?.Enter(this, RawKind.Idle) ?? default;
        if (disposed) { trace?.Complete(entry, RawDisposition.Disposed); return; }
        if (entry.Sequence != 0) entry = entry with { IncomingRequestId = args.RequestId };
        if (args.RequestId == 0 && interacting)
        {
            trace?.Complete(entry, RawDisposition.Input);
            phase = "idle";
            interacting = false;
            Emit(phase, new(0, MotionOrigin.Input), Vector3.Zero);
            return;
        }
        if (args.RequestId != request?.Id) { trace?.Complete(entry, RawDisposition.Mismatch); return; }
        trace?.Complete(entry, RawDisposition.Request);
        phase = "idle";
        interacting = false;
        var source = request;
        // Observer может начать новое движение; результат завершённого уже окончателен.
        if (args.RequestId == active?.Request) Finish(MotionEnd.Finished, "settled");
        Emit(phase, source, Vector3.Zero);
    }
    public void InteractingStateEntered(InteractionTracker sender, InteractionTrackerInteractingStateEnteredArgs args)
    {
        var trace = rawTrace;
        var entry = trace?.Enter(this, RawKind.Interacting) ?? default;
        if (disposed) { trace?.Complete(entry, RawDisposition.Disposed); return; }
        if (entry.Sequence != 0) entry = entry with { IncomingRequestId = args.RequestId };
        trace?.Complete(entry, RawDisposition.Unconditional);
        phase = "interacting";
        interacting = true;
        Finish(MotionEnd.Stopped, "interaction");
        request = null;
        Emit(phase, new(0, MotionOrigin.Input));
    }
    public void CustomAnimationStateEntered(InteractionTracker sender, InteractionTrackerCustomAnimationStateEnteredArgs args)
    {
        var trace = rawTrace;
        var entry = trace?.Enter(this, RawKind.Custom) ?? default;
        if (disposed) { trace?.Complete(entry, RawDisposition.Disposed); return; }
        if (entry.Sequence != 0) entry = entry with { IncomingRequestId = args.RequestId };
        if (args.RequestId != request?.Id) { trace?.Complete(entry, RawDisposition.Mismatch); return; }
        trace?.Complete(entry, RawDisposition.Request);
        phase = "custom";
        interacting = false;
        Emit(phase, request);
    }
    public void RequestIgnored(InteractionTracker sender, InteractionTrackerRequestIgnoredArgs args)
    {
        var trace = rawTrace;
        var entry = trace?.Enter(this, RawKind.Ignored) ?? default;
        if (disposed) { trace?.Complete(entry, RawDisposition.Disposed); return; }
        if (entry.Sequence != 0) entry = entry with { IncomingRequestId = args.RequestId };
        if (args.RequestId != request?.Id) { trace?.Complete(entry, RawDisposition.Mismatch); return; }
        trace?.Complete(entry, RawDisposition.Request);
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
