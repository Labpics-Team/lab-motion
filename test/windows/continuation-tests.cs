using System.Numerics;
using LabMotion.WinUI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;

internal sealed record ContinuationTestResult(string Name, bool Passed, string? Error);

internal static class ContinuationTests
{
    private static readonly Spring Smooth = new(350, 0);

    internal static IReadOnlyList<ContinuationTestResult> Run()
    {
        var results = new List<ContinuationTestResult>();
        foreach (var inertiaObserved in new[] { false, true })
        {
            Test($"idle-miss-handoff-inertia-{inertiaObserved}", () =>
            {
                using var motion = Create();
                var tracker = InteractionTracker.LastCreated;
                var operation = motion.AnimateTo(160, Smooth);
                var first = tracker.LastRequest;
                var observations = new List<MotionObservation>();
                motion.Observed += observations.Add;
                if (inertiaObserved) motion.InertiaStateEntered(tracker, new() { RequestId = first });
                motion.IdleStateEntered(tracker, new() { RequestId = first });
                var handoff = tracker.LastRequest;
                Require(handoff == first + 1 && !operation.IsCompleted && tracker.LastAdditionalVelocity == Vector3.Zero
                    && observations.All(item => item.Phase != "idle"),
                    "Idle вне цели выдан за terminal либо продолжение зависит от истории Inertia.");
                var count = observations.Count;
                motion.IdleStateEntered(tracker, new() { RequestId = first });
                Require(observations.Count == count && !operation.IsCompleted, "Старый Idle завершил handoff.");
                tracker.Position = new(160, 0, 0);
                motion.InertiaStateEntered(tracker, new() { RequestId = handoff });
                motion.IdleStateEntered(tracker, new() { RequestId = handoff });
                Require(operation.IsCompletedSuccessfully && operation.Result is { End: MotionEnd.Finished, Reason: "settled" }
                    && observations.All(item => item.Operation == operation.Result.Operation && item.Origin == MotionOrigin.Animation)
                    && observations.Last().Phase == "idle" && observations.Last().NativeRequestId == handoff,
                    "Handoff потерял обещанную Task, operation или фактический terminal.");
            });
        }

        Test("setters-retain-latest-intent-and-stopped-task", () =>
        {
            using var motion = Create();
            var tracker = InteractionTracker.LastCreated;
            var operation = motion.AnimateTo(0, Smooth, -1);
            motion.InertiaStateEntered(tracker, new() { RequestId = tracker.LastRequest });
            motion.SetTarget(160, Smooth);
            motion.SetTarget(240, Smooth);
            var latest = tracker.LastRequest;
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            tracker.Position = new(160, 0, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = latest });
            var handoff = tracker.LastRequest;
            Require(handoff == latest + 1 && observations.All(item => item.Phase != "idle"),
                "Продолжение приняло предпоследнюю цель.");
            tracker.Position = new(240, 0, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = handoff });
            Require(operation.IsCompletedSuccessfully && operation.Result is { End: MotionEnd.Stopped, Reason: "target-changed" }
                && observations.Last().Phase == "idle" && observations.All(item => item.Operation == operation.Result.Operation),
                "Новый terminal переписал результат прежней цели или потерял operation.");
        });

        Test("input-handoff-retains-origin-and-axis", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, 0, 320, 0, .32f);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            using var pan = motion.AttachPan(new Visual(compositor));
            motion.InteractingStateEntered(tracker, new());
            motion.InertiaStateEntered(tracker, new() { RequestId = 0 });
            motion.SetTarget(160, Smooth);
            var request = tracker.LastRequest;
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            var handoff = tracker.LastRequest;
            motion.IdleStateEntered(tracker, new() { RequestId = 0 });
            tracker.Position = new(0, 160, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = handoff });
            Require(handoff == request + 1 && observations.Count == 2 && observations.Last().Phase == "idle"
                && observations.All(item => item.Operation == 0 && item.Origin == MotionOrigin.Input
                    && item.NativeRequestId == handoff), "Handoff потерял input origin, ось или фильтр старого release.");
        });

        foreach (var setter in new[] { false, true })
        {
            Test($"second-miss-is-explicit-failure-setter-{setter}", () =>
            {
                using var motion = Create();
                var tracker = InteractionTracker.LastCreated;
                var operation = motion.AnimateTo(160, Smooth);
                motion.InertiaStateEntered(tracker, new() { RequestId = tracker.LastRequest });
                if (setter) motion.SetTarget(240, Smooth);
                var observations = new List<MotionObservation>();
                motion.Observed += observations.Add;
                motion.IdleStateEntered(tracker, new() { RequestId = tracker.LastRequest });
                var handoff = tracker.LastRequest;
                motion.InertiaStateEntered(tracker, new() { RequestId = handoff });
                motion.IdleStateEntered(tracker, new() { RequestId = handoff });
                motion.IdleStateEntered(tracker, new() { RequestId = handoff });
                Require(tracker.LastRequest == handoff && observations.Count(item => item.Phase == "continuation-failed") == 1
                    && observations.All(item => item.Phase != "idle"), "Повторный отказ скрыт либо создал бесконечное продолжение.");
                Require(setter ? operation.IsCompletedSuccessfully && operation.Result.End == MotionEnd.Stopped
                    : operation.IsFaulted && operation.Exception?.InnerException is InvalidOperationException,
                    "Отказ не отклонил актуальную Task либо переписал уже остановленную.");
            });
        }

        Test("endpoint-within-accuracy-needs-no-inertia-or-handoff", () =>
        {
            using var motion = Create();
            var tracker = InteractionTracker.LastCreated;
            var operation = motion.AnimateTo(160, Smooth);
            var request = tracker.LastRequest;
            tracker.Position = new(159.8f, 0, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(tracker.LastRequest == request && operation.IsCompletedSuccessfully && operation.Result.End == MotionEnd.Finished,
                "Корректный endpoint требует лишней попытки или обязательного Inertia callback.");
        });

        Test("set-target-after-terminal-does-not-revive-intent", () =>
        {
            using var motion = Create();
            var tracker = InteractionTracker.LastCreated;
            var operation = motion.AnimateTo(160, Smooth);
            var request = tracker.LastRequest;
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            tracker.Position = new(160, 0, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            var count = observations.Count;
            motion.SetTarget(240, Smooth);
            motion.InertiaStateEntered(tracker, new() { RequestId = request });
            motion.ValuesChanged(tracker, new() { RequestId = request, Position = new(80, 0, 0) });
            motion.SetTarget(80, Smooth);
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(tracker.LastRequest == request && observations.Count == count && operation.Result.End == MotionEnd.Finished,
                "Поздний callback оживил завершённый запрос или SetTarget из покоя.");
            _ = motion.AnimateTo(80, Smooth, initialVelocity: 0);
            Require(tracker.LastRequest == request + 1, "Поздний Inertia изменил фазу после terminal.");
        });

        foreach (var reaction in new[] { "stop", "snap", "dispose", "replace", "setter", "throw" })
        {
            Test($"handoff-observer-{reaction}", () =>
            {
                using var motion = Create();
                var tracker = InteractionTracker.LastCreated;
                var operation = motion.AnimateTo(160, Smooth);
                var request = tracker.LastRequest;
                Task<MotionResult>? replacement = null;
                var reacted = false;
                var observations = new List<MotionObservation>();
                motion.Observed += item =>
                {
                    observations.Add(item);
                    if (reacted || item.Phase != "requested") return;
                    reacted = true;
                    if (reaction == "stop") motion.Stop();
                    if (reaction == "snap") motion.SnapTo(80);
                    if (reaction == "dispose") motion.Dispose();
                    if (reaction == "replace") replacement = motion.AnimateTo(80, Smooth);
                    if (reaction == "setter") motion.SetTarget(80, Smooth);
                    if (reaction == "throw") throw new InvalidOperationException("observer");
                };
                string? error = null;
                try { motion.IdleStateEntered(tracker, new() { RequestId = request }); }
                catch (InvalidOperationException caught) { error = caught.Message; }
                var current = tracker.LastRequest;
                Require(reacted && (reaction == "throw" ? error == "observer" : error is null),
                    "Реакция observer перехвачена как ошибка native Try.");
                motion.IdleStateEntered(tracker, new() { RequestId = request });
                if (reaction is "stop" or "snap" or "dispose" or "replace")
                    motion.IdleStateEntered(tracker, new() { RequestId = request + 1 });
                Require(tracker.LastRequest == current && observations.All(item => item.Phase != "continuation-failed"),
                    "Старое продолжение ожило после нового владельца либо ошибки observer.");
                if (reaction is "replace" or "setter" or "throw")
                {
                    tracker.Position = new(reaction == "throw" ? 160 : 80, 0, 0);
                    motion.IdleStateEntered(tracker, new() { RequestId = current });
                    Require(observations.Last().Phase == "idle" && (reaction == "replace"
                        ? replacement is { IsCompletedSuccessfully: true } && replacement.Result.End == MotionEnd.Finished
                        : reaction == "throw" ? operation.IsCompletedSuccessfully && operation.Result.End == MotionEnd.Finished
                        : operation.IsCompletedSuccessfully && operation.Result.End == MotionEnd.Stopped),
                        "Observer потерял новое намерение или изменил итог старой операции.");
                }
                else Require(operation.IsCompletedSuccessfully && operation.Result.End == MotionEnd.Stopped,
                    "Отмена продолжения оставила незавершённую Task.");
            });
        }

        Test("pending-setters-retain-latest-before-first-inertia", () =>
        {
            using var motion = Create();
            var tracker = InteractionTracker.LastCreated;
            var operation = motion.AnimateTo(80, Smooth);
            var request = tracker.LastRequest;
            motion.SetTarget(160, Smooth);
            motion.SetTarget(240, Smooth);
            Require(tracker.LastRequest == request, "SetTarget до Inertia отправил новый запуск.");
            tracker.Position = new(160, 0, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(tracker.LastRequest == request + 1 && operation.Result.End == MotionEnd.Stopped,
                "После завершения прежней Task адаптер потерял последнее pending намерение.");
            tracker.Position = new(240, 0, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = tracker.LastRequest });
        });

        Test("ignored-handoff-does-not-retry", () =>
        {
            using var motion = Create();
            var tracker = InteractionTracker.LastCreated;
            var operation = motion.AnimateTo(160, Smooth);
            motion.IdleStateEntered(tracker, new() { RequestId = tracker.LastRequest });
            var handoff = tracker.LastRequest;
            motion.RequestIgnored(tracker, new() { RequestId = handoff });
            motion.IdleStateEntered(tracker, new() { RequestId = handoff });
            Require(operation.IsFaulted && operation.Exception is not null && tracker.LastRequest == handoff,
                "Отклонённый handoff сохранил активную операцию или начал повтор.");
        });

        return results;

        void Test(string name, Action action)
        {
            try { action(); results.Add(new(name, true, null)); }
            catch (Exception error) { results.Add(new(name, false, error.ToString())); }
        }
    }

    private static ScalarMotion Create() => new(new Compositor(), 0, 320, 0, .32f);

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
