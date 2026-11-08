#include <windows.h>
#include <commctrl.h>
#include <windows.ui.viewmanagement.h>
#include <wrl.h>
#include <cstdint>
#include <new>

namespace PreferenceDiagnostics
{
    static_assert(sizeof(void*) == 8, "diagnostic helper requires x64");
    namespace View = ABI::Windows::UI::ViewManagement;
    using Delegate = ABI::Windows::Foundation::ITypedEventHandler<View::UISettings*, View::UISettingsAnimationsEnabledChangedEventArgs*>;
    using Microsoft::WRL::ComPtr;
    constexpr std::int64_t MaximumSafeInteger = 9007199254740991;
    enum Flag : std::uint32_t { SameSource = 1, ControlPassed = 2, AddAttempted = 4,
        Attached = 8, Active = 16, Faulted = 32, RemoveAttempted = 64 };

    // Фиксированный blittable ABI, без адресов, текстов и native token.
    struct Snapshot
    {
        std::uint32_t schema = 1;
        std::uint32_t flags = 0;
        HRESULT sourceResult = E_PENDING;
        HRESULT delegateResult = E_PENDING;
        HRESULT marshalResult = E_PENDING;
        HRESULT controlResult = E_PENDING;
        HRESULT addResult = E_PENDING;
        HRESULT removeResult = E_PENDING;
        std::int64_t controlCount = 0;
        std::int64_t controlQpc = 0;
        std::int64_t count = 0;
        std::int64_t lastQpc = 0;
        std::int64_t frequency = 0;
    };
    static_assert(sizeof(Snapshot) == 72, "managed/native snapshot ABI");

#ifdef PREFERENCE_DIAGNOSTICS_TEST
    static volatile LONG recordsAlive = 0;
#endif
    // Callback удерживает только эту запись; source и managed owner сюда не входят.
    struct Record
    {
        volatile LONG references = 1;
        SRWLOCK lock = SRWLOCK_INIT;
        Snapshot snapshot;
        bool recording = false;
        Record() noexcept
        {
#ifdef PREFERENCE_DIAGNOSTICS_TEST
            InterlockedIncrement(&recordsAlive);
#endif
            LARGE_INTEGER frequency{};
            if (QueryPerformanceFrequency(&frequency) && frequency.QuadPart > 0 && frequency.QuadPart <= MaximumSafeInteger)
                snapshot.frequency = frequency.QuadPart;
            else snapshot.flags |= Faulted;
        }
        void Retain() noexcept { InterlockedIncrement(&references); }
        void Release() noexcept
        {
            if (InterlockedDecrement(&references) == 0) delete this;
        }
        ~Record() noexcept
        {
#ifdef PREFERENCE_DIAGNOSTICS_TEST
            InterlockedDecrement(&recordsAlive);
#endif
        }
    };

    class Receiver final : public Microsoft::WRL::RuntimeClass<
        Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, Delegate, Microsoft::WRL::FtmBase>
    {
        Record* record;
    public:
        explicit Receiver(Record* recordState) noexcept : record(recordState) { record->Retain(); }
        ~Receiver() { record->Release(); }
        HRESULT STDMETHODCALLTYPE Invoke(View::IUISettings*, View::IUISettingsAnimationsEnabledChangedEventArgs*) override
        {
            // QPC до lock; только bounded запись, без getter/COM conversion/UI/I/O.
            LARGE_INTEGER entered{};
            const bool valid = QueryPerformanceCounter(&entered) && entered.QuadPart > 0 && entered.QuadPart <= MaximumSafeInteger;
            AcquireSRWLockExclusive(&record->lock);
            auto& state = record->snapshot;
            auto& count = record->recording ? state.count : state.controlCount;
            auto& last = record->recording ? state.lastQpc : state.controlQpc;
            if (count < MaximumSafeInteger) ++count;
            else state.flags |= Faulted;
            if (valid) { if (entered.QuadPart > last) last = entered.QuadPart; }
            else state.flags |= Faulted;
            ReleaseSRWLockExclusive(&record->lock);
            return S_OK;
        }
    };

