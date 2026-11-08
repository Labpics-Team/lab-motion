using System.Numerics;
using LabMotion.WinUI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;
using Microsoft.UI.Input;

internal sealed record PanTestResult(string Name, bool Passed, string? Error);

internal static class PanTests
{
    private static readonly Spring Smooth = new(350, 0);

    internal static IReadOnlyList<PanTestResult> Run()
    {
        var results = new List<PanTestResult>();
        foreach (var axis in new[] { ScalarAxis.X, ScalarAxis.Y })
        {
            Test($"raw-axis-{axis}", () =>
            {
                var compositor = new Compositor();
                using var motion = new ScalarMotion(compositor, axis, -640, 320, initial: -160, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
                var tracker = InteractionTracker.LastCreated;
                Require(tracker.MinPosition == Coordinate(axis, -640)
                    && tracker.MaxPosition == Coordinate(axis, 320)
                    && tracker.Position == Coordinate(axis, -160) && motion.Position == -160,
                    "Границы или начальная координата используют другую ось.");
                var visual = new Visual(compositor);
                using var binding = motion.Bind(visual, ScalarProperty.OffsetY, -1);
                var projection = visual.Animations["Offset.Y"];
                Require(ReferenceEquals(projection.References["motion"], tracker)
                    && projection.Expression.Contains($"Position.{axis}", StringComparison.Ordinal),
                    "Проекция visual читает другую ось tracker.");
                motion.SetTarget(-320, Smooth);
                using var pan = motion.AttachPan(visual);
                var source = VisualInteractionSource.LastCreated;
                Require(source.PositionXSourceMode == (axis == ScalarAxis.X
                        ? InteractionSourceMode.EnabledWithInertia : InteractionSourceMode.Disabled)
                    && source.PositionYSourceMode == (axis == ScalarAxis.Y
                        ? InteractionSourceMode.EnabledWithInertia : InteractionSourceMode.Disabled)
                    && source.ScaleSourceMode == InteractionSourceMode.Disabled,
                    "Источник ввода использует другую ось или принимает масштабирование.");
                var observations = new List<MotionObservation>();
                motion.Observed += observations.Add;
                var operation = motion.AnimateTo(-320, Smooth, -50);
                var request = tracker.LastRequest;
                Require(tracker.LastAdditionalVelocity == Coordinate(axis, -50),
                    "Начальная скорость отправлена на другую ось.");
                tracker.Position = Coordinate(axis, -170);
                motion.InertiaStateEntered(tracker, new()
                {
                    RequestId = request, PositionVelocityInPixelsPerSecond = Coordinate(axis, -50),
                });
                motion.ValuesChanged(tracker, new() { RequestId = request, Position = Coordinate(axis, -180) });
                var inertia = observations.Single(item => item.Phase == "inertia");
                var value = observations.Single(item => item.Phase == "value");
                Require(inertia.Position == -170 && inertia.NativeVelocity == -50
                    && value.Position == -180 && value.ReadbackPosition == -170
                    && value.Origin == MotionOrigin.Animation && !operation.IsCompleted,
                    "Наблюдения потеряли ось, raw-единицы или источник.");
            });
        }

        Test("initial-value-is-observed-not-invented", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), ScalarAxis.Y, -640, 320, initial: -160, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            var request = tracker.LastRequest;
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            Require(observations.Count == 0, "Без native callback появилось наблюдение готовности.");
            motion.ValuesChanged(tracker, new() { RequestId = request, Position = new(0, -160, 0) });
            Require(observations.Count == 1 && observations[0].Origin == MotionOrigin.Initial
                && observations[0].Phase == "value" && observations[0].Position == -160
                && observations[0].ReadbackPosition == -160,
                "Фактическое подтверждение ненулевой начальной позиции потеряно.");
        });

