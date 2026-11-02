using System.Numerics;

// Подменяется только native-граница. ScalarMotion компилируется без изменений.
namespace Microsoft.UI.Dispatching
{
    public sealed class DispatcherQueue
    {
        public static DispatcherQueue GetForCurrentThread() => new();
        public bool HasThreadAccess => true;
    }
}

namespace Microsoft.UI.Composition
{
    public sealed class Compositor
    {
        public List<CompositionPropertySet> PropertySets { get; } = [];
        public CompositionPropertySet CreatePropertySet()
        {
            var properties = new CompositionPropertySet();
            PropertySets.Add(properties);
            return properties;
        }
        public ExpressionAnimation CreateExpressionAnimation(string expression) => new();
    }
    public sealed class CompositionPropertySet : IDisposable
    {
        public Dictionary<string, float> Scalars { get; } = [];
        public void InsertScalar(string name, float value) => Scalars[name] = value;
        public void Dispose() { }
    }
    public sealed class ExpressionAnimation : IDisposable
    {
        public void SetReferenceParameter(string name, object value) { }
        public void Dispose() { }
    }
    public sealed class Visual
    {
        public void StartAnimation(string name, ExpressionAnimation animation) { }
        public void StopAnimation(string name) { }
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
        public static InteractionTracker CreateWithOwner(Compositor compositor, IInteractionTrackerOwner owner)
            => LastCreated = new() { Compositor = compositor };
        public void ConfigurePositionXInertiaModifiers(InteractionTrackerInertiaMotion[] modifiers) { }
        public int TryUpdatePosition(Vector3 value) { Position = value; return ++LastRequest; }
        public int TryUpdatePositionBy(Vector3 value) { Position += value; return ++LastRequest; }
        public int TryUpdatePositionWithAdditionalVelocity(Vector3 value) => ++LastRequest;
        public void Dispose() { }
    }
    public sealed class InteractionTrackerInertiaMotion : IDisposable
    {
        public ExpressionAnimation Condition { get; set; } = null!;
        public ExpressionAnimation Motion { get; set; } = null!;
        public static InteractionTrackerInertiaMotion Create(Compositor compositor) => new();
        public void Dispose() { }
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