    // Один handle владеет source/token; record переживает его через callback refs.
    struct Handle
    {
        Record* record;
        ComPtr<View::IUISettings6> source;
        ComPtr<Delegate> receiver;
        EventRegistrationToken token{};
        explicit Handle(Record* value) noexcept : record(value) {}
        ~Handle() noexcept
        {
            receiver.Reset();
            source.Reset();
            record->Release();
        }
    };

    Snapshot Read(Record* record) noexcept
    {
        AcquireSRWLockShared(&record->lock);
        Snapshot captured = record->snapshot;
        ReleaseSRWLockShared(&record->lock);
        return captured;
    }

    HRESULT Close(Handle* handle) noexcept
    {
        auto* record = handle->record;
        bool remove = false;
        AcquireSRWLockExclusive(&record->lock);
        auto& state = record->snapshot;
        state.flags &= ~Active; // Отзыв до единственного remove; поздний raw entry остаётся raw.
        if ((state.flags & Attached) && !(state.flags & RemoveAttempted))
        {
            state.flags |= RemoveAttempted;
            remove = true;
        }
        ReleaseSRWLockExclusive(&record->lock);
        if (remove)
        {
            const HRESULT result = handle->source->remove_AnimationsEnabledChanged(handle->token);
            AcquireSRWLockExclusive(&record->lock);
            state.removeResult = result;
            if (SUCCEEDED(result)) state.flags &= ~Attached;
            else state.flags |= Faulted;
            ReleaseSRWLockExclusive(&record->lock);
            return result;
        }
        return Read(record).removeResult;
    }

    HRESULT Create(void* borrowed, Handle** result, Snapshot* snapshot) noexcept
    {
        if (!result || !snapshot) return E_POINTER;
        *result = nullptr;
        *snapshot = Snapshot{};
        Record* record = new (std::nothrow) Record();
        if (!record) { snapshot->flags = Faulted; return E_OUTOFMEMORY; }
        Handle* handle = new (std::nothrow) Handle(record);
        if (!handle) { record->Release(); snapshot->flags = Faulted; return E_OUTOFMEMORY; }
        HRESULT hr = E_POINTER;
        ComPtr<View::IUISettings> sender;
        ComPtr<IUnknown> suppliedIdentity, senderIdentity, sourceIdentity;
        ComPtr<Receiver> callback;
        ComPtr<IMarshal> marshaler;
        if (borrowed)
        {
            auto* supplied = static_cast<IUnknown*>(borrowed);
            hr = supplied->QueryInterface(IID_PPV_ARGS(&handle->source));
            if (SUCCEEDED(hr)) hr = supplied->QueryInterface(IID_PPV_ARGS(&sender));
            if (SUCCEEDED(hr)) hr = supplied->QueryInterface(IID_PPV_ARGS(&suppliedIdentity));
            if (SUCCEEDED(hr)) hr = sender.As(&senderIdentity);
            if (SUCCEEDED(hr)) hr = handle->source.As(&sourceIdentity);
            if (SUCCEEDED(hr) && (suppliedIdentity.Get() != senderIdentity.Get() || suppliedIdentity.Get() != sourceIdentity.Get())) hr = E_UNEXPECTED;
        }
        record->snapshot.sourceResult = hr;
        if (SUCCEEDED(hr))
        {
            record->snapshot.flags |= SameSource;
            callback = Microsoft::WRL::Make<Receiver>(record);
            hr = callback ? callback.As(&handle->receiver) : E_OUTOFMEMORY;
            record->snapshot.delegateResult = hr;
            if (SUCCEEDED(hr))
            {
                // FtmBase подтверждается IMarshal; IAgileObject не обязателен для FTM.
                hr = callback.As(&marshaler);
                record->snapshot.marshalResult = hr;
            }
            if (SUCCEEDED(hr))
            {
                hr = handle->receiver->Invoke(sender.Get(), nullptr);
                record->snapshot.controlResult = hr;
                const auto control = Read(record);
                if (SUCCEEDED(hr) && (control.controlCount != 1 || control.controlQpc <= 0 || control.frequency <= 0 || (control.flags & Faulted)))
                    hr = E_UNEXPECTED;
            }
            if (SUCCEEDED(hr))
            {
                AcquireSRWLockExclusive(&record->lock);
                record->snapshot.flags |= ControlPassed | AddAttempted | Active;
                record->snapshot.count = 0;
                record->snapshot.lastQpc = 0;
                record->recording = true; // До add: синхронный native entry не потеряется.
                ReleaseSRWLockExclusive(&record->lock);
                hr = handle->source->add_AnimationsEnabledChanged(handle->receiver.Get(), &handle->token);
                AcquireSRWLockExclusive(&record->lock);
                record->snapshot.addResult = hr;
                if (SUCCEEDED(hr)) record->snapshot.flags |= Attached;
                ReleaseSRWLockExclusive(&record->lock);
            }
        }
        if (FAILED(hr))
        {
            AcquireSRWLockExclusive(&record->lock);
            record->snapshot.flags = (record->snapshot.flags | Faulted) & ~Active;
            ReleaseSRWLockExclusive(&record->lock);
        }
        *snapshot = Read(record);
        if (SUCCEEDED(hr)) *result = handle;
        else delete handle;
        return hr;
    }
}

