using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

// Только настройка одноразовой тестовой сессии, не политика приложения.
public static class ClientAreaAnimation
{
    public static long? SetEnteredQpc { get; private set; }
    public static long? SetReturnedQpc { get; private set; }
    public static bool? SetSucceeded { get; private set; }
    public static long? ReadbackQpc { get; private set; }
    public static bool? ReadbackEnabled { get; private set; }
    public static long? QpcFrequency
    {
        get { return Stopwatch.IsHighResolution && Stopwatch.Frequency > 0 && Stopwatch.Frequency <= 9007199254740991
            ? (long?)Stopwatch.Frequency : null; }
    }

    private static long? ReadQpc()
    {
        try
        {
            if (!Stopwatch.IsHighResolution) return null;
            var value = Stopwatch.GetTimestamp();
            return value > 0 && value <= 9007199254740991 ? (long?)value : null;
        }
        catch { return null; } // Недоступное измерение не меняет исход native SET/GET.
    }
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
    private static extern bool Get(uint action, uint unused, out int value, uint flags);

    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
    private static extern bool Set(uint action, uint unused, IntPtr value, uint flags);

    public static bool Read()
    {
        int value;
        if (!Get(0x1042, 0, out value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return value != 0;
    }

    public static void Write(bool enabled)
    {
        SetReturnedQpc = null;
        SetSucceeded = null;
        ReadbackQpc = null;
        ReadbackEnabled = null;
        // SPIF_SENDCHANGE уведомляет сессию; SPIF_UPDATEINIFILE не используется.
        SetEnteredQpc = ReadQpc();
        var success = Set(0x1043, 0, new IntPtr(enabled ? 1 : 0), 2);
        var error = success ? 0 : Marshal.GetLastWin32Error();
        SetReturnedQpc = ReadQpc();
        SetSucceeded = success;
        if (!success) throw new Win32Exception(error);
        ReadbackEnabled = Read();
        ReadbackQpc = ReadQpc();
        if (ReadbackEnabled != enabled) throw new InvalidOperationException("Настройка анимации не подтвердилась.");
    }
}
