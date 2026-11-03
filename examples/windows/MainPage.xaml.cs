using System.Text.Json;
using LabMotion.WinUI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Media;

namespace NativeWindow;

public sealed partial class MainPage : Page
{
    private readonly List<object> runs = [];
    private readonly List<object> units = [];
    private double? legacySeconds;
    private readonly string output = Environment.GetEnvironmentVariable("LAB_MOTION_PROBE_OUTPUT")
        ?? throw new InvalidOperationException("Нужен путь результата опыта.");
    // Два тестовых режима: критическое затухание и пружина с отскоком.
    private static readonly Spring Smooth = new(350, 0);
    private static readonly Spring Expressive = new(500, .3f);

    public MainPage()
    {
        InitializeComponent();
        Loaded += Run;
    }

    private async void Run(object sender, RoutedEventArgs args)
    {
        Loaded -= Run;
        try
        {
            await UnitsMatrix();
            var legacyClock = System.Diagnostics.Stopwatch.StartNew();
            try { await LegacyScenarios().WaitAsync(TimeSpan.FromSeconds(60)); }
            finally { legacySeconds = legacyClock.Elapsed.TotalSeconds; }
            Status.Text = "Траектории проверены";
            Save("captured", null);
        }
        catch (Exception error)
        {
            Status.Text = "Ошибка опыта";
            Environment.ExitCode = 1;
            Save("error", error.ToString());
        }
        finally { Application.Current.Exit(); }
    }

    private void Save(string status, string? error) => File.WriteAllText(output,
        JsonSerializer.Serialize(new { status, error, scale = XamlRoot.RasterizationScale, units, legacySeconds, runs },
            new JsonSerializerOptions { WriteIndented = true }));

    private async Task LegacyScenarios()
    {
        await IdleRetarget();
        await Retarget(false, 1);
        await Retarget(true, 1);
        await Retarget(false, -1);
        await Retarget(true, -1);
        await Settle();
        await Lifetime();
    }

    private async Task UnitsMatrix()
    {
        foreach (var direction in new[] { 1f, -1f })
        foreach (var reset in new[] { false, true })
        foreach (var q in new[] { 1f, 1000f })
        {
            units.Add(await UnitsRetarget(q, reset, direction));
            Save("diagnostic", null);
        }
    }

    private async Task<object> UnitsRetarget(float q, bool reset, float direction)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var trace = new List<MotionObservation>();
        var spring = Expressive;
        var target = -100 * direction;
        float? before = null;
        float? finalPosition = null;
        MotionResult? firstResult = null;
        MotionResult? secondResult = null;
        string? error = null;
        try
        {
            var compositor = ElementCompositionPreview.GetElementVisual(Stage).Compositor;
            using var parent = compositor.CreateContainerVisual();
            parent.Scale = new System.Numerics.Vector3(1 / q, 1, 1);
            parent.CenterPoint = System.Numerics.Vector3.Zero;
            using var sprite = compositor.CreateSpriteVisual();
            sprite.Size = new System.Numerics.Vector2(32 * q, 32);
            sprite.Brush = compositor.CreateColorBrush(((SolidColorBrush)Status.Foreground).Color);
            parent.Children.InsertAtTop(sprite);
            ElementCompositionPreview.SetElementChildVisual(Stage, parent);
            using var motion = new ScalarMotion(compositor, -1000 * q, 1000 * q);
            motion.Observed += trace.Add;
            motion.BindOffsetX(sprite);
            try
            {
                var first = motion.AnimateTo(200 * q * direction, spring);
                await Until(() => trace.Any(x => x.Phase == "value" && x.Position * direction >= 40 * q));
                before = motion.Position;
                if (reset)
                {
                    motion.Stop();
                    await Until(() => trace.Last().Phase == "idle");
                }
                var second = motion.AnimateTo(target * q, spring, reset ? 0 * q : null);
                firstResult = first.IsCompletedSuccessfully ? first.Result : null;
                secondResult = await second.WaitAsync(TimeSpan.FromSeconds(8));
            }
            finally
            {
                finalPosition = motion.Position;
                ElementCompositionPreview.SetElementChildVisual(Stage, null);
            }
        }
        catch (Exception caught) { error = caught.ToString(); }

