using System.Numerics;
using System.Reflection;
using System.Text.Json;
using LabMotion.WinUI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;

internal static class RawTraceTests
{
    internal sealed record Result(string Name, bool Passed, string? Error);
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    private static void Begin(ScalarMotion motion) => (typeof(ScalarMotion).GetMethod("BeginRawTrace", Private)
        ?? throw new InvalidOperationException("Отсутствует private BeginRawTrace.")).Invoke(motion, null);
    private static JsonElement Snapshot(ScalarMotion motion, bool stop = false)
    {
        var value = (typeof(ScalarMotion).GetMethod("CaptureRawTrace", Private)
            ?? throw new InvalidOperationException("Отсутствует private CaptureRawTrace.")).Invoke(motion, [stop])!;
        return JsonSerializer.SerializeToElement(value, value.GetType());
    }
    private static long Number(JsonElement value, string key) => value.GetProperty(key).GetInt64();
    private static long Count(JsonElement trace, int kind, int disposition) => trace.GetProperty("Counts")
        .EnumerateArray().Where(row => Number(row, "Kind") == kind && Number(row, "Disposition") == disposition)
        .Sum(row => Number(row, "Count"));
    private static JsonElement Terminal(JsonElement trace, int kind, int disposition) => trace.GetProperty("Terminals")
        .EnumerateArray().Single(row => Number(row, "Kind") == kind && Number(row, "Disposition") == disposition);

