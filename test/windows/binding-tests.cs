using System.Numerics;
using LabMotion.WinUI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;

internal sealed record BindingTestResult(string Name, bool Passed, string? Error);

internal static class BindingTests
{
    internal static IReadOnlyList<BindingTestResult> Run()
    {
        var results = new List<BindingTestResult>();
        foreach (var (property, path) in new[]
        {
            (ScalarProperty.OffsetX, "Offset.X"),
            (ScalarProperty.OffsetY, "Offset.Y"),
            (ScalarProperty.Opacity, "Opacity"),
        })
        {
            Test($"projection-{property}", () =>
            {
                var compositor = new Compositor();
                using var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
                var tracker = InteractionTracker.LastCreated;
                var visual = new Visual(compositor);
                using var binding = motion.Bind(visual, property, -2, .75f);
                Require(visual.Animations.Count == 1 && visual.Animations.ContainsKey(path),
                    "Привязано другое свойство.");
                var animation = visual.Animations[path];
                Require(ReferenceEquals(animation.References["motion"], tracker), "Потерян native tracker.");
                Require(animation.Scalars["multiplier"] == -2 && animation.Scalars["offset"] == .75f
                    && animation.Scalars["coordinateScale"] == 1, "Параметры сырой проекции изменены.");
                binding.Dispose();
                Require(visual.Animations.Count == 0 && visual.Stops == 1 && animation.Source.DisposeCount == 1,
                    "Unbind не освободил свою привязку ровно один раз.");
            });
        }

        Test("replacement-old-owner-dispose", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            using var first = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            using var second = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            first.BindOffsetX(visual);
            var prior = visual.Animations["Offset.X"];
            second.BindOffsetX(visual);
            var successor = visual.Animations["Offset.X"];
            Require(!ReferenceEquals(prior, successor) && visual.Starts == 2, "Замена не установлена.");
            first.Dispose();
            Require(ReferenceEquals(visual.Animations["Offset.X"], successor) && visual.Stops == 0,
                "Прежний владелец остановил новую анимацию.");
            Require(prior.Source.DisposeCount == 1 && successor.Source.DisposeCount == 0,
                "Lifetime выражений не соответствует замене.");
            foreach (var rollback in new[] { "healthy", "stop", "expression", "compound" })
                ReplacementReleaseFailure(rollback);
        });

