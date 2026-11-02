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
    private Operation? active;
    private long generation;
    private bool disposed;
    private string phase = "idle";
    private readonly List<(Visual Visual, ExpressionAnimation Expression)> bindings = [];

    public event Action<MotionObservation>? Observed;
    public float Position { get { CheckAccess(); return tracker.Position.X; } }

    /// <summary>Привязка выполняется композитором: UI не пересчитывает кадры движения.</summary>
    public void BindOffsetX(Visual visual)
    {
        CheckAccess();
        var expression = tracker.Compositor.CreateExpressionAnimation("motion.Position.X");
        expression.SetReferenceParameter("motion", tracker);
        visual.StartAnimation("Offset.X", expression);
        bindings.Add((visual, expression));
    }

    public ScalarMotion(Compositor compositor, float minimum, float maximum, float initial = 0)
    {
        dispatcher = DispatcherQueue.GetForCurrentThread()
            ?? throw new InvalidOperationException("Нужен поток с DispatcherQueue.");
        if (!float.IsFinite(minimum) || !float.IsFinite(maximum) || minimum >= maximum)
            throw new ArgumentOutOfRangeException(nameof(minimum));
        this.minimum = minimum;
        this.maximum = maximum;
        ValidatePosition(initial);
        tracker = InteractionTracker.CreateWithOwner(compositor, this);
        tracker.MinPosition = new Vector3(minimum, 0, 0);
        tracker.MaxPosition = new Vector3(maximum, 0, 0);
        settings = compositor.CreatePropertySet();
        settings.InsertScalar("Target", initial);
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
        tracker.TryUpdatePosition(new Vector3(initial, 0, 0));
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
        var stiffness = frequency * frequency;
        if (!float.IsFinite(stiffness) || stiffness <= 0)
            throw new ArgumentOutOfRangeException(nameof(parameters));
        if (initialVelocity is { } velocity && (!float.IsFinite(velocity) || phase != "idle" || active is not null))
            throw new ArgumentException("Начальная скорость задаётся только из покоя.", nameof(initialVelocity));
        // Параметризация владельца src/motion/model.ts; интегрирование выполняет Composition.
        settings.InsertScalar("Target", target);
        settings.InsertScalar("Stiffness", stiffness);
        settings.InsertScalar("Damping", 2 * (1 - parameters.Bounce) * frequency);
        var request = tracker.TryUpdatePositionWithAdditionalVelocity(new Vector3(initialVelocity ?? 0, 0, 0));
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
        tracker.TryUpdatePosition(new Vector3(value, 0, 0));
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
        foreach (var (visual, expression) in bindings)
        {
            visual.StopAnimation("Offset.X");
            expression.Dispose();
        }
        bindings.Clear();
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
        if (!disposed) Observed?.Invoke(new(active?.Id ?? generation, kind, clock.Elapsed.TotalSeconds, eventPosition ?? tracker.Position.X, velocity, tracker.Position.X));
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
