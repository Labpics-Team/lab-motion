using System.Numerics;
using Microsoft.UI.Composition.Interactions;

// Подменяется только native-граница. ScalarMotion компилируется без изменений.
namespace Microsoft.UI.Dispatching
{
    public sealed class DispatcherQueue
    {
        private readonly int owner = Environment.CurrentManagedThreadId;
        [ThreadStatic] private static DispatcherQueue? current;
        public static DispatcherQueue GetForCurrentThread() => current ??= new();
        public bool HasThreadAccess => owner == Environment.CurrentManagedThreadId;
    }
}

namespace Microsoft.UI.Composition
{
    public sealed class Compositor
    {
        public List<ExpressionAnimation> Expressions { get; } = [];
        public List<CompositionPropertySet> PropertySets { get; } = [];
        public List<InteractionTrackerInertiaMotion> Modifiers { get; } = [];
        public CompositionPropertySet CreatePropertySet()
        {
            var properties = new CompositionPropertySet();
            PropertySets.Add(properties);
            return properties;
        }
        public ExpressionAnimation CreateExpressionAnimation(string expression)
        {
            var animation = new ExpressionAnimation(expression);
            Expressions.Add(animation);
            return animation;
        }
        public Visual CreateSpriteVisual() => new(this);
    }
    public sealed class CompositionPropertySet : IDisposable
    {
        public Dictionary<string, float> Scalars { get; } = [];
        public void InsertScalar(string name, float value) => Scalars[name] = value;
        public int DisposeCount { get; private set; }
        public Exception? DisposeFailure { get; set; }
        public void Dispose()
        {
            DisposeCount++;
            if (DisposeFailure is { } error) throw error;
        }
    }
    public sealed class ExpressionAnimation : IDisposable
    {
        public ExpressionAnimation(string expression) => Expression = expression;
        public string Expression { get; }
        public Dictionary<string, object> References { get; } = [];
        public Dictionary<string, float> Scalars { get; } = [];
        public int DisposeCount { get; private set; }
        public Exception? DisposeFailure { get; set; }
        public void SetReferenceParameter(string name, object value) => References[name] = value;
        public void SetScalarParameter(string name, float value) => Scalars[name] = value;
        public void Dispose()
        {
            DisposeCount++;
            if (DisposeFailure is { } error) throw error;
        }
    }
    // StartAnimation копирует параметры; закрытие исходного ExpressionAnimation
    // не останавливает установленную анимацию. Выражение здесь не вычисляется.
    public sealed record AnimationRecord(ExpressionAnimation Source, string Expression,
        Dictionary<string, object> References, Dictionary<string, float> Scalars);
    public sealed class Visual
    {
        public Visual(Compositor compositor) => Compositor = compositor;
        public Compositor Compositor { get; }
        public Dictionary<string, AnimationRecord> Animations { get; } = [];
        public int StartAttempts { get; private set; }
        public int Starts { get; private set; }
        public int Stops { get; private set; }
        public bool FailNextStart { get; set; }
        public Exception? StopFailure { get; set; }
        public Action? OnStop { get; set; }
        public void StartAnimation(string name, ExpressionAnimation animation)
        {
            StartAttempts++;
            if (FailNextStart)
            {
                FailNextStart = false;
                throw new InvalidOperationException("Отклонение native StartAnimation до замены.");
            }
            Animations[name] = new(animation, animation.Expression,
                new(animation.References), new(animation.Scalars));
            Starts++;
        }
        public void StopAnimation(string name)
        {
            Stops++;
            OnStop?.Invoke();
            if (StopFailure is { } error) throw error;
            Animations.Remove(name);
        }
    }
}

namespace Microsoft.UI.Composition.Interactions
{
    public interface IInteractionTrackerOwner { }
    public sealed class InteractionTracker : IDisposable
    {
        public static InteractionTracker LastCreated { get; private set; } = null!;
        public Compositor Compositor { get; private set; } = null!;
        public Vector3 MinPosition { get; set; }
        public Vector3 MaxPosition { get; set; }
        public Vector3 Position { get; set; }
        public int LastRequest { get; private set; }
        public Vector3 LastAdditionalVelocity { get; private set; }
        public int DisposeCount { get; private set; }
        public Exception? DisposeFailure { get; set; }
        public Action? OnDispose { get; set; }
        public static InteractionTracker CreateWithOwner(Compositor compositor, IInteractionTrackerOwner owner)
            => LastCreated = new() { Compositor = compositor };
        public void ConfigurePositionXInertiaModifiers(InteractionTrackerInertiaMotion[] modifiers) { }
        public int TryUpdatePosition(Vector3 value) { Position = value; return ++LastRequest; }
        public int TryUpdatePositionBy(Vector3 value) { Position += value; return ++LastRequest; }
        public int TryUpdatePositionWithAdditionalVelocity(Vector3 value)
        {
            LastAdditionalVelocity = value;
            return ++LastRequest;
        }
        public void Dispose()
        {
            DisposeCount++;
            OnDispose?.Invoke();
            if (DisposeFailure is { } error) throw error;
        }
    }
    public sealed class InteractionTrackerInertiaMotion : IDisposable
    {
        public ExpressionAnimation Condition { get; set; } = null!;
        public ExpressionAnimation Motion { get; set; } = null!;
        public int DisposeCount { get; private set; }
        public Exception? DisposeFailure { get; set; }
        public static InteractionTrackerInertiaMotion Create(Compositor compositor)
        {
            var modifier = new InteractionTrackerInertiaMotion();
            compositor.Modifiers.Add(modifier);
            return modifier;
        }
        public void Dispose()
        {
            DisposeCount++;
            if (DisposeFailure is { } error) throw error;
        }
    }
    public sealed class InteractionTrackerValuesChangedArgs
    {
        public int RequestId { get; init; }
        public Vector3 Position { get; init; }
    }
    public sealed class InteractionTrackerInertiaStateEnteredArgs
    {
        public int RequestId { get; init; }
        public Vector3 PositionVelocityInPixelsPerSecond { get; init; }
    }
    public sealed class InteractionTrackerIdleStateEnteredArgs { public int RequestId { get; init; } }
    public sealed class InteractionTrackerInteractingStateEnteredArgs { }
    public sealed class InteractionTrackerCustomAnimationStateEnteredArgs { }
    public sealed class InteractionTrackerRequestIgnoredArgs { public int RequestId { get; init; } }
}
