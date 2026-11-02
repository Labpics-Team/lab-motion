using System.Runtime.CompilerServices;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;
using Microsoft.UI.Dispatching;

namespace LabMotion.WinUI;

public enum ScalarProperty { OffsetX, OffsetY, Opacity }

internal sealed class ScalarBinding : IDisposable
{
    private static readonly ConditionalWeakTable<Visual, Dictionary<ScalarProperty, ScalarBinding>> Owners = new();
    private readonly DispatcherQueue dispatcher;
    private readonly Visual visual;
    private readonly ScalarProperty property;
    private readonly string path;
    private readonly ExpressionAnimation expression;
    private readonly Dictionary<ScalarProperty, ScalarBinding> owners;
    private readonly Action<ScalarBinding> released;
    private bool disposed;

    private ScalarBinding(DispatcherQueue dispatcher, Visual visual, ScalarProperty property, string path,
        ExpressionAnimation expression, Dictionary<ScalarProperty, ScalarBinding> owners, Action<ScalarBinding> released)
    {
        this.dispatcher = dispatcher;
        this.visual = visual;
        this.property = property;
        this.path = path;
        this.expression = expression;
        this.owners = owners;
        this.released = released;
    }

    internal static ScalarBinding Create(DispatcherQueue dispatcher, InteractionTracker tracker, Visual visual,
        ScalarProperty property, ScalarAxis axis, float coordinateScale, float multiplier, float offset, Action<ScalarBinding> released)
    {
        ArgumentNullException.ThrowIfNull(visual);
        var path = property switch
        {
            ScalarProperty.OffsetX => "Offset.X",
            ScalarProperty.OffsetY => "Offset.Y",
            ScalarProperty.Opacity => "Opacity",
            _ => throw new ArgumentOutOfRangeException(nameof(property)),
        };
        if (!float.IsFinite(multiplier)) throw new ArgumentOutOfRangeException(nameof(multiplier));
        if (!float.IsFinite(offset)) throw new ArgumentOutOfRangeException(nameof(offset));
        if (!visual.Compositor.Equals(tracker.Compositor))
            throw new ArgumentException("Привязка требует один Compositor.", nameof(visual));

        var owners = Owners.GetOrCreateValue(visual);
        lock (owners)
        {
            owners.TryGetValue(property, out var previous);
            previous?.CheckAccess();
            var expression = tracker.Compositor.CreateExpressionAnimation($"motion.Position.{axis} / coordinateScale * multiplier + offset");
            try
            {
                expression.SetReferenceParameter("motion", tracker);
                expression.SetScalarParameter("coordinateScale", coordinateScale);
                expression.SetScalarParameter("multiplier", multiplier);
                expression.SetScalarParameter("offset", offset);
                visual.StartAnimation(path, expression);
            }
            catch
            {
                expression.Dispose();
                throw;
            }
            var binding = new ScalarBinding(dispatcher, visual, property, path, expression, owners, released);
            owners[property] = binding;
            // StartAnimation уже заменил выражение: прежний владелец больше не останавливает свойство.
            previous?.Release();
            return binding;
        }
    }

    public void Dispose()
    {
        lock (owners)
        {
            if (disposed) return;
            CheckAccess();
            try
            {
                if (owners.TryGetValue(property, out var owner) && ReferenceEquals(owner, this))
                {
                    owners.Remove(property);
                    visual.StopAnimation(path);
                }
            }
            finally { Release(); }
        }
    }

    private void CheckAccess()
    {
        if (!dispatcher.HasThreadAccess) throw new InvalidOperationException("Привязка принадлежит потоку владельца.");
    }

    private void Release()
    {
        disposed = true;
        try { expression.Dispose(); }
        finally { released(this); }
    }
}
