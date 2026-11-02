using System.Diagnostics;
using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;
using Microsoft.UI.Dispatching;

namespace LabMotion.WinUI;

public readonly record struct Spring(float ResponseMilliseconds, float Bounce);
public enum MotionEnd { Finished, Stopped }
public readonly record struct MotionResult(long Operation, MotionEnd End, string Reason);
public readonly record struct MotionObservation(
    long Operation, string Phase, double Seconds, float Position, float? NativeVelocity, float ReadbackPosition);

/// <summary>Экспериментальный канал координаты. Скорость — в единицах координаты в секунду.</summary>
public sealed class ScalarMotion : IInteractionTrackerOwner, IDisposable
{
    private sealed record Operation(long Id, int Request, TaskCompletionSource<MotionResult> Completion);
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
    private Operation? active;
    private long generation;
    private bool disposed;
    private string phase = "idle";
    private readonly HashSet<ScalarBinding> bindings = [];

    public event Action<MotionObservation>? Observed;
    public float Position { get { CheckAccess(); return tracker.Position.X / coordinateScale; } }

    /// <summary>Привязка выполняется композитором: UI не пересчитывает кадры движения.</summary>
    public IDisposable BindOffsetX(Visual visual) => Bind(visual, ScalarProperty.OffsetX);

    /// <summary>Проецирует координату как position × multiplier + offset до освобождения привязки.</summary>
    public IDisposable Bind(Visual visual, ScalarProperty property, float multiplier = 1, float offset = 0)
    {
        CheckAccess();
        var binding = ScalarBinding.Create(dispatcher, tracker, visual, property, coordinateScale, multiplier, offset,
            released => bindings.Remove(released));
        bindings.Add(binding);
        return binding;
    }

    /// <summary>Безразмерный канал 0…1; скорость задаётся в единицах progress в секунду.</summary>
    public static ScalarMotion CreateProgress(Compositor compositor, float initial = 0)
        // Размах 1000 квалифицирован для точности progress; интегратор остаётся системным.
        => new(compositor, 0, 1, initial, 1000);

    public ScalarMotion(Compositor compositor, float minimum, float maximum, float initial = 0)
        : this(compositor, minimum, maximum, initial, 1) { }

    private ScalarMotion(Compositor compositor, float minimum, float maximum, float initial, float coordinateScale)
    {
        dispatcher = DispatcherQueue.GetForCurrentThread()
            ?? throw new InvalidOperationException("Нужен поток с DispatcherQueue.");
        if (!float.IsFinite(minimum) || !float.IsFinite(maximum) || minimum >= maximum)
            throw new ArgumentOutOfRangeException(nameof(minimum));
        this.minimum = minimum;
        this.maximum = maximum;
        this.coordinateScale = coordinateScale;
        ValidatePosition(initial);
        tracker = InteractionTracker.CreateWithOwner(compositor, this);
        tracker.MinPosition = new Vector3(minimum * coordinateScale, 0, 0);
        tracker.MaxPosition = new Vector3(maximum * coordinateScale, 0, 0);
        settings = compositor.CreatePropertySet();
        settings.InsertScalar("Target", initial * coordinateScale);
        settings.InsertScalar("Stiffness", 1);
        settings.InsertScalar("Damping", 1);
        condition = compositor.CreateExpressionAnimation("true");
        force = compositor.CreateExpressionAnimation(
            "-settings.Stiffness * (this.Target.Position.X - settings.Target) - settings.Damping * this.Target.PositionVelocityInPixelsPerSecond.X");
        force.SetReferenceParameter("settings", settings);
        modifier = InteractionTrackerInertiaMotion.Create(compositor);
        modifier.Condition = condition;
        modifier.Motion = force;
        tracker.ConfigurePositionXInertiaModifiers(new[] { modifier });
        tracker.TryUpdatePosition(new Vector3(initial * coordinateScale, 0, 0));
    }

