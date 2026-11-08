using System.Diagnostics;
using LabMotion.WinUI;
using Microsoft.UI.Composition;

namespace NativeWindow;

internal static class BoundaryProbe
{
    private const int SampleLimit = 128;
    private const float EndpointTolerance = .001f;
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(5);
    private static readonly Spring Smooth = new(350, 0);

    internal static async Task<(bool Passed, object Evidence)> Capture(Compositor compositor, Visual visual, string coordinates,
        string name, float initial, float velocity, bool setter)
    {
        var unitsPerProgress = coordinates == "progress" ? 1 : 320f;
        using var motion = coordinates switch
        {
            "progress" => ScalarMotion.CreateProgress(compositor, initial),
            "raw-x" => new ScalarMotion(compositor, ScalarAxis.X, 0, unitsPerProgress,
                initial * unitsPerProgress, EndpointTolerance * unitsPerProgress),
            "raw-y" => new ScalarMotion(compositor, ScalarAxis.Y, 0, unitsPerProgress,
                initial * unitsPerProgress, EndpointTolerance * unitsPerProgress),
            _ => throw new ArgumentException("Неизвестные единицы проверки.", nameof(coordinates)),
        };
        using var binding = motion.Bind(visual, ScalarProperty.OffsetX, 64 / unitsPerProgress, 64);
        var admitted = new TaskCompletionSource<MotionObservation>(TaskCreationOptions.RunContinuationsAsynchronously);
        var overflow = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var terminal = new TaskCompletionSource<MotionObservation>(TaskCreationOptions.RunContinuationsAsynchronously);
        var trace = new List<MotionObservation>(SampleLimit);
        var target = setter ? initial == .5f ? .75f : .5f : initial;
        var armed = false;
        var setterApplied = false;
        var inertiaCount = 0;
        float? setterReadback = null;
        MotionObservation? firstDiscarded = null;
        MotionObservation? initialObservation = null;
        MotionResult? outcome = null;
        string? failure = null;
        motion.Observed += original =>
        {
            // q is the consumer coordinate; native vectors retain the executor units.
            var value = original with { Position = original.Position / unitsPerProgress,
                ReadbackPosition = original.ReadbackPosition / unitsPerProgress,
                NativeVelocity = original.NativeVelocity / unitsPerProgress };
            if (!armed)
            {
                if (value.Origin == MotionOrigin.Initial && value.Phase is "value" or "idle") admitted.TrySetResult(value);
                return;
            }
            if (trace.Count == SampleLimit)
            {
                firstDiscarded ??= value;
                overflow.TrySetResult(true);
            }
            else trace.Add(value);
            if (setter && value.Phase == "inertia" && ++inertiaCount == (initial is 0 or 1 ? 2 : 1))
            {
                setterReadback = motion.Position / unitsPerProgress;
                if (initial is 0 or 1 && !(setterReadback < 0 || setterReadback > 1))
                    failure = "SetTarget не застал штатный возврат снаружи границ.";
                else
                {
                    try
                    {
                        motion.SetTarget(target * unitsPerProgress, Smooth);
                        setterApplied = true;
                    }
                    catch (Exception error)
                    {
                        failure = error.GetType().Name;
                        terminal.TrySetResult(value);
                    }
                }
            }
            if (value.Phase is "idle" or "continuation-failed" or "ignored") terminal.TrySetResult(value);
        };

        try
        {
            initialObservation = await admitted.Task.WaitAsync(Deadline);
            if (initialObservation.Value.Position != initial || motion.Position / unitsPerProgress != initial)
                throw new InvalidOperationException("Начальная native координата не подтверждена.");
            armed = true;
            var started = Stopwatch.GetTimestamp();
            var operation = motion.AnimateTo(initial * unitsPerProgress, Smooth, velocity * unitsPerProgress);
            var remaining = Deadline - Stopwatch.GetElapsedTime(started);
            if (remaining <= TimeSpan.Zero) throw new TimeoutException();
            var completed = await Task.WhenAny(terminal.Task, overflow.Task).WaitAsync(remaining);
            if (completed == overflow.Task) failure = "overflow";
            else
            {
                var end = await terminal.Task;
                if (end.Phase != "idle") failure ??= end.Phase;
                if (operation.IsCompleted) outcome = await operation;
                else failure ??= "Native terminal оставил незавершённую Task.";
            }
        }
        catch (TimeoutException) { failure = "timeout"; }
        catch (Exception error) { failure = error.GetType().Name; }
        var position = motion.Position / unitsPerProgress;
        var last = trace.LastOrDefault();
        var requested = trace.LastOrDefault(item => item.Phase == "requested");
        var outsideObserved = trace.Any(item => item.Position < 0 || item.Position > 1);
        var departed = trace.Any(item => item.Phase == "value" && Math.Abs(item.Position - initial) > .005f);
        var passed = failure is null && firstDiscarded is null && float.IsFinite(position) && position is >= 0 and <= 1 &&
            Math.Abs(position - target) <= EndpointTolerance && departed &&
            (initial == .5f || outsideObserved) &&
            (setter ? setterApplied && outcome is { End: MotionEnd.Stopped, Reason: "target-changed" }
                : outcome is { End: MotionEnd.Finished, Reason: "settled" }) &&
            last.Phase == "idle" && last.NativeRequestId == requested.NativeRequestId &&
            last.Operation == outcome!.Value.Operation && trace.Count(item => item.Phase == "idle") == 1;
        return (passed, new { kind = $"boundary-{coordinates}-{name}-{(setter ? "setter" : "settle")}",
            passed, failure, coordinates, unitsPerProgress, initial, target, velocity, initialObservation,
            setter, setterApplied, setterReadback, position, outcome, outsideObserved, departed,
            sampleLimit = SampleLimit, deadlineMs = Deadline.TotalMilliseconds,
            endpointTolerance = EndpointTolerance, trace, firstDiscarded });
    }
}
