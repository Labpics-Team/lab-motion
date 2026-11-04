using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace NativeWindow;

// Диагностика тестового запуска. Callback кадра только добавляет запись в память.
internal sealed class PressTrace : IDisposable
{
    private const int MaximumEvents = 16384;
    private readonly object gate = new();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly List<object> pending = [];
    private readonly string path;
    private long sequence;
    private bool disposed;

    private PressTrace(string path)
    {
        this.path = path;
        using var created = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
    }

    public static PressTrace? FromEnvironment()
    {
        var path = Environment.GetEnvironmentVariable("LAB_MOTION_PRESS_TRACE");
        return path is null ? null : new PressTrace(path);
    }

    public void Add(string kind, object data)
    {
        lock (gate)
        {
            if (disposed || sequence > MaximumEvents) return;
            if (sequence == MaximumEvents)
            {
                kind = "truncated";
                data = new { maximumEvents = MaximumEvents };
            }
            pending.Add(new { sequence = ++sequence, seconds = clock.Elapsed.TotalSeconds, kind, data });
        }
    }

    public void Flush()
    {
        lock (gate)
        {
            if (disposed || pending.Count == 0) return;
            using var writer = new StreamWriter(path, true, new UTF8Encoding(false));
            foreach (var entry in pending) writer.WriteLine(JsonSerializer.Serialize(entry));
            writer.Flush();
            pending.Clear();
        }
    }

    private void OnProcessExit(object? sender, EventArgs args)
    {
        Add("processExit", new { });
        Dispose();
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            Flush();
            disposed = true;
            AppDomain.CurrentDomain.ProcessExit -= OnProcessExit;
        }
    }
}