    internal static Result[] Run()
    {
        var results = new List<Result>();
        void Run(string name, Action body)
        {
            try { body(); results.Add(new(name, true, null)); }
            catch (Exception error) { results.Add(new(name, false, error.GetBaseException().Message)); }
        }
        Run("counterexample-rejected-idle-is-invisible-to-observed", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), -100, 100);
            var tracker = InteractionTracker.LastCreated;
            var task = motion.AnimateTo(10, new(350, 0));
            var request = tracker.LastRequest;
            var idle = 0;
            motion.Observed += value => { if (value.Phase == "idle") idle++; };
            motion.IdleStateEntered(tracker, new() { RequestId = request + 1 });
            Check(idle == 0 && !task.IsCompleted, "Чужой Idle стал observation или завершил операцию.");
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Check(idle == 1 && task.IsCompletedSuccessfully && task.Result.End == MotionEnd.Finished,
                "Здоровый Idle не завершил ту же операцию.");
        });
        Run("trace-off-keeps-null-buffer-and-native-read-behavior", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), -100, 100);
            var tracker = InteractionTracker.LastCreated;
            var field = typeof(ScalarMotion).GetField("rawTrace", Private)
                ?? throw new InvalidOperationException("Отсутствует private rawTrace.");
            Check(field.GetValue(motion) is null, "Trace создал буфер без включения.");
            var args = new InteractionTrackerValuesChangedArgs { RequestId = -1, Position = new(1, 2, 3) };
            var reads = tracker.PositionReads;
            motion.ValuesChanged(tracker, args);
            Check(args.Reads == 2 && tracker.PositionReads == reads && field.GetValue(motion) is null,
                "Выключенный trace изменил чтения native или выделил буфер.");
        });
        Run("rejected-and-accepted-idle-retain-actual-disposition", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), -100, 100);
            var tracker = InteractionTracker.LastCreated;
            var task = motion.AnimateTo(10, new(350, 0));
            var request = tracker.LastRequest;
            var idle = 0;
            motion.Observed += value => { if (value.Phase == "idle") idle++; };
            Begin(motion);
            motion.IdleStateEntered(tracker, new() { RequestId = request + 20 });
            var rejected = Snapshot(motion);
            var witness = Terminal(rejected, 2, 4).GetProperty("First");
            Check(!task.IsCompleted && idle == 0 && Count(rejected, 2, 4) == 1,
                "Trace потерял rejected Idle или изменил completion.");
            Check(Number(witness, "IncomingRequestId") == request + 20 &&
                Number(witness.GetProperty("Before"), "ActiveRequest") == request &&
                Number(witness.GetProperty("Before"), "ActiveOperation") == 1 &&
                Number(witness.GetProperty("Before"), "RequestId") == request,
                "Pre-state подменён состоянием после фильтра.");
            motion.InertiaStateEntered(tracker, new() { RequestId = request + 21, PositionVelocityInPixelsPerSecond = new(3, 4, 5) });
            motion.ValuesChanged(tracker, new() { RequestId = request + 22, Position = new(7, 8, 9) });
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            var accepted = Snapshot(motion);
            Check(task.IsCompletedSuccessfully && task.Result.End == MotionEnd.Finished && idle == 1 &&
                Count(accepted, 2, 3) == 1 && Count(accepted, 2, 4) == 1, "Accepted Idle потерял свою семантику.");
            var rows = accepted.GetProperty("Records").EnumerateArray().ToArray();
            Check(rows[1].GetProperty("Velocity").GetProperty("Y").GetSingle() == 4 &&
                rows[2].GetProperty("Position").GetProperty("Z").GetSingle() == 9,
                "Отклонённые native args не записаны.");
            Check(Number(Terminal(accepted, 2, 3).GetProperty("First").GetProperty("Before"), "ActiveOperation") == 1,
                "Accepted Idle потерял active pre-state до Finish.");
        });
        Run("all-six-callbacks-and-input-guards-are-accounted", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), -100, 100);
            var tracker = InteractionTracker.LastCreated;
            Begin(motion);
            motion.InteractingStateEntered(tracker, new() { RequestId = 23 });
            motion.ValuesChanged(tracker, new() { RequestId = 0, Position = new(1, 0, 0) });
            motion.InertiaStateEntered(tracker, new() { RequestId = 0 });
            motion.IdleStateEntered(tracker, new() { RequestId = 0 });
            motion.SnapTo(4);
            motion.CustomAnimationStateEntered(tracker, new() { RequestId = tracker.LastRequest });
            motion.CustomAnimationStateEntered(tracker, new() { RequestId = -1 });
            motion.RequestIgnored(tracker, new() { RequestId = -1 });
            var task = motion.AnimateTo(10, new(350, 0));
            motion.RequestIgnored(tracker, new() { RequestId = tracker.LastRequest });
            var trace = Snapshot(motion);
            Check(task.IsFaulted && Count(trace, 3, 5) == 1 && Count(trace, 0, 2) == 1 && Count(trace, 1, 2) == 1 &&
                Count(trace, 2, 2) == 1 && Count(trace, 4, 3) == 1 && Count(trace, 4, 4) == 1 &&
                Count(trace, 5, 4) == 1 && Count(trace, 5, 3) == 1 && Number(trace, "CallbackCount") == 8,
                "Callback или исполненная ветка отсутствует в счётчиках.");
            Check(trace.GetProperty("CountersComplete").GetBoolean(), "Завершённые callbacks объявлены неполными.");
        });
        Run("bounded-storage-keeps-terminal-witnesses-and-honest-window", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), -100, 100);
            var tracker = InteractionTracker.LastCreated;
            Begin(motion);
            var args = new InteractionTrackerValuesChangedArgs { RequestId = -1, Position = new(1, 2, 3) };
            for (var i = 0; i < 24; i++) motion.ValuesChanged(tracker, args);
            motion.IdleStateEntered(tracker, new() { RequestId = -11 });
            for (var i = 0; i < 1000; i++) motion.ValuesChanged(tracker, args);
            motion.IdleStateEntered(tracker, new() { RequestId = -12 });
            var trace = Snapshot(motion, true);
            Check(Number(trace, "CallbackCount") == 1026 && Number(trace, "CompletedCount") == 1026 &&
                Number(trace, "DroppedRecords") == 1002 && trace.GetProperty("RecordsTruncated").GetBoolean() &&
                trace.GetProperty("CountersComplete").GetBoolean() && trace.GetProperty("Stopped").GetBoolean(),
                "Усечение или полнота окна заявлены неверно.");
            var rows = trace.GetProperty("Records").EnumerateArray().ToArray();
            Check(rows.Length == 24 && Number(rows[0], "Sequence") == 1 && Number(rows[7], "Sequence") == 8 &&
                Number(rows[8], "Sequence") == 1011 && Number(rows[^1], "Sequence") == 1026 &&
                rows.All(row => Number(row, "Sequence") != 25),
                "First/last storage не сохраняет порядок и границы.");
            var terminal = Terminal(trace, 2, 4);
            Check(Number(terminal.GetProperty("First"), "IncomingRequestId") == -11 &&
                Number(terminal.GetProperty("Last"), "IncomingRequestId") == -12 && Count(trace, 0, 4) == 1024 && Count(trace, 2, 4) == 2,
                "Saturation потеряла terminal witness или полные counters.");
            Check(Number(trace, "StartedTicks") <= Number(rows[0], "Timestamp") &&
                Number(rows[^1], "Timestamp") <= Number(trace, "EndedTicks") && Number(trace, "Frequency") > 0,
                "Timestamps не покрывают заявленное окно.");
            motion.IdleStateEntered(tracker, new() { RequestId = -13 });
            var closed = Snapshot(motion);
            Check(Number(closed, "CallbackCount") == 1026 && Number(closed, "EndedTicks") == Number(trace, "EndedTicks"),
                "Закрытое окно продолжило принимать callback.");
        });
        Run("callback-read-error-keeps-pending-and-is-not-suppressed", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), -100, 100);
            var tracker = InteractionTracker.LastCreated;
            Begin(motion);
            var threw = false;
            try { motion.IdleStateEntered(tracker, new() { ThrowOnRead = true }); }
            catch (InvalidOperationException) { threw = true; }
            var trace = Snapshot(motion, true);
            Check(threw && Number(trace, "CallbackCount") == 1 && Number(trace, "CompletedCount") == 0 &&
                !trace.GetProperty("CountersComplete").GetBoolean() && Count(trace, 2, 0) == 1 &&
                Number(trace.GetProperty("Records")[0], "Disposition") == 0,
                "Ошибка native args скрыта или незавершённое наблюдение объявлено полным.");
        });
        Run("enabled-trace-preserves-observer-reentry-and-exceptions", () =>
        {
            foreach (var reaction in new[] { "retarget", "dispose", "throw" })
            {
                using var motion = new ScalarMotion(new Compositor(), -100, 100);
                var tracker = InteractionTracker.LastCreated;
                var task = motion.AnimateTo(10, new(350, 0));
                var request = tracker.LastRequest;
                Begin(motion);
                Task<MotionResult>? next = null;
                var finishedInside = false;
                motion.Observed += value =>
                {
                    if (value.Phase != "idle") return;
                    finishedInside = task.IsCompletedSuccessfully;
                    if (reaction == "retarget") next = motion.AnimateTo(-10, new(350, 0));
                    if (reaction == "dispose") motion.Dispose();
                    if (reaction == "throw") throw new InvalidOperationException("observer");
                };
                string? error = null;
                try { motion.IdleStateEntered(tracker, new() { RequestId = request }); }
                catch (InvalidOperationException caught) { error = caught.Message; }
                var trace = Snapshot(motion);
                Check(finishedInside && task.Result.End == MotionEnd.Finished &&
                    (reaction != "retarget" || next is { IsCompleted: false }) &&
                    (reaction == "throw" ? error == "observer" : error is null) && Count(trace, 2, 3) == 1 &&
                    Number(Terminal(trace, 2, 3).GetProperty("First").GetProperty("Before"), "ActiveRequest") == request,
                    "Trace изменил семантику observer или потерял прежнюю request identity: " + reaction);
            }
        });
        Run("disposed-callbacks-never-read-native-args-or-tracker", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), -100, 100);
            var tracker = InteractionTracker.LastCreated;
            Begin(motion);
            motion.Dispose();
            var reads = tracker.PositionReads;
            CallbackArgs[] args = [new InteractionTrackerValuesChangedArgs { ThrowOnRead = true },
                new InteractionTrackerInertiaStateEnteredArgs { ThrowOnRead = true },
                new InteractionTrackerIdleStateEnteredArgs { ThrowOnRead = true },
                new InteractionTrackerInteractingStateEnteredArgs { ThrowOnRead = true },
                new InteractionTrackerCustomAnimationStateEnteredArgs { ThrowOnRead = true },
                new InteractionTrackerRequestIgnoredArgs { ThrowOnRead = true }];
            motion.ValuesChanged(tracker, (InteractionTrackerValuesChangedArgs)args[0]);
            motion.InertiaStateEntered(tracker, (InteractionTrackerInertiaStateEnteredArgs)args[1]);
            motion.IdleStateEntered(tracker, (InteractionTrackerIdleStateEnteredArgs)args[2]);
            motion.InteractingStateEntered(tracker, (InteractionTrackerInteractingStateEnteredArgs)args[3]);
            motion.CustomAnimationStateEntered(tracker, (InteractionTrackerCustomAnimationStateEnteredArgs)args[4]);
            motion.RequestIgnored(tracker, (InteractionTrackerRequestIgnoredArgs)args[5]);
            var trace = Snapshot(motion);
            Check(args.All(arg => arg.Reads == 0) && tracker.PositionReads == reads, "Disposed trace прочитал native объект.");
            Check(Enumerable.Range(0, 6).All(kind => Count(trace, kind, 1) == 1), "Disposed callback не учтён.");
            Check(trace.GetProperty("Records").EnumerateArray().All(row =>
                row.GetProperty("Before").GetProperty("Disposed").GetBoolean() &&
                row.GetProperty("IncomingRequestId").ValueKind == JsonValueKind.Null &&
                row.GetProperty("Position").ValueKind == JsonValueKind.Null && row.GetProperty("Velocity").ValueKind == JsonValueKind.Null),
                "Disposed record выдумал native поля.");
            Task.Run(() => motion.IdleStateEntered(tracker, new() { ThrowOnRead = true })).GetAwaiter().GetResult();
            Check(Number(Snapshot(motion), "OtherThreadCount") == 1, "Trace скрыл поток вне dispatcher.");
        });
        return results.ToArray();
    }
}
