using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// Только настройка одноразовой тестовой сессии, не политика приложения.
public static class ClientAreaAnimation
{
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
        // SPIF_SENDCHANGE уведомляет сессию; SPIF_UPDATEINIFILE не используется.
        if (!Set(0x1043, 0, new IntPtr(enabled ? 1 : 0), 2))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (Read() != enabled) throw new InvalidOperationException("Настройка анимации не подтвердилась.");
    }
}