extern "C" __declspec(dllexport) HRESULT __stdcall PreferenceDiagnosticsCreate(void* borrowed, PreferenceDiagnostics::Handle** result, PreferenceDiagnostics::Snapshot* snapshot) noexcept
{ return PreferenceDiagnostics::Create(borrowed, result, snapshot); }

extern "C" __declspec(dllexport) HRESULT __stdcall PreferenceDiagnosticsRead(PreferenceDiagnostics::Handle* handle, PreferenceDiagnostics::Snapshot* snapshot) noexcept
{
    if (!handle || !snapshot) return E_POINTER;
    *snapshot = PreferenceDiagnostics::Read(handle->record);
    return S_OK;
}

extern "C" __declspec(dllexport) HRESULT __stdcall PreferenceDiagnosticsClose(PreferenceDiagnostics::Handle* handle, PreferenceDiagnostics::Snapshot* snapshot) noexcept
{
    if (!handle || !snapshot) return E_POINTER;
    const HRESULT result = PreferenceDiagnostics::Close(handle);
    *snapshot = PreferenceDiagnostics::Read(handle->record);
    return result;
}

extern "C" __declspec(dllexport) void __stdcall PreferenceDiagnosticsRelease(PreferenceDiagnostics::Handle* handle) noexcept
{
    if (!handle) return;
    // SafeHandle finalizer не вызывает COM remove на чужом apartment.
    AcquireSRWLockExclusive(&handle->record->lock);
    auto& state = handle->record->snapshot;
    state.flags &= ~PreferenceDiagnostics::Active;
    if (state.flags & PreferenceDiagnostics::Attached) state.flags |= PreferenceDiagnostics::Faulted;
    ReleaseSRWLockExclusive(&handle->record->lock);
    delete handle;
}