    /// <summary>Новая цель сохраняет текущую native-скорость; initialVelocity допустима из покоя.</summary>
    public Task<MotionResult> AnimateTo(float target, Spring parameters, float? initialVelocity = null)
    {
        CheckAccess();
        ValidatePosition(target);
        if (!float.IsFinite(parameters.ResponseMilliseconds) || parameters.ResponseMilliseconds <= 0
            || !float.IsFinite(parameters.Bounce) || parameters.Bounce < 0 || parameters.Bounce >= 1)
            throw new ArgumentOutOfRangeException(nameof(parameters));
        var frequency = (float)(2 * Math.PI * 1000 / parameters.ResponseMilliseconds);
        if (!float.IsFinite(frequency * frequency) || frequency == 0)
            throw new ArgumentOutOfRangeException(nameof(parameters));
        if (initialVelocity is { } velocity)
        {
            if (!float.IsFinite(velocity * coordinateScale))
                throw new ArgumentOutOfRangeException(nameof(initialVelocity), "Скорость должна быть конечной в координатах исполнителя.");
            if (phase != "idle" || active is not null)
                throw new ArgumentException("Начальная скорость задаётся только из покоя.", nameof(initialVelocity));
        }
        // Параметризация владельца src/motion/model.ts; интегрирование выполняет Composition.
        settings.InsertScalar("Target", target * coordinateScale);
        settings.InsertScalar("Stiffness", frequency * frequency);
        settings.InsertScalar("Damping", 2 * (1 - parameters.Bounce) * frequency);
        var request = tracker.TryUpdatePositionWithAdditionalVelocity(new Vector3((initialVelocity ?? 0) * coordinateScale, 0, 0));
        Finish(MotionEnd.Stopped, "replaced");
        var operation = new Operation(++generation, request, new TaskCompletionSource<MotionResult>(TaskCreationOptions.RunContinuationsAsynchronously));
        active = operation;
        Emit("requested", null);
        return operation.Completion.Task;
    }

    public void SnapTo(float value)
    {
        CheckAccess();
        ValidatePosition(value);
        tracker.TryUpdatePosition(new Vector3(value * coordinateScale, 0, 0));
        Finish(MotionEnd.Stopped, "snap");
    }

    public void Stop()
    {
        CheckAccess();
        tracker.TryUpdatePositionBy(Vector3.Zero);
        Finish(MotionEnd.Stopped, "stopped");
    }

    public void Dispose()
    {
        if (disposed) return;
        CheckAccess();
        disposed = true;
        Finish(MotionEnd.Stopped, "disposed");
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

    private void Emit(string kind, float? velocity, float? eventPosition = null)
    {
        if (!disposed) Observed?.Invoke(new(active?.Id ?? generation, kind, clock.Elapsed.TotalSeconds,
            (eventPosition ?? tracker.Position.X) / coordinateScale, velocity / coordinateScale, tracker.Position.X / coordinateScale));
    }

    private void Finish(MotionEnd end, string reason)
    {
        var operation = active;
        active = null;
        operation?.Completion.TrySetResult(new(operation.Id, end, reason));
    }

    public void ValuesChanged(InteractionTracker sender, InteractionTrackerValuesChangedArgs args)
    {
        if (args.RequestId == active?.Request) Emit("value", null, args.Position.X);
    }
    public void InertiaStateEntered(InteractionTracker sender, InteractionTrackerInertiaStateEnteredArgs args)
    {
        if (disposed || args.RequestId != active?.Request) return;
        phase = "inertia";
        Emit(phase, args.PositionVelocityInPixelsPerSecond.X);
    }
    public void IdleStateEntered(InteractionTracker sender, InteractionTrackerIdleStateEnteredArgs args)
    {
        if (disposed || active is not null && args.RequestId != active.Request) return;
        phase = "idle";
        // Observer может начать новое движение; результат завершённого уже окончателен.
        if (args.RequestId == active?.Request) Finish(MotionEnd.Finished, "settled");
        Emit(phase, 0);
    }
    public void InteractingStateEntered(InteractionTracker sender, InteractionTrackerInteractingStateEnteredArgs args)
    {
        if (disposed) return;
        phase = "interacting";
        Finish(MotionEnd.Stopped, "interaction");
        Emit(phase, null);
    }
    public void CustomAnimationStateEntered(InteractionTracker sender, InteractionTrackerCustomAnimationStateEnteredArgs args) => Emit("custom", null);
    public void RequestIgnored(InteractionTracker sender, InteractionTrackerRequestIgnoredArgs args)
    {
        if (disposed || args.RequestId != active?.Request) return;
        active.Completion.TrySetException(new InvalidOperationException("Нативный исполнитель отклонил запрос движения."));
        active = null;
        Emit("ignored", null);
    }
}
