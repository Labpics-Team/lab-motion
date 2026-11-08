using System.Text.Json;
using LabMotion.WinUI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;

namespace NativeWindow;

public sealed partial class MainPage : Page
{
    private enum Probe { IdleRetarget, Retarget, Settle, Lifetime, Progress, Boundaries }
    private enum FailureType { InvalidOperation, Timeout, ObjectDisposed, Argument, ArgumentOutOfRange, ArgumentNull, InvalidCast, NullReference, COM }
    private readonly record struct FailureMetadata(FailureType? ErrorType, Probe? ActiveProbe);
    private readonly List<object> runs = [];
    private readonly string output = Environment.GetEnvironmentVariable("LAB_MOTION_PROBE_OUTPUT")
        ?? throw new InvalidOperationException("Нужен путь результата опыта.");
    // Два тестовых режима: критическое затухание и пружина с отскоком.
    private static readonly Spring Smooth = new(350, 0);
    private static readonly Spring Expressive = new(500, .3f);
    private const double EndpointAccuracyPhysicalPixels = .5;

    public MainPage()
    {
        InitializeComponent();
        Loaded += Run;
    }

    private async void Run(object sender, RoutedEventArgs args)
    {
        Loaded -= Run;
        Probe? activeProbe = null;
        try
        {
            activeProbe = Probe.IdleRetarget;
            await IdleRetarget();
            activeProbe = Probe.Retarget;
            await Retarget(false, 1);
            activeProbe = Probe.Retarget;
            await Retarget(true, 1);
            activeProbe = Probe.Retarget;
            await Retarget(false, -1);
            activeProbe = Probe.Retarget;
            await Retarget(true, -1);
            activeProbe = Probe.Settle;
            await Settle();
            activeProbe = Probe.Lifetime;
            await Lifetime();
            activeProbe = Probe.Progress;
            await Progress("up");
            activeProbe = Probe.Progress;
            await Progress("down");
            activeProbe = Probe.Progress;
            await Progress("reverse");
            activeProbe = Probe.Progress;
            await Progress("velocity");
            activeProbe = Probe.Boundaries;
            await Boundaries();
            activeProbe = null;
            Status.Text = "Траектории проверены";
            Save("captured", null);
        }
        catch (Exception error)
        {
            Status.Text = "Ошибка опыта";
            Environment.ExitCode = 1;
            Save("error", error.ToString(), new FailureMetadata(Classify(error), activeProbe));
        }
        finally { Application.Current.Exit(); }
    }

    private static FailureType? Classify(Exception error)
    {
        var type = error.GetType();
        return type == typeof(InvalidOperationException) ? FailureType.InvalidOperation
            : type == typeof(TimeoutException) ? FailureType.Timeout
            : type == typeof(ObjectDisposedException) ? FailureType.ObjectDisposed
            : type == typeof(ArgumentException) ? FailureType.Argument
            : type == typeof(ArgumentOutOfRangeException) ? FailureType.ArgumentOutOfRange
            : type == typeof(ArgumentNullException) ? FailureType.ArgumentNull
            : type == typeof(InvalidCastException) ? FailureType.InvalidCast
            : type == typeof(NullReferenceException) ? FailureType.NullReference
            : type == typeof(System.Runtime.InteropServices.COMException) ? FailureType.COM : null;
    }

    private void Save(string status, string? error, FailureMetadata? failure = null) => File.WriteAllText(output,
        JsonSerializer.Serialize(new { status, error, scale = XamlRoot.RasterizationScale, runs,
            errorType = failure?.ErrorType?.ToString(), activeProbe = failure?.ActiveProbe?.ToString() },
            new JsonSerializerOptions { WriteIndented = true }));