        var entries = trace.Where(x => x.Operation == 2 && x.Phase == "inertia").ToArray();
        var idles = trace.Where(x => x.Operation == 2 && x.Phase == "idle").ToArray();
        MotionObservation? entry = entries.Length == 1 ? entries[0] : null;
        MotionObservation? idle = idles.Length == 1 ? idles[0] : null;
        MotionObservation? requested = trace.Where(x => x.Operation == 2 && x.Phase == "requested")
            .Select(x => (MotionObservation?)x).FirstOrDefault();
        MotionObservation? after = entry is { } inertia
            ? trace.Where(x => x.Operation == 2 && x.Phase == "value" && x.Seconds > inertia.Seconds)
                .Select(x => (MotionObservation?)x).FirstOrDefault()
            : null;
        var normalizedError = finalPosition / q - target;
        var physicalError = Math.Abs(normalizedError ?? float.NaN) * XamlRoot.RasterizationScale;
        var checks = new Dictionary<string, bool>
        {
            ["completed"] = error is null,
            ["generations"] = firstResult == new MotionResult(1, MotionEnd.Stopped, reset ? "stopped" : "replaced")
                && secondResult == new MotionResult(2, MotionEnd.Finished, "settled"),
            ["ownIdle"] = idle is not null,
            ["positionPreserved"] = entry is { } positionEntry && before is { } previous
                && positionEntry.Position * direction >= previous * direction,
            ["velocityPreserved"] = entry is { } velocityEntry
                && (reset ? velocityEntry.NativeVelocity == 0 : velocityEntry.NativeVelocity * direction > 0),
            ["trajectoryDistinguishesReset"] = entry is { } trajectoryEntry && after is { } step
                && (reset ? (step.Position - trajectoryEntry.Position) * direction <= 0
                    : (step.Position - trajectoryEntry.Position) * direction > 0),
            ["precision"] = physicalError <= .5
        };

        object? Project(MotionObservation? sample) => sample is { } value ? new
        {
            value.Operation, value.Phase, value.Seconds,
            rawPosition = value.Position, normalizedPosition = value.Position / q,
            rawReadbackPosition = value.ReadbackPosition, normalizedReadbackPosition = value.ReadbackPosition / q,
            // Idle не передаёт скорость: ноль в исходном trace добавлен адаптером.
            rawNativeVelocity = value.Phase == "inertia" ? value.NativeVelocity : null,
            normalizedNativeVelocity = value.Phase == "inertia" ? value.NativeVelocity / q : null
        } : null;

        return new
        {
            q, direction, reset, spring, target, rawTarget = target * q,
            before, normalizedBefore = before / q,
            requested = Project(requested), entry = Project(entry), after = Project(after), idle = Project(idle),
            first = firstResult, second = secondResult, finalPosition, normalizedFinalPosition = finalPosition / q,
            rawError = finalPosition - target * q, normalizedError,
            physicalError = double.IsFinite(physicalError) ? (double?)physicalError : null,
            secondsToIdle = idle?.Seconds - requested?.Seconds,
            caseSeconds = clock.Elapsed.TotalSeconds, checks, passed = checks.Values.All(value => value), error,
            trace, normalizedTrace = trace.Select(value => Project(value)).ToArray()
        };
    }

    private ScalarMotion Motion(List<MotionObservation> trace)
    {
        var compositor = ElementCompositionPreview.GetElementVisual(Stage).Compositor;
        var sprite = compositor.CreateSpriteVisual();
        sprite.Size = new System.Numerics.Vector2(32, 32);
        sprite.Brush = compositor.CreateColorBrush(((SolidColorBrush)Status.Foreground).Color);
        ElementCompositionPreview.SetElementChildVisual(Stage, sprite);
        var motion = new ScalarMotion(compositor, -1000, 1000);
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
        Require(Math.Abs(motion.Position + 100 * direction) * XamlRoot.RasterizationScale <= .5,
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
        Require(Math.Abs(motion.Position - 200) * XamlRoot.RasterizationScale <= .5,
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
