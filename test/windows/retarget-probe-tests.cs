using LabMotion.WinUI;
using NativeWindow;

internal sealed record RetargetProbeTestResult(string Name, bool Passed, string? Error);

internal static class RetargetProbeTests
{
    internal static IReadOnlyList<RetargetProbeTestResult> Run()
    {
        var results = new List<RetargetProbeTestResult>();
        foreach (var handoff in new[] { false, true })
            Check($"preserve-handoff-{handoff}", () => RetargetProbe.Verify(Trace(handoff), 2, 40, 1, false), true);
        Check("reset-is-a-distinct-healthy-control", () =>
        {
            var trace = Trace(true);
            trace[1] = trace[1] with { NativeVelocity = 0 };
            trace[2] = trace[2] with { Position = 39 };
            RetargetProbe.Verify(trace, 2, 40, 1, true);
        }, true);
        Check("negative-coordinate-direction", () =>
            RetargetProbe.Verify(Trace(true).Select(item => item with
            { Position = -item.Position, NativeVelocity = -item.NativeVelocity }).ToArray(), 2, -40, -1, false), true);

        Reject("later-handoff-cannot-hide-lost-initial-admission", trace => trace.RemoveAt(1));
        Reject("later-handoff-cannot-hide-lost-initial-motion", trace => trace.RemoveAt(2));
        Reject("later-handoff-cannot-hide-reset-velocity", trace => trace[1] = trace[1] with { NativeVelocity = 0 });
        Reject("later-handoff-cannot-hide-rewound-position", trace => trace[1] = trace[1] with { Position = 0 });
        Reject("later-handoff-cannot-hide-wrong-trajectory", trace => trace[2] = trace[2] with { Position = 39 });
        Reject("old-request-cannot-terminate-latest", trace => trace[^1] = trace[^1] with { NativeRequestId = 3 });
        Reject("duplicate-terminal", trace => trace.Add(trace[^1]));
        Reject("third-request-exceeds-budget", trace =>
        {
            trace.Insert(trace.Count - 1, Observation("requested", 7, -99.7f, null, 5));
            trace[^1] = Observation("idle", 8, -100, 0, 5);
        });
        Reject("callback-from-superseded-request", trace => trace[^2] = trace[^2] with { NativeRequestId = 3 });
        Reject("changed-origin", trace => trace[2] = trace[2] with { Origin = MotionOrigin.Input });
        return results;

        void Reject(string name, Action<List<MotionObservation>> mutate) => Check(name, () =>
        {
            var trace = Trace(true);
            mutate(trace);
            RetargetProbe.Verify(trace, 2, 40, 1, false);
        }, false);

        void Check(string name, Action action, bool accepted)
        {
            try
            {
                action();
                results.Add(new(name, accepted, accepted ? null : "Неверная история принята измерителем."));
            }
            catch (InvalidOperationException error)
            {
                results.Add(new(name, !accepted, accepted ? error.Message : null));
            }
        }
    }

    private static List<MotionObservation> Trace(bool handoff)
    {
        List<MotionObservation> trace =
        [
            Observation("requested", 0, 40, null, 3),
            Observation("inertia", 1, 40, 1200, 3),
            Observation("value", 2, 50, null, 3),
            Observation("value", 3, -99.4f, null, 3),
        ];
        if (handoff)
            trace.AddRange([
                Observation("requested", 4, -99.4f, null, 4),
                Observation("inertia", 5, -99.4f, 0, 4),
                Observation("value", 6, -99.7f, null, 4),
            ]);
        trace.Add(Observation("idle", 7, -100, 0, handoff ? 4 : 3));
        return trace;
    }

    private static MotionObservation Observation(string phase, double seconds, float position, float? velocity, int request)
        => new(2, phase, seconds, position, velocity, position)
        { Origin = MotionOrigin.Animation, NativeRequestId = request };
}
