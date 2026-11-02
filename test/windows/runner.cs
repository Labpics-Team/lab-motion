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
        reaction, passed = valid, completedInside, observationOperation = observed?.Operation,
        taskCompleted = first.IsCompleted,
        end = first.IsCompletedSuccessfully ? first.Result.End.ToString() : null,
        reason = first.IsCompletedSuccessfully ? first.Result.Reason : null,
        nextTaskPending = next is { IsCompleted: false }, error
    });
}
var bindings = BindingTests.Run();
passed &= bindings.All(result => result.Passed);
var pans = PanTests.Run();
passed &= pans.All(result => result.Passed);
Console.WriteLine(JsonSerializer.Serialize(new { passed, results, bindings, pans }, new JsonSerializerOptions { WriteIndented = true }));
return passed ? 0 : 1;
