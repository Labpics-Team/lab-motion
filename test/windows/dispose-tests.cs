using System.Reflection;
using LabMotion.WinUI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;
using Microsoft.UI.Dispatching;

internal static class DisposeTests
{
    internal static IReadOnlyList<BindingTestResult> Run()
    {
        var results = new List<BindingTestResult>();
        foreach (var fault in new[] { "healthy", "stop", "tracker", "modifier", "condition", "force", "settings", "all" })
        {
            Test("dispose-" + fault, () =>
            {
                var compositor = new Compositor();
                var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
                var tracker = InteractionTracker.LastCreated;
                var first = new Visual(compositor);
                var sibling = new Visual(compositor);
                var handle = motion.BindOffsetX(first);
                var siblingHandle = motion.Bind(sibling, ScalarProperty.Opacity);
                var pending = motion.AnimateTo(200, new Spring(350, 0));
                var observed = 0;
                motion.Observed += _ => observed++;
                var primary = new InvalidOperationException("Первичный отказ " + fault);
                if (fault is "stop" or "all") first.StopFailure = primary;
                if (fault == "all")
                {
                    // Порядок HashSet не является контрактом: оба Stop дают один primary.
                    sibling.StopFailure = primary;
                    foreach (var expression in compositor.Expressions.Skip(2))
                        expression.DisposeFailure = new IOException("Вторичный отказ выражения binding.");
                }
                if (fault is "tracker" or "all") tracker.DisposeFailure = fault == "all" ? Secondary() : primary;
                if (fault is "modifier" or "all") compositor.Modifiers[0].DisposeFailure = fault == "all" ? Secondary() : primary;
                if (fault is "condition" or "all") compositor.Expressions[0].DisposeFailure = fault == "all" ? Secondary() : primary;
                if (fault is "force" or "all") compositor.Expressions[1].DisposeFailure = fault == "all" ? Secondary() : primary;
                if (fault is "settings" or "all") compositor.PropertySets[0].DisposeFailure = fault == "all" ? Secondary() : primary;
                var error = Capture(motion.Dispose);
                Require(fault == "healthy" ? error is null : ReferenceEquals(error, primary),
                    "Dispose потерял первичную ошибку или скрыл отказ.");
                if (error is not null)
                    Require(error.StackTrace?.Contains("Microsoft.UI.Composition", StringComparison.Ordinal) == true,
                        "Потерян исходный stack trace native-границы.");
                Require(pending.IsCompletedSuccessfully
                    && pending.Result == new MotionResult(1, MotionEnd.Stopped, "disposed"),
                    "Cleanup потерял окончательный результат операции.");
                Require(first.Stops == 1 && sibling.Stops == 1, "Не все bindings получили одну попытку Stop.");
                Require(sibling.Animations.Count == 0 || fault == "all", "Отказ соседа пропустил здоровый binding.");
                Require(fault != "healthy" || first.Animations.Count == 0, "Здоровый Dispose не снял анимацию.");
                Require(tracker.DisposeCount == 1 && compositor.Modifiers[0].DisposeCount == 1
                    && compositor.PropertySets[0].DisposeCount == 1
                    && compositor.Expressions.All(expression => expression.DisposeCount == 1),
                    "Отказ ресурса пропустил последующие cleanup попытки.");
                Require(ObserverCount(motion) == 0 && observed == 0, "Observed удерживает подписку после Dispose.");
                motion.Dispose();
                handle.Dispose();
                siblingHandle.Dispose();
                Require(first.Stops == 1 && sibling.Stops == 1 && tracker.DisposeCount == 1
                    && compositor.Modifiers[0].DisposeCount == 1 && compositor.PropertySets[0].DisposeCount == 1
                    && compositor.Expressions.All(expression => expression.DisposeCount == 1),
                    "Повторный Dispose заново исполнил внешние эффекты.");
                Require(Capture(() => motion.Stop()) is ObjectDisposedException,
                    "Закрытый владелец допустил новое движение.");
            });
        }

        Test("dispose-reentrant-callback", () =>
        {
            var compositor = new Compositor();
            var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            var pending = motion.AnimateTo(200, new Spring(350, 0));
            var visual = new Visual(compositor);
            var binding = motion.BindOffsetX(visual);
            var expression = visual.Animations["Offset.X"].Source;
            visual.OnStop = binding.Dispose;
            var observed = 0;
            motion.Observed += _ => observed++;
            tracker.OnDispose = () =>
            {
                Require(pending.IsCompletedSuccessfully, "Освобождение опередило terminal result.");
                motion.Dispose();
                motion.IdleStateEntered(tracker, new() { RequestId = tracker.LastRequest });
                motion.CustomAnimationStateEntered(tracker, new());
                motion.Observed += _ => observed++;
            };
            motion.Dispose();
            Require(tracker.DisposeCount == 1 && visual.Stops == 1 && expression.DisposeCount == 1
                && observed == 0 && ObserverCount(motion) == 0,
                "Shutdown callback повторил cleanup или оставил observer.");
        });

        Test("dispose-wrong-thread-preserves-owner", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var tracker = InteractionTracker.LastCreated;
            var visual = new Visual(compositor);
            motion.BindOffsetX(visual);
            var pending = motion.AnimateTo(200, new Spring(350, 0));
            motion.Observed += _ => { };
            var error = Task.Run(() => Capture(motion.Dispose)).GetAwaiter().GetResult();
            Require(error is InvalidOperationException && tracker.DisposeCount == 0 && visual.Stops == 0
                && !pending.IsCompleted && ObserverCount(motion) == 1,
                "Чужой поток изменил lifetime до отказа admission.");
            motion.Dispose();
            Require(pending.IsCompletedSuccessfully && visual.Stops == 1 && tracker.DisposeCount == 1
                && ObserverCount(motion) == 0, "Поток владельца не смог завершить Dispose после отказа.");
        });