// Независимый пассивный HWND receipt; исходный UISettings ABI выше не меняется.
namespace WindowPreferenceDiagnostics
{
    constexpr std::int64_t MaximumSafeInteger = PreferenceDiagnostics::MaximumSafeInteger;
    constexpr UINT SettingChange = WM_SETTINGCHANGE;
    constexpr WPARAM ClientAreaAnimation = SPI_SETCLIENTAREAANIMATION;
    constexpr UINT_PTR SubclassId = 0x4c4d574d;
    enum Flag : std::uint32_t { OwnerMatched = 1, SessionChecked = 2, SameSession = 4,
        DesktopChecked = 8, SameDesktop = 16, ControlPassed = 32, AddAttempted = 64,
        Attached = 128, Active = 256, Faulted = 512, RemoveAttempted = 1024, Destroyed = 2048 };
    struct Snapshot
    {
        std::uint32_t schema = 1, flags = 0;
        HRESULT ownerResult = E_PENDING, contextResult = E_PENDING, controlResult = E_PENDING;
        HRESULT addResult = E_PENDING, removeResult = E_PENDING;
        std::uint32_t reserved = 0;
        std::int64_t controlCount = 0, controlQpc = 0, rawCount = 0, actionCount = 0;
        std::int64_t lastRawQpc = 0, lastActionQpc = 0, frequency = 0, forwardCount = 0;
    };
    static_assert(sizeof(Snapshot) == 96, "window managed/native snapshot ABI");
#ifdef PREFERENCE_DIAGNOSTICS_TEST
    static volatile LONG recordsAlive = 0;
    static bool failRemove = false;
#endif
    struct Record
    {
        volatile LONG references = 1;
        SRWLOCK lock = SRWLOCK_INIT;
        Snapshot snapshot;
        HWND window = nullptr;
        DWORD ownerThread = 0;
        bool recording = false, windowReference = false;
        Record() noexcept
        {
#ifdef PREFERENCE_DIAGNOSTICS_TEST
            InterlockedIncrement(&recordsAlive);
#endif
            LARGE_INTEGER frequency{};
            if (QueryPerformanceFrequency(&frequency) && frequency.QuadPart > 0 && frequency.QuadPart <= MaximumSafeInteger)
                snapshot.frequency = frequency.QuadPart;
            else snapshot.flags |= Faulted;
        }
        void Retain() noexcept { InterlockedIncrement(&references); }
        void Release() noexcept { if (InterlockedDecrement(&references) == 0) delete this; }
        ~Record() noexcept
        {
#ifdef PREFERENCE_DIAGNOSTICS_TEST
            InterlockedDecrement(&recordsAlive);
#endif
        }
    };
    Snapshot Read(Record* record) noexcept
    {
        AcquireSRWLockShared(&record->lock);
        const Snapshot captured = record->snapshot;
        ReleaseSRWLockShared(&record->lock);
        return captured;
    }
    void Increment(std::int64_t& count, Snapshot& state) noexcept
    {
        if (count < MaximumSafeInteger) ++count;
        else state.flags |= Faulted;
    }
    void Observe(Record* record, WPARAM action) noexcept
    {
        LARGE_INTEGER entered{};
        const bool valid = QueryPerformanceCounter(&entered) && entered.QuadPart > 0 && entered.QuadPart <= MaximumSafeInteger;
        AcquireSRWLockExclusive(&record->lock);
        auto& state = record->snapshot;
        if (!record->recording)
        {
            Increment(state.controlCount, state);
            if (valid) state.controlQpc = entered.QuadPart;
        }
        else
        {
            Increment(state.rawCount, state);
            if (valid && entered.QuadPart > state.lastRawQpc) state.lastRawQpc = entered.QuadPart;
            if (action == ClientAreaAnimation)
            {
                Increment(state.actionCount, state);
                if (valid && entered.QuadPart > state.lastActionQpc) state.lastActionQpc = entered.QuadPart;
            }
        }
        if (!valid) state.flags |= Faulted;
        ReleaseSRWLockExclusive(&record->lock);
    }
    LRESULT CALLBACK WindowMessage(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR id, DWORD_PTR reference) noexcept;
    BOOL Remove(HWND window) noexcept
    {
#ifdef PREFERENCE_DIAGNOSTICS_TEST
        if (failRemove) return FALSE;
#endif
        return RemoveWindowSubclass(window, WindowMessage, SubclassId);
    }
    HRESULT Close(Record* record) noexcept
    {
        HWND window = nullptr;
        AcquireSRWLockExclusive(&record->lock);
        auto& state = record->snapshot;
        state.flags &= ~Active;
        if (GetCurrentThreadId() != record->ownerThread)
        {
            state.flags |= Faulted;
            ReleaseSRWLockExclusive(&record->lock);
            return E_ACCESSDENIED;
        }
        if ((state.flags & Attached) && !(state.flags & RemoveAttempted))
        {
            state.flags |= RemoveAttempted;
            window = record->window;
        }
        ReleaseSRWLockExclusive(&record->lock);
        if (!window) return Read(record).removeResult;
        const HRESULT result = Remove(window) ? S_OK : E_FAIL;
        bool release = false;
        AcquireSRWLockExclusive(&record->lock);
        state.removeResult = result;
        if (SUCCEEDED(result))
        {
            state.flags &= ~Attached;
            record->window = nullptr;
            release = record->windowReference;
            record->windowReference = false;
        }
        else state.flags |= Faulted;
        ReleaseSRWLockExclusive(&record->lock);
        if (release) record->Release();
        return result;
    }
    LRESULT CALLBACK WindowMessage(HWND window, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR id, DWORD_PTR reference) noexcept
    {
        auto* record = reinterpret_cast<Record*>(reference);
        record->Retain(); // window reference защищает вход, local reference — forwarding/reentrance.
        const bool matches = window == record->window && id == SubclassId;
        const bool setting = matches && message == SettingChange;
        const bool destroying = matches && message == WM_NCDESTROY;
        if (setting) Observe(record, wParam);
        bool releaseWindow = false;
        if (destroying)
        {
            AcquireSRWLockExclusive(&record->lock);
            const bool remove = !(record->snapshot.flags & RemoveAttempted);
            record->snapshot.flags = (record->snapshot.flags | Destroyed) & ~Active;
            record->window = nullptr; // До forwarding: HWND больше не является нашим ресурсом.
            ReleaseSRWLockExclusive(&record->lock);
            const HRESULT removed = remove ? (Remove(window) ? S_OK : E_FAIL) : Read(record).removeResult;
            AcquireSRWLockExclusive(&record->lock);
            auto& state = record->snapshot;
            state.flags |= RemoveAttempted;
            if (state.removeResult == E_PENDING) state.removeResult = removed;
            if (FAILED(removed)) state.flags |= Faulted;
            state.flags &= ~Attached; // Destroy завершает lifetime даже после failed remove.
            releaseWindow = record->windowReference;
            record->windowReference = false;
            ReleaseSRWLockExclusive(&record->lock);
        }
        const LRESULT result = DefSubclassProc(window, message, wParam, lParam);
        if (setting)
        {
            AcquireSRWLockExclusive(&record->lock);
            Increment(record->snapshot.forwardCount, record->snapshot);
            ReleaseSRWLockExclusive(&record->lock);
        }
        if (releaseWindow) record->Release();
        record->Release();
        return result;
    }
    HRESULT CheckContext(Record* record, DWORD setterProcess, DWORD setterThread, const wchar_t* setterStation) noexcept
    {
        DWORD process = 0;
        record->ownerThread = GetWindowThreadProcessId(record->window, &process);
        if (!record->ownerThread || record->ownerThread != GetCurrentThreadId() || process != GetCurrentProcessId())
            return record->snapshot.ownerResult = E_ACCESSDENIED;
        record->snapshot.ownerResult = S_OK;
        record->snapshot.flags |= OwnerMatched;
        HANDLE thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, setterThread);
        if (!thread) return E_ACCESSDENIED;
        const bool belongs = GetProcessIdOfThread(thread) == setterProcess;
        CloseHandle(thread);
        if (!belongs) return E_ACCESSDENIED;
        DWORD ownSession = 0, setterSession = 0;
        if (!ProcessIdToSessionId(process, &ownSession) || !ProcessIdToSessionId(setterProcess, &setterSession)) return E_FAIL;
        record->snapshot.flags |= SessionChecked;
        if (ownSession != setterSession) return E_ACCESSDENIED;
        record->snapshot.flags |= SameSession;
        wchar_t ownName[256]{}, setterName[256]{}, ownStation[256]{};
        DWORD required = 0;
        const HDESK ownDesktop = GetThreadDesktop(record->ownerThread);
        const HDESK setterDesktop = GetThreadDesktop(setterThread);
        if (!setterStation || !ownDesktop || !setterDesktop ||
            !GetUserObjectInformationW(GetProcessWindowStation(), UOI_NAME, ownStation, sizeof(ownStation), &required) ||
            !GetUserObjectInformationW(ownDesktop, UOI_NAME, ownName, sizeof(ownName), &required) ||
            !GetUserObjectInformationW(setterDesktop, UOI_NAME, setterName, sizeof(setterName), &required)) return E_FAIL;
        record->snapshot.flags |= DesktopChecked;
        if (CompareStringOrdinal(ownName, -1, setterName, -1, TRUE) != CSTR_EQUAL ||
            CompareStringOrdinal(ownStation, -1, setterStation, -1, TRUE) != CSTR_EQUAL) return E_ACCESSDENIED;
        record->snapshot.flags |= SameDesktop;
        return S_OK;
    }
    HRESULT Create(HWND window, DWORD setterProcess, DWORD setterThread, const wchar_t* setterStation, Record** result, Snapshot* snapshot) noexcept
    {
        if (!result || !snapshot) return E_POINTER;
        *result = nullptr;
        *snapshot = Snapshot{};
        auto* record = new (std::nothrow) Record();
        if (!record) { snapshot->flags = Faulted; return E_OUTOFMEMORY; }
        record->window = window;
        HRESULT hr = CheckContext(record, setterProcess, setterThread, setterStation);
        record->snapshot.contextResult = hr;
        if (SUCCEEDED(hr))
        {
            Observe(record, ClientAreaAnimation); // Direct recorder control, не system message.
            const auto control = Read(record);
            hr = control.controlCount == 1 && control.controlQpc > 0 && control.frequency > 0 && !(control.flags & Faulted) ? S_OK : E_UNEXPECTED;
            record->snapshot.controlResult = hr;
        }
        if (SUCCEEDED(hr))
        {
            DWORD_PTR existing = 0;
            if (GetWindowSubclass(window, WindowMessage, SubclassId, &existing)) hr = E_UNEXPECTED;
        }
        if (SUCCEEDED(hr))
        {
            record->snapshot.flags |= ControlPassed | AddAttempted | Active;
            record->recording = true; // До attach: возможный синхронный entry не потеряется.
            record->Retain();
            record->windowReference = true;
            hr = SetWindowSubclass(window, WindowMessage, SubclassId, reinterpret_cast<DWORD_PTR>(record)) ? S_OK : E_FAIL;
            record->snapshot.addResult = hr;
            if (SUCCEEDED(hr) && !(record->snapshot.flags & Destroyed)) record->snapshot.flags |= Attached;
            else if (SUCCEEDED(hr)) hr = E_ABORT;
            else { record->windowReference = false; record->Release(); }
        }
        if (FAILED(hr)) record->snapshot.flags = (record->snapshot.flags | Faulted) & ~Active;
        *snapshot = Read(record);
        if (SUCCEEDED(hr)) *result = record;
        else record->Release();
        return hr;
    }
}

