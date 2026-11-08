using LabMotion.WinUI;

namespace NativeWindow;

internal static class RetargetProbe
{
    internal static void Verify(IReadOnlyList<MotionObservation> trace, long operation,
        float before, float direction, bool reset)
    {
        var observations = trace.Where(item => item.Operation == operation).ToArray();
        Require(observations.Length > 0 && observations.All(item => item.Origin == MotionOrigin.Animation),
            "Retarget потерял logical operation или origin.");
        var requests = observations.Where(item => item.Phase == "requested").ToArray();
        Require(requests.Length is 1 or 2 && requests.All(item => item.NativeRequestId > 0)
            && requests.Select(item => item.NativeRequestId).Distinct().Count() == requests.Length,
            "Retarget потерял request identity или превысил один Idle handoff.");
        Require(observations[0].Phase == "requested"
            && observations.Count(item => item.Phase == "idle") == 1
            && observations[^1].Phase == "idle"
            && observations[^1].NativeRequestId == requests[^1].NativeRequestId,
            "Retarget не подтвердил единственный terminal последнего native request.");

        var currentRequest = 0;
        var previousTime = double.NegativeInfinity;
        foreach (var item in observations)
        {
            if (item.Phase == "requested") currentRequest = item.NativeRequestId;
            Require(item.NativeRequestId == currentRequest
                && item.Phase is "requested" or "inertia" or "value" or "idle"
                && double.IsFinite(item.Seconds) && item.Seconds >= previousTime,
                "Retarget смешал callbacks разных запросов или неверное завершение.");
            previousTime = item.Seconds;
        }

        // Continuity belongs to admission of the requested retarget. A later native
        // Idle handoff has zero velocity and must not replace this measurement.
        var initialRequest = requests[0].NativeRequestId;
        var entryIndex = Array.FindIndex(observations,
            item => item.NativeRequestId == initialRequest && item.Phase == "inertia");
        Require(entryIndex > 0, "Нет native admission исходного retarget.");
        var entry = observations[entryIndex];
        var afterIndex = Array.FindIndex(observations, entryIndex + 1,
            item => item.NativeRequestId == initialRequest && item.Phase == "value" && item.Seconds > entry.Seconds);
        Require(afterIndex > entryIndex, "Нет движения исходного retarget до handoff.");
        var after = observations[afterIndex];
        Require(entry.Position * direction >= before * direction, "Retarget вернул позицию назад.");
        Require(reset ? entry.NativeVelocity == 0 : entry.NativeVelocity * direction > 0,
            "Не сохранена семантика native velocity.");
        Require(reset ? (after.Position - entry.Position) * direction <= 0 : (after.Position - entry.Position) * direction > 0,
            "Траектория не отличает сохранение скорости от сброса.");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
