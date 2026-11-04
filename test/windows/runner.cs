using System.Numerics;
using System.Text.Json;
using LabMotion.WinUI;
using Microsoft.UI.Composition;
using Microsoft.UI.Composition.Interactions;

var results = new List<object>();
var passed = true;
foreach (var reaction in new[] { "observe", "retarget", "stop", "snap", "dispose", "throw" })
{
    using var motion = new ScalarMotion(new Compositor(), -1000, 1000);
    var tracker = InteractionTracker.LastCreated;
    var first = motion.AnimateTo(200, new Spring(350, 0));
    var request = tracker.LastRequest;
    motion.InertiaStateEntered(tracker, new() { RequestId = request });
    Task<MotionResult>? next = null;
    MotionObservation? observed = null;
    var completedInside = false;
    motion.Observed += observation =>
    {
        if (observation.Phase != "idle") return;
        observed = observation;
        completedInside = first.IsCompletedSuccessfully;
        if (reaction == "retarget") next = motion.AnimateTo(-100, new Spring(350, 0));
        if (reaction == "stop") motion.Stop();
        if (reaction == "snap") motion.SnapTo(42);
        if (reaction == "dispose") motion.Dispose();
        if (reaction == "throw") throw new InvalidOperationException("Ошибка observer");
    };
    tracker.Position = new Vector3(200, 0, 0);
    string? error = null;
    try { motion.IdleStateEntered(tracker, new() { RequestId = request }); }
    catch (Exception caught) { error = caught.Message; }
    var valid = completedInside && observed?.Operation == 1
        && first.IsCompletedSuccessfully && first.Result.End == MotionEnd.Finished && first.Result.Reason == "settled"
        && (reaction != "retarget" || next is { IsCompleted: false })
        && (reaction == "throw" ? error == "Ошибка observer" : error is null);
    passed &= valid;
    results.Add(new
    {
        scenario = $"idle-reentrant-{reaction}", reaction, passed = valid, completedInside, observationOperation = observed?.Operation,
        taskCompleted = first.IsCompleted,
        end = first.IsCompletedSuccessfully ? first.Result.End.ToString() : null,
        reason = first.IsCompletedSuccessfully ? first.Result.Reason : null,
        nextTaskPending = next is { IsCompleted: false }, error
    });
}
using (var motion = new ScalarMotion(new Compositor(), -1000, 1000))
{
    var tracker = InteractionTracker.LastCreated;
    var first = motion.AnimateTo(200, new Spring(350, 0));
    var firstRequest = tracker.LastRequest;
    var second = motion.AnimateTo(-100, new Spring(350, 0));
    var secondRequest = tracker.LastRequest;
    var firstReplaced = first.IsCompletedSuccessfully
        && first.Result == new MotionResult(1, MotionEnd.Stopped, "replaced");
    var secondPending = !second.IsCompleted;
    motion.IdleStateEntered(tracker, new() { RequestId = firstRequest });
    var pendingAfterStaleIdle = !second.IsCompleted;
    motion.RequestIgnored(tracker, new() { RequestId = firstRequest });
    var pendingAfterStaleRejection = !second.IsCompleted;
    motion.IdleStateEntered(tracker, new() { RequestId = secondRequest });
    var secondSettled = second.IsCompletedSuccessfully
        && second.Result == new MotionResult(2, MotionEnd.Finished, "settled");
    var valid = firstRequest != secondRequest && firstReplaced && secondPending
        && pendingAfterStaleIdle && pendingAfterStaleRejection && secondSettled;
    passed &= valid;
    results.Add(new
    {
        scenario = "replacement-stale-callbacks", passed = valid, firstRequest, secondRequest,
        firstReplaced, secondPending, pendingAfterStaleIdle, pendingAfterStaleRejection, secondSettled
    });
}
using (var motion = new ScalarMotion(new Compositor(), -1000, 1000))
{
    var tracker = InteractionTracker.LastCreated;
    var operation = motion.AnimateTo(200, new Spring(350, 0));
    motion.RequestIgnored(tracker, new() { RequestId = tracker.LastRequest });
    var error = operation.Exception;
    var valid = operation.IsFaulted && error?.InnerExceptions.Count == 1
        && error.InnerException?.GetType() == typeof(InvalidOperationException);
    passed &= valid;
    results.Add(new
    {
        scenario = "own-request-ignored", passed = valid, taskFaulted = operation.IsFaulted,
        exceptionType = error?.InnerException?.GetType().FullName
    });
}
{
    var compositor = new Compositor();
    using var motion = new ScalarMotion(compositor, -1000, 1000);
    var tracker = InteractionTracker.LastCreated;
    var observations = new List<MotionObservation>();
    motion.Observed += observations.Add;
    var operation = motion.AnimateTo(200, new Spring(350, 0));
    var validSpringAccepted = !operation.IsCompleted;
    var request = tracker.LastRequest;
    var position = tracker.Position;
    var settings = compositor.PropertySets.Single();
    var scalars = settings.Scalars.ToDictionary();
    var observationCount = observations.Count;
    Exception? error = null;
    try { _ = motion.AnimateTo(-100, new Spring(float.MaxValue, 0)); }
    catch (Exception caught) { error = caught; }
    var rejected = error is ArgumentOutOfRangeException { ParamName: "parameters" }
        && error.GetType() == typeof(ArgumentOutOfRangeException);
    var operationPending = !operation.IsCompleted;
    var requestUnchanged = tracker.LastRequest == request;
    var positionUnchanged = tracker.Position == position;
    var settingsUnchanged = settings.Scalars.Count == scalars.Count
        && scalars.All(scalar => settings.Scalars.TryGetValue(scalar.Key, out var value) && value == scalar.Value);
    var observationsUnchanged = observations.Count == observationCount;
    motion.IdleStateEntered(tracker, new() { RequestId = request });
    var originalSettled = operation.IsCompletedSuccessfully
        && operation.Result == new MotionResult(1, MotionEnd.Finished, "settled");
    var next = motion.AnimateTo(-100, new Spring(350, 0));
    motion.IdleStateEntered(tracker, new() { RequestId = tracker.LastRequest });
    var generationUnchanged = next.IsCompletedSuccessfully
        && next.Result == new MotionResult(2, MotionEnd.Finished, "settled");
    var valid = validSpringAccepted && rejected && operationPending && requestUnchanged
        && positionUnchanged && settingsUnchanged && observationsUnchanged && originalSettled && generationUnchanged;
    passed &= valid;
    results.Add(new
    {
        scenario = "invalid-spring-preserves-operation", passed = valid, validSpringAccepted,
        rejected, exceptionType = error?.GetType().FullName, operationPending, requestUnchanged,
        positionUnchanged, settingsUnchanged, observationsUnchanged, originalSettled, generationUnchanged
    });
}
var bindings = BindingTests.Run();
passed &= bindings.All(result => result.Passed);
var disposals = DisposeTests.Run();
passed &= disposals.Count == 11 && disposals.All(result => result.Passed);
Console.WriteLine(JsonSerializer.Serialize(new { passed, results, bindings, disposals }, new JsonSerializerOptions { WriteIndented = true }));
return passed ? 0 : 1;