    private ScalarMotion Motion(List<MotionObservation> trace)
    {
        var compositor = ElementCompositionPreview.GetElementVisual(Stage).Compositor;
        var sprite = compositor.CreateSpriteVisual();
        sprite.Size = new System.Numerics.Vector2(32, 32);
        sprite.Brush = compositor.CreateColorBrush(((SolidColorBrush)Status.Foreground).Color);
        ElementCompositionPreview.SetElementChildVisual(Stage, sprite);
        var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0,
            endpointAccuracy: (float)(EndpointAccuracyPhysicalPixels / XamlRoot.RasterizationScale));
        motion.Observed += trace.Add;
        motion.BindOffsetX(sprite);
        return motion;
    }

    private async Task IdleRetarget()
    {
        var trace = new List<MotionObservation>();
        using var motion = Motion(trace);
        var spring = Smooth;
        Task<MotionResult>? first = null;
        Task<MotionResult>? next = null;
        MotionObservation? idleObservation = null;
        var firstCompletedInside = false;
        var nextPendingInside = false;
        motion.Observed += observation =>
        {
            if (observation.Phase != "idle" || observation.Operation != 1) return;
            idleObservation = observation;
            firstCompletedInside = first?.IsCompletedSuccessfully == true;
            next = motion.AnimateTo(-100, spring);
            nextPendingInside = !next.IsCompleted;
        };
        first = motion.AnimateTo(200, spring);
        var firstResult = await first.WaitAsync(TimeSpan.FromSeconds(8));
        await Until(() => next is not null);
        var nextPendingAfter = !next!.IsCompleted;
        var nextResult = await next.WaitAsync(TimeSpan.FromSeconds(8));
        runs.Add(new { kind = "idle-reentrant-retarget", spring, firstCompletedInside, nextPendingInside,
            nextPendingAfter, idleObservation, first = firstResult, next = nextResult, trace });
        Require(firstCompletedInside && firstResult.End == MotionEnd.Finished && firstResult.Reason == "settled",
            "Idle передал observer ещё незавершённую операцию.");
        Require(idleObservation?.Operation == 1 && nextPendingInside && nextPendingAfter,
            "Idle потерял identity или завершил новую операцию observer.");
        Require(nextResult.Operation == 2 && nextResult.End == MotionEnd.Finished,
            "Новая операция observer не завершилась своим native Idle.");
    }

    private async Task Retarget(bool reset, float direction)
    {
        var trace = new List<MotionObservation>();
        using var motion = Motion(trace);
        var spring = Expressive;
        var first = motion.AnimateTo(200 * direction, spring);
        await Until(() => trace.Any(x => x.Phase == "value" && x.Position * direction >= 40));
        var before = motion.Position;
        if (reset)
        {
            motion.Stop();
            await Until(() => trace.Last().Phase == "idle");
        }
        var second = motion.AnimateTo(-100 * direction, spring, reset ? 0 : null);
        var outcome = await second.WaitAsync(TimeSpan.FromSeconds(8));
        var replaced = await first;
        runs.Add(new { kind = reset ? "retarget-reset-mutant" : "retarget-preserve", direction, spring, before, first = replaced, second = outcome, trace });
        var entry = trace.Single(x => x.Operation == 2 && x.Phase == "inertia");
        var after = trace.First(x => x.Operation == 2 && x.Phase == "value" && x.Seconds > entry.Seconds);
        Require(replaced.End == MotionEnd.Stopped && outcome.End == MotionEnd.Finished, "Завершения поколений перепутаны.");
        Require(entry.Position * direction >= before * direction, "Retarget вернул позицию назад.");
        Require(reset ? entry.NativeVelocity == 0 : entry.NativeVelocity * direction > 0, "Не сохранена семантика native velocity.");
        Require(reset ? (after.Position - entry.Position) * direction <= 0 : (after.Position - entry.Position) * direction > 0,
            "Траектория не отличает сохранение скорости от сброса.");
        Require(Math.Abs(motion.Position + 100 * direction) * XamlRoot.RasterizationScale <= EndpointAccuracyPhysicalPixels,
            "Native settling дальше половины физического пикселя от цели.");
    }

    private async Task Settle()
    {
        var trace = new List<MotionObservation>();
        using var motion = Motion(trace);
        var spring = Smooth;
        var outcome = await motion.AnimateTo(200, spring).WaitAsync(TimeSpan.FromSeconds(8));
        runs.Add(new { kind = "smooth-settle", spring, outcome, trace });
        Require(outcome.End == MotionEnd.Finished, "Пружина из покоя не завершилась.");
        Require(trace.Where(x => x.Phase == "value").All(x => x.Position <= 200), "Критическая пружина перескочила цель.");
        Require(Math.Abs(motion.Position - 200) * XamlRoot.RasterizationScale <= EndpointAccuracyPhysicalPixels,
            "Native settling дальше половины физического пикселя от цели.");
    }

    private async Task Lifetime()
    {
        var trace = new List<MotionObservation>();
        using var motion = Motion(trace);
        var spring = Smooth;
        var first = motion.AnimateTo(200, spring, 600);
        await Until(() => trace.Any(x => x.Phase == "inertia"));
        motion.Stop();
        var stopped = await first;
        await Until(() => trace.Last().Phase == "idle");
        motion.SnapTo(42);
        await Until(() => motion.Position == 42);
        var snapped = motion.Position;
        var second = motion.AnimateTo(200, spring);
        await Until(() => trace.Any(x => x.Operation == 2 && x.Phase == "inertia"));
        motion.Dispose();
        var disposed = await second;
        var count = trace.Count;
        await Task.Delay(120);
        var lateObservations = trace.Count - count;
        var rejected = false;
        try { _ = motion.AnimateTo(0, spring); }
        catch (ObjectDisposedException) { rejected = true; }
        runs.Add(new { kind = "lifetime", spring, snapped, stopped, disposed, lateObservations, rejected, trace });
        Require(trace.First(x => x.Phase == "inertia").NativeVelocity == 600, "Начальная скорость потеряна.");
        Require(stopped.End == MotionEnd.Stopped && stopped.Reason == "stopped", "Stop выдал неверное завершение.");
        Require(disposed.End == MotionEnd.Stopped && disposed.Reason == "disposed", "Dispose выдал неверное завершение.");
        Require(lateObservations == 0 && rejected, "Канал доступен или сообщает события после Dispose.");
    }

    private async Task Progress(string direction)
    {
        var compositor = ElementCompositionPreview.GetElementVisual(Stage).Compositor;
        using var sprite = compositor.CreateSpriteVisual();
        sprite.Size = new System.Numerics.Vector2(64, 16);
        sprite.Brush = compositor.CreateColorBrush(((SolidColorBrush)Status.Foreground).Color);
        ElementCompositionPreview.SetElementChildVisual(Stage, sprite);
        using var motion = ScalarMotion.CreateProgress(compositor, direction == "down" ? 1 : 0);
        var trace = new List<MotionObservation>();
        motion.Observed += trace.Add;
        using var opacity = motion.Bind(sprite, ScalarProperty.Opacity, .5f, .25f);
        using var translation = motion.Bind(sprite, ScalarProperty.OffsetY, 64);
        var target = direction == "down" ? 0 : 1;
        var first = motion.AnimateTo(target, Smooth, direction == "velocity" ? 2 : null);
        MotionResult? replaced = null;
        float? before = null;
        var last = first;
        if (direction == "reverse")
        {
            await Until(() => trace.Any(x => x.Phase == "value" && x.Position >= .2f));
            before = motion.Position;
            target = 0;
            last = motion.AnimateTo(target, Smooth);
            replaced = await first;
        }
        var outcome = await last.WaitAsync(TimeSpan.FromSeconds(8));
        var error = Math.Abs(motion.Position - target);
        var intermediateValues = trace.Where(x => x.Phase == "value" && x.Position > 0 && x.Position < 1)
            .Select(x => x.Position).Distinct().Count();
        runs.Add(new { kind = "progress-" + direction, outcome, replaced, before, target,
            position = motion.Position, error, intermediateValues, trace });
        Require(outcome.End == MotionEnd.Finished && error <= .001f,
            "Нормализованный канал завершился дальше 0.001 от цели.");
        Require(intermediateValues >= 3, "Не наблюдалось промежуточное движение прогресса.");
        if (direction == "reverse")
        {
            var entry = trace.Single(x => x.Operation == 2 && x.Phase == "inertia");
            var after = trace.First(x => x.Operation == 2 && x.Phase == "value" && x.Seconds > entry.Seconds);
            Require(replaced?.End == MotionEnd.Stopped && entry.Position >= before
                && entry.NativeVelocity > 0 && after.Position > entry.Position,
                "Нормализация потеряла непрерывность разворота.");
        }
        if (direction == "velocity")
            Require(Math.Abs(trace.First(x => x.Phase == "inertia").NativeVelocity!.Value - 2) <= .00001f,
                "Скорость канала возвращается не в единицах прогресса в секунду.");
        ElementCompositionPreview.SetElementChildVisual(Stage, null);
    }

    private async Task Boundaries()
    {
        var compositor = ElementCompositionPreview.GetElementVisual(Stage).Compositor;
        using var sprite = compositor.CreateSpriteVisual();
        sprite.Size = new System.Numerics.Vector2(24, 24);
        using var brush = compositor.CreateColorBrush(((SolidColorBrush)Status.Foreground).Color);
        sprite.Brush = brush;
        ElementCompositionPreview.SetElementChildVisual(Stage, sprite);
        var passed = true;
        try
        {
            foreach (var coordinates in new[] { "progress", "raw-x", "raw-y" })
            {
                foreach (var (name, initial, velocity) in new[] { ("lower", 0f, -1f), ("interior", .5f, -1f), ("upper", 1f, 1f) })
                {
                    foreach (var setter in coordinates == "progress" ? new[] { false, true } : new[] { false })
                    {
                        var capture = await BoundaryProbe.Capture(compositor, sprite, coordinates, name, initial, velocity, setter);
                        runs.Add(capture.Evidence);
                        passed &= capture.Passed;
                    }
                }
            }
        }
        finally { ElementCompositionPreview.SetElementChildVisual(Stage, null); }
        Require(passed, "Native boundary или SetTarget не подтвердили цель и единственный terminal.");
    }

    private static async Task Until(Func<bool> condition)
    {
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        while (!condition())
        {
            if (deadline.Elapsed > TimeSpan.FromSeconds(4)) throw new TimeoutException("Событие native runtime не получено.");
            await Task.Delay(5);
        }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