extern "C" __declspec(dllexport) HRESULT __stdcall WindowPreferenceDiagnosticsCreate(HWND window, DWORD setterProcess, DWORD setterThread, const wchar_t* setterStation,
    WindowPreferenceDiagnostics::Record** result, WindowPreferenceDiagnostics::Snapshot* snapshot) noexcept
{ return WindowPreferenceDiagnostics::Create(window, setterProcess, setterThread, setterStation, result, snapshot); }
extern "C" __declspec(dllexport) HRESULT __stdcall WindowPreferenceDiagnosticsRead(WindowPreferenceDiagnostics::Record* record,
    WindowPreferenceDiagnostics::Snapshot* snapshot) noexcept
{
    if (!record || !snapshot) return E_POINTER;
    *snapshot = WindowPreferenceDiagnostics::Read(record);
    return S_OK;
}
extern "C" __declspec(dllexport) HRESULT __stdcall WindowPreferenceDiagnosticsClose(WindowPreferenceDiagnostics::Record* record,
    WindowPreferenceDiagnostics::Snapshot* snapshot) noexcept
{
    if (!record || !snapshot) return E_POINTER;
    const HRESULT result = WindowPreferenceDiagnostics::Close(record);
    *snapshot = WindowPreferenceDiagnostics::Read(record);
    return result;
}
extern "C" __declspec(dllexport) void __stdcall WindowPreferenceDiagnosticsRelease(WindowPreferenceDiagnostics::Record* record) noexcept
{
    if (!record) return;
    AcquireSRWLockExclusive(&record->lock);
    record->snapshot.flags &= ~WindowPreferenceDiagnostics::Active;
    if (record->snapshot.flags & WindowPreferenceDiagnostics::Attached) record->snapshot.flags |= WindowPreferenceDiagnostics::Faulted;
    ReleaseSRWLockExclusive(&record->lock);
    record->Release(); // Finalizer не вызывает cross-thread remove; HWND ref живёт до destroy.
}
