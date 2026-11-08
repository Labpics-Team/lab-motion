#include <windows.h>
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