        Test("replacement-old-handle-dispose", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            using var first = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            using var second = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var old = first.Bind(visual, ScalarProperty.Opacity);
            second.Bind(visual, ScalarProperty.Opacity, .5f);
            var successor = visual.Animations["Opacity"];
            old.Dispose();
            old.Dispose();
            Require(ReferenceEquals(visual.Animations["Opacity"], successor) && visual.Stops == 0,
                "Старый handle остановил заменившую его анимацию.");
        });

        Test("replacement-same-owner", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            using var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var old = motion.Bind(visual, ScalarProperty.OffsetY);
            var oldExpression = visual.Animations["Offset.Y"].Source;
            var current = motion.Bind(visual, ScalarProperty.OffsetY, -1, 40);
            old.Dispose();
            motion.Dispose();
            current.Dispose();
            Require(visual.Starts == 2 && visual.Stops == 1 && visual.Animations.Count == 0,
                "Повторная привязка одного владельца оставила лишний Stop или ресурс.");
            Require(oldExpression.DisposeCount == 1 && compositor.Expressions.All(x => x.DisposeCount == 1),
                "Выражение освобождено повторно или осталось открытым.");
        });

        Test("independent-properties-and-visuals", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            var otherVisual = new Visual(compositor);
            using var first = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            using var second = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var x = first.BindOffsetX(visual);
            first.BindOffsetX(otherVisual);
            second.Bind(visual, ScalarProperty.OffsetY);
            second.Bind(visual, ScalarProperty.Opacity);
            x.Dispose();
            Require(!visual.Animations.ContainsKey("Offset.X") && visual.Animations.Count == 2
                && otherVisual.Animations.ContainsKey("Offset.X"), "Unbind затронул соседнее свойство или visual.");
            first.Dispose();
            Require(visual.Animations.Count == 2 && otherVisual.Animations.Count == 0,
                "Dispose затронул чужие свойства.");
            second.Dispose();
            Require(visual.Animations.Count == 0 && visual.Stops == 3 && otherVisual.Stops == 1,
                "Не все собственные привязки освобождены.");
        });

        Test("invalid-binding-preserves-current", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            using var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            motion.Bind(visual, ScalarProperty.Opacity);
            var before = visual.Animations["Opacity"];
            var expressions = compositor.Expressions.Count;
            Throws<ArgumentNullException>(() => motion.Bind(null!, ScalarProperty.Opacity));
            Throws<ArgumentOutOfRangeException>(() => motion.Bind(visual, (ScalarProperty)999));
            foreach (var invalid in new[] { float.NaN, float.PositiveInfinity, float.NegativeInfinity })
            {
                Throws<ArgumentOutOfRangeException>(() => motion.Bind(visual, ScalarProperty.Opacity, invalid));
                Throws<ArgumentOutOfRangeException>(() => motion.Bind(visual, ScalarProperty.Opacity, 1, invalid));
            }
            Require(ReferenceEquals(visual.Animations["Opacity"], before) && visual.StartAttempts == 1
                && visual.Stops == 0 && compositor.Expressions.Count == expressions,
                "Недопустимые параметры изменили действующую привязку.");
        });

        Test("foreign-compositor-preserves-current", () =>
        {
            var compositor = new Compositor();
            var foreign = new Compositor();
            var visual = new Visual(compositor);
            using var owner = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            using var contender = new ScalarMotion(foreign, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            owner.BindOffsetX(visual);
            var before = visual.Animations["Offset.X"];
            var expressions = foreign.Expressions.Count;
            Throws<ArgumentException>(() => contender.BindOffsetX(visual));
            Require(ReferenceEquals(visual.Animations["Offset.X"], before) && visual.StartAttempts == 1
                && visual.Stops == 0 && foreign.Expressions.Count == expressions,
                "Другой Compositor изменил действующую привязку.");
        });

        Test("failed-start-preserves-current", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            using var first = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            using var second = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            first.BindOffsetX(visual);
            var before = visual.Animations["Offset.X"];
            visual.FailNextStart = true;
            Throws<InvalidOperationException>(() => second.BindOffsetX(visual));
            Require(ReferenceEquals(visual.Animations["Offset.X"], before) && visual.Stops == 0
                && before.Source.DisposeCount == 0 && compositor.Expressions[^1].DisposeCount == 1,
                "Отклонённый Start потерял прежнюю привязку или оставил новое выражение.");
            second.BindOffsetX(visual);
            var successor = visual.Animations["Offset.X"];
            first.Dispose();
            Require(ReferenceEquals(visual.Animations["Offset.X"], successor) && visual.Stops == 0,
                "После отказа восстановление замены потеряло ownership.");
        });

        Test("wrong-thread-no-mutation", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            using var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var binding = motion.BindOffsetX(visual);
            var before = visual.Animations["Offset.X"];
            Task.Run(() =>
            {
                Throws<InvalidOperationException>(() => binding.Dispose());
                Throws<InvalidOperationException>(() => motion.Bind(visual, ScalarProperty.Opacity));
                using var otherThread = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
                Throws<InvalidOperationException>(() => otherThread.BindOffsetX(visual));
            }).GetAwaiter().GetResult();
            Require(ReferenceEquals(visual.Animations["Offset.X"], before) && visual.StartAttempts == 1
                && visual.Stops == 0, "Чужой поток изменил привязку.");
            binding.Dispose();
            binding.Dispose();
            Require(visual.Animations.Count == 0 && visual.Stops == 1, "Владелец не смог освободить привязку после отказа.");
        });

        Test("disposed-owner-rejects-binding", () =>
        {
            var compositor = new Compositor();
            var visual = new Visual(compositor);
            using var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            motion.Dispose();
            var expressions = compositor.Expressions.Count;
            Throws<ObjectDisposedException>(() => motion.BindOffsetX(visual));
            Require(visual.StartAttempts == 0 && compositor.Expressions.Count == expressions,
                "Закрытый владелец создал native-привязку.");
        });

        Test("progress-boundary-units", () =>
        {
            var compositor = new Compositor();
            using var motion = ScalarMotion.CreateProgress(compositor, .25f);
            var tracker = InteractionTracker.LastCreated;
            Require(tracker.MinPosition.X == 0 && tracker.MaxPosition.X == 1000
                && tracker.Position.X == 250 && motion.Position == .25f, "Начальная progress-координата не переведена.");
            var visual = new Visual(compositor);
            using var binding = motion.Bind(visual, ScalarProperty.Opacity, .5f, .1f);
            var projection = visual.Animations["Opacity"];
            Require(projection.Scalars["coordinateScale"] == 1000 && projection.Scalars["multiplier"] == .5f
                && projection.Scalars["offset"] == .1f, "Проекция раскрывает native-единицы потребителю.");
            var observations = new List<MotionObservation>();
            motion.Observed += observations.Add;
            var operation = motion.AnimateTo(.8f, new Spring(350, 0), .6f);
            var request = tracker.LastRequest;
            Require(tracker.LastAdditionalVelocity.X == 600 && compositor.PropertySets[0].Scalars["Target"] == 800,
                "Цель или скорость progress не переведены в native-единицы.");
            tracker.Position = new Vector3(400, 0, 0);
            motion.InertiaStateEntered(tracker, new() { RequestId = request, PositionVelocityInPixelsPerSecond = new(600, 0, 0) });
            motion.ValuesChanged(tracker, new() { RequestId = request, Position = new(500, 0, 0) });
            var inertia = observations.Single(x => x.Phase == "inertia");
            var sample = observations.Single(x => x.Phase == "value");
            Require(inertia.Position == .4f && inertia.NativeVelocity == .6f && sample.Position == .5f
                && sample.ReadbackPosition == .4f, "Наблюдатель получил native-единицы.");
            motion.SnapTo(.2f);
            Require(tracker.Position.X == 200 && motion.Position == .2f && operation.IsCompletedSuccessfully
                && operation.Result.End == MotionEnd.Stopped && operation.Result.Reason == "snap",
                "Snap progress потерял единицы или terminal outcome.");
        });

        Test("progress-invalid-input-no-native-effect", () =>
        {
            var compositor = new Compositor();
            using var motion = ScalarMotion.CreateProgress(compositor, .5f);
            var tracker = InteractionTracker.LastCreated;
            var request = tracker.LastRequest;
            var target = compositor.PropertySets[0].Scalars["Target"];
            foreach (var invalid in new[] { -.1f, 1.1f, float.NaN, float.PositiveInfinity, float.NegativeInfinity })
            {
                Throws<ArgumentOutOfRangeException>(() => ScalarMotion.CreateProgress(compositor, invalid));
                Throws<ArgumentOutOfRangeException>(() => motion.AnimateTo(invalid, new Spring(350, 0)));
                Throws<ArgumentOutOfRangeException>(() => motion.SnapTo(invalid));
            }
            Throws<ArgumentException>(() => motion.AnimateTo(.8f, new Spring(350, 0), float.MaxValue));
            Throws<ArgumentException>(() => motion.AnimateTo(.8f, new Spring(350, 0), -float.MaxValue));
            Require(ReferenceEquals(InteractionTracker.LastCreated, tracker) && tracker.LastRequest == request
                && tracker.Position.X == 500 && compositor.PropertySets.Count == 1
                && compositor.PropertySets[0].Scalars["Target"] == target,
                "Недопустимый progress изменил native tracker или его настройки.");
        });

        Test("coordinate-accuracy-invalid-input-no-native-effect", () =>
        {
            var compositor = new Compositor();
            var previousTracker = InteractionTracker.LastCreated;
            foreach (var accuracy in new[] { 0, -1, float.NaN, float.PositiveInfinity, float.Epsilon, float.MaxValue })
            {
                Throws<ArgumentOutOfRangeException>(() => new ScalarMotion(compositor, -1000, 1000, 0, accuracy));
                Throws<ArgumentOutOfRangeException>(() => new ScalarMotion(compositor, ScalarAxis.Y, -640, 320, 0, accuracy));
            }
            Require(ReferenceEquals(InteractionTracker.LastCreated, previousTracker) && compositor.PropertySets.Count == 0,
                "Недопустимая точность создала native tracker или его настройки.");
        });

        return results;

        void Test(string name, Action action)
        {
            try { action(); results.Add(new(name, true, null)); }
            catch (Exception error) { results.Add(new(name, false, error.ToString())); }
        }
    }

    private static void ReplacementReleaseFailure(string rollback)
    {
        var compositor = new Compositor();
        var visual = new Visual(compositor);
        using var first = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
        using var second = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
        first.BindOffsetX(visual);
        var previous = visual.Animations["Offset.X"].Source;
        var primary = new InvalidOperationException("Первичный отказ прежнего Release.");
        var secondary = new InvalidOperationException("Отказ rollback нового binding.");
        previous.DisposeFailure = primary;
        if (rollback is "stop" or "compound") visual.StopFailure = secondary;
        visual.OnStop = () =>
        {
            if (rollback is "expression" or "compound")
                visual.Animations["Offset.X"].Source.DisposeFailure = secondary;
        };
        Exception? error = null;
        try { second.BindOffsetX(visual); }
        catch (Exception caught) { error = caught; }
        var successor = compositor.Expressions[^1];
        Require(ReferenceEquals(error, primary) && previous.DisposeCount == 1 && successor.DisposeCount == 1
            && visual.Starts == 2 && visual.Stops == 1, $"Замена потеряла primary или cleanup successor: {rollback}.");
        if (rollback is "healthy" or "expression")
            Require(visual.Animations.Count == 0, "Невозвращённая привязка осталась на visual после успешного Stop.");
        visual.StopFailure = null;
        visual.OnStop = null;
        using var third = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
        third.BindOffsetX(visual);
        first.Dispose();
        second.Dispose();
        Require(visual.Stops == 1 && previous.DisposeCount == 1 && successor.DisposeCount == 1,
            "Rollback оставил orphan в registry или owner bindings.");
        third.Dispose();
        Require(visual.Stops == 2 && visual.Animations.Count == 0,
            "Новая здоровая привязка не восстановила ownership после rollback.");
    }

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