        Test("input-continues-after-animation-interruption", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            using var pan = motion.AttachPan(new Visual(compositor));
            var operation = motion.AnimateTo(-320, Smooth);
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            motion.InteractingStateEntered(tracker, new());
            Require(operation.IsCompletedSuccessfully && operation.Result.End == MotionEnd.Stopped
                && operation.Result.Reason == "interaction", "Ввод не остановил ожидание прежней анимации.");
            tracker.Position = new(0, -90, 0);
            motion.ValuesChanged(tracker, new() { RequestId = 0, Position = new(0, -100, 0) });
            motion.InertiaStateEntered(tracker, new()
            {
                RequestId = 0, PositionVelocityInPixelsPerSecond = new(0, -240, 0),
            });
            motion.IdleStateEntered(tracker, new() { RequestId = 0 });
            Require(observations.Select(item => item.Phase).SequenceEqual(new[] { "interacting", "value", "inertia", "idle" })
                && observations.All(item => item.Origin == MotionOrigin.Input && item.Operation == 0),
                "Request 0 теряется после завершения программной Task либо выдаётся за её результат.");
            Require(observations[1].Position == -100 && observations[1].ReadbackPosition == -90
                && observations[2].NativeVelocity == -240,
                "Ввод потерял event position или нативную скорость отпускания.");
        });

        Test("input-callback-does-not-complete-program-task", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            using var pan = motion.AttachPan(new Visual(compositor));
            motion.InteractingStateEntered(tracker, new());
            motion.InertiaStateEntered(tracker, new() { RequestId = 0 });
            var program = motion.AnimateTo(-320, Smooth);
            var request = tracker.LastRequest;
            motion.ValuesChanged(tracker, new() { RequestId = 0, Position = new(0, -100, 0) });
            motion.IdleStateEntered(tracker, new() { RequestId = 0 });
            Require(!program.IsCompleted, "Idle пользовательского ввода завершил чужую программную Task.");
            motion.InertiaStateEntered(tracker, new() { RequestId = request });
            tracker.Position = new(0, -320, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(program.IsCompletedSuccessfully && program.Result.End == MotionEnd.Finished,
                "После постороннего callback собственное завершение больше не принимается.");
        });

        Test("target-intent-before-native-inertia-does-not-submit-playback", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            var first = motion.AnimateTo(-320, Smooth);
            var request = tracker.LastRequest;
            motion.SetTarget(0, new Spring(500, .2f));
            Require(tracker.LastRequest == request && compositor.PropertySets[0].Scalars["Target"] == 0,
                "Установка release intent отправила native Try либо не сохранила цель.");
            Require(first.IsCompletedSuccessfully && first.Result.End == MotionEnd.Stopped
                && first.Result.Reason == "target-changed", "Прежняя Task продолжает обещать прежнюю цель.");
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(first.Result.End == MotionEnd.Stopped && first.Result.Reason == "target-changed",
                "Поздний Idle превратил сменённую цель в успешное завершение прежней.");
        });

        Test("target-intent-during-input-keeps-native-release", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            using var pan = motion.AttachPan(new Visual(compositor));
            motion.InteractingStateEntered(tracker, new());
            var request = tracker.LastRequest;
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            motion.SetTarget(-320, Smooth);
            motion.InertiaStateEntered(tracker, new()
            {
                RequestId = 0, PositionVelocityInPixelsPerSecond = new(0, -240, 0),
            });
            Require(tracker.LastRequest == request && compositor.PropertySets[0].Scalars["Target"] == -320,
                "Намерение во время drag запустило отклоняемую native-команду.");
            Require(observations.Any(item => item.Origin == MotionOrigin.Input && item.Phase == "inertia"
                && item.NativeVelocity == -240) && observations.All(item => item.Phase != "requested"),
                "Намерение подменило естественное отпускание программным запуском.");
        });

        Test("target-intent-during-inertia-keeps-logical-operation", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, -640, 320, 0, BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            var first = motion.AnimateTo(0, Smooth, -240);
            var previous = tracker.LastRequest;
            motion.InertiaStateEntered(tracker, new() { RequestId = previous, PositionVelocityInPixelsPerSecond = new(-240, 0, 0) });
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            motion.SetTarget(160, Smooth);
            var continuation = tracker.LastRequest;
            Require(continuation != previous && tracker.LastAdditionalVelocity == Vector3.Zero,
                "Изменение текущей Inertia не переоценило modifier либо добавило скорость.");
            Require(first.IsCompletedSuccessfully && first.Result is { End: MotionEnd.Stopped, Reason: "target-changed" },
                "Смена намерения сохранила обещание прежней Task.");
            var count = observations.Count;
            motion.IdleStateEntered(tracker, new() { RequestId = previous });
            Require(observations.Count == count, "Старый native Idle завершил продолженное намерение.");
            motion.InertiaStateEntered(tracker, new() { RequestId = continuation, PositionVelocityInPixelsPerSecond = new(-240, 0, 0) });
            tracker.Position = new(160, 0, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = continuation });
            Require(observations.All(item => item.Operation == first.Result.Operation && item.Origin == MotionOrigin.Animation)
                && observations.Last().Phase == "idle" && observations.Last().NativeRequestId == continuation,
                "Native continuation изменила логическое владение движения.");
            Require(first.Result.End == MotionEnd.Stopped, "Idle продолжения превратил прежний результат в Finished.");
        });

        Test("target-intent-during-input-inertia-keeps-input-origin", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, 0, BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            using var pan = motion.AttachPan(new Visual(compositor));
            motion.InteractingStateEntered(tracker, new());
            motion.InertiaStateEntered(tracker, new() { RequestId = 0, PositionVelocityInPixelsPerSecond = new(0, -240, 0) });
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            motion.SetTarget(-320, Smooth);
            var continuation = tracker.LastRequest;
            var count = observations.Count;
            motion.IdleStateEntered(tracker, new() { RequestId = 0 });
            motion.ValuesChanged(tracker, new() { RequestId = 0, Position = Vector3.Zero });
            Require(observations.Count == count, "Старые input callbacks перезаписали продолжение.");
            motion.InertiaStateEntered(tracker, new() { RequestId = continuation, PositionVelocityInPixelsPerSecond = new(0, -240, 0) });
            tracker.Position = new(0, -320, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = continuation });
            Require(tracker.LastAdditionalVelocity == Vector3.Zero && observations.All(item => item.Origin == MotionOrigin.Input
                    && item.Operation == 0 && item.NativeRequestId == continuation) && observations.Last().Phase == "idle",
                "Продолжение release потеряло input origin, скорость или native Idle.");
        });

        foreach (var ending in new[] { "stop", "snap" })
        {
            Test($"target-intent-does-not-restart-pending-{ending}", () =>
            {
                var compositor = new Compositor();
                using var motion = new ScalarMotion(compositor, -640, 320, 0, BoundaryTestSettings.EndpointAccuracy);
                var tracker = InteractionTracker.LastCreated;
                _ = motion.AnimateTo(160, Smooth);
                motion.InertiaStateEntered(tracker, new() { RequestId = tracker.LastRequest });
                if (ending == "stop") motion.Stop(); else motion.SnapTo(0);
                var request = tracker.LastRequest;
                motion.SetTarget(-160, Smooth);
                Require(tracker.LastRequest == request, "SetTarget возобновил уже остановленное движение до его callback.");
            });
        }

        Test("invalid-target-intent-preserves-current-operation", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            var current = motion.AnimateTo(-320, Smooth);
            var request = tracker.LastRequest;
            var settings = new Dictionary<string, float>(compositor.PropertySets[0].Scalars);
            foreach (var invalid in new[] { -641f, 321f, float.NaN, float.NegativeInfinity, float.PositiveInfinity })
                Throws<ArgumentOutOfRangeException>(() => motion.SetTarget(invalid, Smooth));
            foreach (var invalid in new[] { new Spring(0, 0), new Spring(float.NaN, 0), new Spring(350, -1), new Spring(350, 1), new Spring(float.MaxValue, 0), new Spring(float.Epsilon, 0) })
            {
                Throws<ArgumentOutOfRangeException>(() => motion.SetTarget(0, invalid));
                Throws<ArgumentOutOfRangeException>(() => motion.AnimateTo(0, invalid));
            }
            Require(!current.IsCompleted && tracker.LastRequest == request
                && settings.All(pair => compositor.PropertySets[0].Scalars[pair.Key] == pair.Value),
                "Отклонённое намерение изменило текущую цель или завершило её Task.");
        });

        Test("ignored-playback-retains-intent-and-input", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            using var pan = motion.AttachPan(new Visual(compositor));
            motion.InteractingStateEntered(tracker, new());
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            var program = motion.AnimateTo(-320, Smooth);
            var request = tracker.LastRequest;
            motion.RequestIgnored(tracker, new() { RequestId = request });
            Require(program.IsFaulted && program.Exception is not null
                && compositor.PropertySets[0].Scalars["Target"] == -320,
                "Отклонение запуска скрыто либо ошибочно откатило уже установленное намерение.");
            motion.InertiaStateEntered(tracker, new()
            {
                RequestId = 0, PositionVelocityInPixelsPerSecond = new(0, -240, 0),
            });
            Require(observations.Any(item => item.Origin == MotionOrigin.Animation && item.Phase == "ignored")
                && observations.Any(item => item.Origin == MotionOrigin.Input && item.Phase == "inertia"
                    && item.NativeVelocity == -240),
                "Отклонённая программная попытка закрыла продолжающийся поток ввода.");
        });

        foreach (var origin in new[] { MotionOrigin.Snap, MotionOrigin.Stop })
        {
            foreach (var ignored in new[] { false, true })
            {
                Test($"{origin}-submission-{(ignored ? "ignored" : "observed")}", () =>
                {
                    using var motion = new ScalarMotion(new Compositor(), ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
                    var tracker = InteractionTracker.LastCreated;
                    var animation = motion.AnimateTo(-320, Smooth);
                    motion.InertiaStateEntered(tracker, new() { RequestId = tracker.LastRequest });
                    var observations = new List<MotionObservation>();
                    motion.Observed += observations.Add;
                    if (origin == MotionOrigin.Snap) motion.SnapTo(-42);
                    else motion.Stop();
                    var request = tracker.LastRequest;
                    Require(animation.IsCompletedSuccessfully && animation.Result.End == MotionEnd.Stopped,
                        "Отправка не прекратила локальное ожидание прежней анимации.");
                    Require(observations.Count == 1 && observations[0].Origin == origin
                        && observations[0].Phase == "requested", "Отправка выдала native completion без callback.");
                    if (ignored) motion.RequestIgnored(tracker, new() { RequestId = request });
                    else if (origin == MotionOrigin.Snap)
                        motion.ValuesChanged(tracker, new() { RequestId = request, Position = new(0, -42, 0) });
                    else motion.IdleStateEntered(tracker, new() { RequestId = request });
                    var expected = ignored ? "ignored" : origin == MotionOrigin.Snap ? "value" : "idle";
                    Require(observations.Count == 2 && observations[1].Origin == origin
                        && observations[1].Phase == expected, "Фактический исход native-команды потерян.");
                    Require(animation.Result.End == MotionEnd.Stopped,
                        "Наблюдение новой команды переписало terminal outcome прежней анимации.");
                });
            }
        }

        Test("stale-command-callbacks-preserve-successor", () =>
        {
            using var motion = new ScalarMotion(new Compositor(), ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            var previous = motion.AnimateTo(-320, Smooth);
            var stale = tracker.LastRequest;
            var current = motion.AnimateTo(0, Smooth);
            var request = tracker.LastRequest;
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            motion.RequestIgnored(tracker, new() { RequestId = stale });
            motion.IdleStateEntered(tracker, new() { RequestId = stale });
            motion.ValuesChanged(tracker, new() { RequestId = stale, Position = new(0, -320, 0) });
            Require(previous.IsCompletedSuccessfully && previous.Result.End == MotionEnd.Stopped
                && !current.IsCompleted && observations.Count == 0,
                "Старый запрос изменил Task или наблюдения нового владельца.");
            motion.InertiaStateEntered(tracker, new() { RequestId = request });
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(current.IsCompletedSuccessfully && current.Result.End == MotionEnd.Finished,
                "Актуальный запрос не может завершиться после старого callback.");
        });

        Test("pan-preflight-preserves-supported-path", () =>
        {
            var compositor = new Compositor();
            using var progress = ScalarMotion.CreateProgress(compositor);
            var progressTracker = InteractionTracker.LastCreated;
            progress.SetTarget(.5f, Smooth);
            Throws<InvalidOperationException>(() => progress.AttachPan(new Visual(compositor)));
            Require(progressTracker.InteractionSources.Count == 0,
                "Progress принял raw ввод с несовместимыми единицами.");
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            Throws<InvalidOperationException>(() => motion.AttachPan(new Visual(compositor)));
            Require(tracker.InteractionSources.Count == 0, "Источник создан до явной настройки release intent.");
            motion.SetTarget(-320, Smooth);
            Throws<ArgumentNullException>(() => motion.AttachPan(null!));
            Throws<ArgumentException>(() => motion.AttachPan(new Visual(new Compositor())));
            Require(tracker.InteractionSources.Count == 0, "Отклонённый viewport оставил source.");
            using var pan = motion.AttachPan(new Visual(compositor));
            Require(tracker.InteractionSources.Count == 1, "Отказы перекрыли допустимый raw pan.");
        });

        Test("pan-detach-preserves-state-and-program-control", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            var pan = motion.AttachPan(new Visual(compositor));
            var source = VisualInteractionSource.LastCreated;
            pan.Redirect(new PointerPoint());
            Require(source.RedirectCount == 1 && tracker.InteractionSources.Count == 1,
                "Ввод не перенаправлен в принадлежащий каналу source.");
            motion.InteractingStateEntered(tracker, new());
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            pan.Dispose();
            pan.Dispose();
            Throws<ObjectDisposedException>(() => pan.Redirect(new PointerPoint()));
            motion.InteractingStateEntered(tracker, new());
            motion.ValuesChanged(tracker, new() { RequestId = 0, Position = new(0, -100, 0) });
            motion.InertiaStateEntered(tracker, new() { RequestId = 0 });
            motion.IdleStateEntered(tracker, new() { RequestId = 0 });
            Require(source.DisposeCount == 1 && source.RedirectCount == 1
                && tracker.InteractionSources.Count == 0 && observations.Count == 0,
                "После detach ресурс открыт либо поздний ввод доставлен потребителю.");
            var animation = motion.AnimateTo(-320, Smooth, 100);
            var request = tracker.LastRequest;
            motion.InertiaStateEntered(tracker, new() { RequestId = request });
            tracker.Position = new(0, -320, 0);
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(animation.IsCompletedSuccessfully && animation.Result.End == MotionEnd.Finished,
                "Detach потерял фактический переход в Idle или закрыл программное управление.");
        });

        Test("pan-wrong-thread-has-no-effect", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            using var pan = motion.AttachPan(new Visual(compositor));
            var source = VisualInteractionSource.LastCreated;
            Task.Run(() =>
            {
                Throws<InvalidOperationException>(() => pan.Redirect(new PointerPoint()));
                Throws<InvalidOperationException>(() => pan.Dispose());
            }).GetAwaiter().GetResult();
            Require(source.RedirectCount == 0 && source.DisposeCount == 0
                && tracker.InteractionSources.Count == 1, "Чужой поток изменил источник ввода.");
            pan.Redirect(new PointerPoint());
            Require(source.RedirectCount == 1, "Владелец не восстановил ввод после отклонённого вызова.");
        });

        Test("channel-dispose-closes-pan-and-observations", () =>
        {
            var compositor = new Compositor();
            var motion = new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            motion.SetTarget(0, Smooth);
            var pan = motion.AttachPan(new Visual(compositor));
            var source = VisualInteractionSource.LastCreated;
            var animation = motion.AnimateTo(-320, Smooth);
            var request = tracker.LastRequest;
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            motion.Dispose();
            motion.Dispose();
            pan.Dispose();
            Require(animation.IsCompletedSuccessfully && animation.Result.End == MotionEnd.Stopped
                && animation.Result.Reason == "disposed" && tracker.DisposeCount == 1
                && source.DisposeCount == 1 && tracker.InteractionSources.Count == 0,
                "Dispose не завершил ожидание или не освободил свой source/tracker ровно один раз.");
            motion.InteractingStateEntered(tracker, new());
            motion.ValuesChanged(tracker, new() { RequestId = 0, Position = new(0, -100, 0) });
            motion.RequestIgnored(tracker, new() { RequestId = request });
            motion.IdleStateEntered(tracker, new() { RequestId = request });
            Require(observations.Count == 0, "После закрытия доставлены поздние callbacks.");
            Throws<ObjectDisposedException>(() => pan.Redirect(new PointerPoint()));
            Throws<ObjectDisposedException>(() => motion.SetTarget(0, Smooth));
            Throws<ObjectDisposedException>(() => motion.AttachPan(new Visual(compositor)));
        });

        return results;

        void Test(string name, Action action)
        {
            try { action(); results.Add(new(name, true, null)); }
            catch (Exception error) { results.Add(new(name, false, error.ToString())); }
        }
    }

    private static Vector3 Coordinate(ScalarAxis axis, float value)
        => axis == ScalarAxis.X ? new(value, 0, 0) : new(0, value, 0);

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void Throws<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T) { return; }
        throw new InvalidOperationException($"Ожидалось исключение {typeof(T).Name}.");
    }
}
