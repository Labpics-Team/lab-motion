using System.Runtime.ExceptionServices;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Input;

namespace LabMotion.WinUI;

/// <summary>Ввод от неподвижного viewport; освобождение отключает источник, но не останавливает уже начатую Inertia.</summary>
public sealed class ScalarPan : IDisposable
{
    // Exception.Data["ScalarPan.CleanupFailures"] хранит Exception[] вторичных отказов
    // в порядке попыток; первая ошибка и её исходный stack trace остаются исключением вызова.
    private const string CleanupFailuresKey = "ScalarPan.CleanupFailures";
    private readonly DispatcherQueue dispatcher;
    private readonly InteractionTracker tracker;
    private readonly VisualInteractionSource source;
    private readonly Action<ScalarPan> released;
    private readonly ScalarAxis axis;
    private bool disposed;

    private ScalarPan(DispatcherQueue dispatcher, InteractionTracker tracker,
        VisualInteractionSource source, ScalarAxis axis, Action<ScalarPan> released)
    {
        this.dispatcher = dispatcher;
        this.tracker = tracker;
        this.source = source;
        this.axis = axis;
        this.released = released;
    }

    /// <summary>Фактическая конфигурация источника для диагностики WinUI.</summary>
    public InteractionSourceMode SourceMode
    {
        get { CheckLive(); return axis == ScalarAxis.X ? source.PositionXSourceMode : source.PositionYSourceMode; }
    }
    public VisualInteractionSourceRedirectionMode RedirectionMode
    {
        get { CheckLive(); return source.ManipulationRedirectionMode; }
    }

    internal static ScalarPan Create(DispatcherQueue dispatcher, InteractionTracker tracker,
        Visual viewport, ScalarAxis axis, Action<ScalarPan> released)
    {
        ArgumentNullException.ThrowIfNull(viewport);
        if (!viewport.Compositor.Equals(tracker.Compositor))
            throw new ArgumentException("Источник ввода требует один Compositor.", nameof(viewport));
        var source = VisualInteractionSource.Create(viewport);
        try
        {
            source.PositionXSourceMode = axis == ScalarAxis.X ? InteractionSourceMode.EnabledWithInertia : InteractionSourceMode.Disabled;
            source.PositionYSourceMode = axis == ScalarAxis.Y ? InteractionSourceMode.EnabledWithInertia : InteractionSourceMode.Disabled;
            source.ScaleSourceMode = InteractionSourceMode.Disabled;
            source.PositionXChainingMode = InteractionChainingMode.Never;
            source.PositionYChainingMode = InteractionChainingMode.Never;
            source.ScaleChainingMode = InteractionChainingMode.Never;
            source.IsPositionXRailsEnabled = axis == ScalarAxis.X;
            source.IsPositionYRailsEnabled = axis == ScalarAxis.Y;
            source.ManipulationRedirectionMode = VisualInteractionSourceRedirectionMode.CapableTouchpadOnly;
            tracker.InteractionSources.Add(source);
            return new(dispatcher, tracker, source, axis, released);
        }
        catch (Exception error)
        {
            var primary = ExceptionDispatchInfo.Capture(error);
            try { source.Dispose(); }
            catch (Exception cleanup) { error.Data[CleanupFailuresKey] = new[] { cleanup }; }
            primary.Throw();
            throw;
        }
    }

    /// <summary>Перенаправляет настоящий Touch из PointerPressed; native отказ передаётся вызывающему коду.</summary>
    public void Redirect(PointerPoint point)
    {
        CheckLive();
        ArgumentNullException.ThrowIfNull(point);
        source.TryRedirectForManipulation(point);
    }

    public void Dispose()
    {
        if (disposed) return;
        CheckAccess();
        disposed = true;
        ExceptionDispatchInfo? failure = null;
        List<Exception>? secondary = null;
        Attempt(() => tracker.InteractionSources.Remove(source));
        Attempt(source.Dispose);
        Attempt(() => released(this));
        if (failure is not null && secondary is not null)
            failure.SourceException.Data[CleanupFailuresKey] = secondary.ToArray();
        failure?.Throw();

        void Attempt(Action cleanup)
        {
            try { cleanup(); }
            catch (Exception error)
            {
                if (failure is null) failure = ExceptionDispatchInfo.Capture(error);
                else (secondary ??= []).Add(error);
            }
        }
    }

    private void CheckAccess()
    {
        if (!dispatcher.HasThreadAccess) throw new InvalidOperationException("Источник ввода принадлежит потоку владельца.");
    }

    private void CheckLive()
    {
        CheckAccess();
        ObjectDisposedException.ThrowIf(disposed, this);
    }
}