        Test("binding-compound-failure-primary", () =>
        {
            var compositor = new Compositor();
            using var motion = new ScalarMotion(compositor, -1000, 1000, initial: 0, endpointAccuracy: BoundaryTestSettings.EndpointAccuracy);
            var visual = new Visual(compositor);
            var tracker = InteractionTracker.LastCreated;
            var releases = 0;
            var stopFailure = new InvalidOperationException("Первичный StopAnimation.");
            var expressionFailure = new IOException("Первичный expression.Dispose.");
            var releaseFailure = new IOException("Вторичный released callback.");
            var binding = ScalarBinding.Create(DispatcherQueue.GetForCurrentThread(), tracker, visual,
                ScalarProperty.OffsetX, ScalarAxis.X, 1, 1, 0, _ => { releases++; throw releaseFailure; });
            var expression = visual.Animations["Offset.X"].Source;
            visual.StopFailure = stopFailure;
            expression.DisposeFailure = expressionFailure;
            var error = Capture(binding.Dispose);
            Require(ReferenceEquals(error, stopFailure) && expression.DisposeCount == 1 && releases == 1,
                "Stop primary подменён expression/released или cleanup пропущен.");
            binding.Dispose();
            Require(visual.Stops == 1 && expression.DisposeCount == 1 && releases == 1,
                "Compound failure допустил повторный effect.");
            visual.StopFailure = null;
            var next = ScalarBinding.Create(DispatcherQueue.GetForCurrentThread(), tracker, visual,
                ScalarProperty.OffsetX, ScalarAxis.X, 1, 1, 0, _ => { releases++; throw releaseFailure; });
            var nextExpression = visual.Animations["Offset.X"].Source;
            nextExpression.DisposeFailure = expressionFailure;
            error = Capture(next.Dispose);
            Require(ReferenceEquals(error, expressionFailure) && nextExpression.DisposeCount == 1 && releases == 2
                && visual.Animations.Count == 0, "Release callback подменил expression primary.");
            next.Dispose();
            Require(releases == 2 && nextExpression.DisposeCount == 1, "Release выполнился повторно.");
            var last = ScalarBinding.Create(DispatcherQueue.GetForCurrentThread(), tracker, visual,
                ScalarProperty.OffsetY, ScalarAxis.X, 1, 1, 0, _ => { releases++; throw releaseFailure; });
            var lastExpression = visual.Animations["Offset.Y"].Source;
            error = Capture(last.Dispose);
            Require(ReferenceEquals(error, releaseFailure) && releases == 3 && lastExpression.DisposeCount == 1
                && visual.Animations.Count == 0, "Отдельный released failure скрыт или cleanup потерян.");
            last.Dispose();
            Require(releases == 3 && lastExpression.DisposeCount == 1, "released failure допустил повторный effect.");
        });

        return results;

        void Test(string name, Action action)
        {
            try { action(); results.Add(new(name, true, null)); }
            catch (Exception error) { results.Add(new(name, false, error.ToString())); }
        }
    }

    private static Exception Secondary() => new IOException("Вторичный отказ native Dispose.");
    private static Exception? Capture(Action action)
    {
        try { action(); return null; }
        catch (Exception error) { return error; }
    }
    private static int ObserverCount(ScalarMotion motion)
    {
        var field = typeof(ScalarMotion).GetField(nameof(ScalarMotion.Observed), BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Не найден backing field Observed.");
        return (field.GetValue(motion) as Delegate)?.GetInvocationList().Length ?? 0;
    }
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
