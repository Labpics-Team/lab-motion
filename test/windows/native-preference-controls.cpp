#define PREFERENCE_DIAGNOSTICS_TEST
#include "../../examples/windows/native/PreferenceDiagnostics.cpp"
#include <iostream>
#include <thread>
#include <vector>

using namespace PreferenceDiagnostics;
using MessageDelegate = ABI::Windows::Foundation::ITypedEventHandler<View::UISettings*, View::UISettingsMessageDurationChangedEventArgs*>;

// Настоящие SDK ABI и WRL QI/refcount; все неиспользуемые getters отвергаются.
class Settings final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::WinRt>, View::IUISettings, View::IUISettings6>
{
    InspectableClass(L"DiagnosticFixture.Settings", BaseTrust);
public:
    ComPtr<Delegate> event;
    HRESULT addResult = S_OK, removeResult = S_OK;
    int adds = 0, removes = 0;
    bool synchronous = false;
    HRESULT STDMETHODCALLTYPE add_AnimationsEnabledChanged(Delegate* receiver, EventRegistrationToken* token) override
    {
        ++adds;
        if (FAILED(addResult)) return addResult;
        event = receiver;
        token->value = 0; // Ноль допустим: attached определяется HRESULT, не token.
        if (synchronous) return Fire();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE remove_AnimationsEnabledChanged(EventRegistrationToken token) override
    {
        ++removes;
        if (token.value != 0) return E_INVALIDARG;
        if (SUCCEEDED(removeResult)) event.Reset();
        return removeResult;
    }
    HRESULT Fire() { return event->Invoke(static_cast<View::IUISettings*>(this), nullptr); }
    HRESULT STDMETHODCALLTYPE add_MessageDurationChanged(MessageDelegate*, EventRegistrationToken*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE remove_MessageDurationChanged(EventRegistrationToken) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_HandPreference(View::HandPreference*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CursorSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_ScrollBarSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_ScrollBarArrowSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_ScrollBarThumbBoxSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_MessageDuration(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_AnimationsEnabled(boolean*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CaretBrowsingEnabled(boolean*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CaretBlinkRate(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CaretWidth(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_DoubleClickTime(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_MouseHoverTime(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE UIElementColor(View::UIElementType, ABI::Windows::UI::Color*) override { return E_NOTIMPL; }
};

static void Require(bool accepted, const char* name)
{
    if (!accepted) throw name;
}

static Handle* Open(Settings* source, Snapshot& snapshot)
{
    Handle* handle = nullptr;
    const HRESULT hr = PreferenceDiagnosticsCreate(static_cast<View::IUISettings*>(source), &handle, &snapshot);
    Require(SUCCEEDED(hr) && handle, "native-create");
    return handle;
}

namespace WindowControls
{
    namespace W = WindowPreferenceDiagnostics;
    // Конечные числовые фазы fixture; без адресов, HWND, lParam или текста OS error.
    void Phase(unsigned value) { std::cerr << "window-control-phase: " << value << '\n' << std::flush; }
    struct State { int settingForwards = 0; bool revokedBeforeDestroyForward = false; W::Record* record = nullptr; };
    constexpr LRESULT ForwardResult = 0x13579;
    LRESULT CALLBACK Base(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
    {
        auto* state = reinterpret_cast<State*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (state && message == WM_SETTINGCHANGE) { ++state->settingForwards; return ForwardResult; }
        if (state && state->record && message == WM_NCDESTROY)
            state->revokedBeforeDestroyForward = (W::Read(state->record).flags & W::Destroyed) && !(W::Read(state->record).flags & W::Active);
        return DefWindowProcW(window, message, wParam, lParam);
    }
    struct Window
    {
        State state;
        HWND value;
        Window()
        {
            value = CreateWindowExW(0, L"LabMotion.PassiveWindowControl", L"", WS_OVERLAPPED, 0, 0, 1, 1,
                nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
            Require(value != nullptr, "window-fixture-create");
            SetWindowLongPtrW(value, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&state));
        }
        ~Window() { if (value) DestroyWindow(value); }
        void Destroy() { Require(DestroyWindow(value) != FALSE, "window-fixture-destroy"); value = nullptr; }
    };
    void Run()
    {
        Phase(1);
        WNDCLASSW type{};
        type.lpfnWndProc = Base;
        type.hInstance = GetModuleHandleW(nullptr);
        type.lpszClassName = L"LabMotion.PassiveWindowControl";
        Require(RegisterClassW(&type) != 0, "window-fixture-register");
        wchar_t station[256]{};
        DWORD required = 0;
        Require(GetUserObjectInformationW(GetProcessWindowStation(), UOI_NAME, station, sizeof(station), &required) != FALSE,
            "window-fixture-context");
        const DWORD pid = GetCurrentProcessId(), tid = GetCurrentThreadId();
        W::Snapshot captured{};
        W::Record* record = nullptr;
        Require(FAILED(WindowPreferenceDiagnosticsCreate(nullptr, pid, tid, station, &record, &captured)) && !record &&
            !(captured.flags & W::Attached), "window-missing-owner-fault-not-zero");
        Phase(2);
        {
            Window window;
            Require(FAILED(WindowPreferenceDiagnosticsCreate(window.value, pid, 0, station, &record, &captured)) && !record &&
                (captured.flags & W::OwnerMatched) && !(captured.flags & W::SessionChecked) && !(captured.flags & W::SameSession),
                "window-unknown-context-not-match");
            Require(FAILED(WindowPreferenceDiagnosticsCreate(window.value, pid, tid, L"DifferentStation", &record, &captured)) && !record &&
                (captured.flags & W::DesktopChecked) && !(captured.flags & W::SameDesktop), "window-different-station-not-default-match");
            Phase(3);
            Require(SUCCEEDED(WindowPreferenceDiagnosticsCreate(window.value, pid, tid, station, &record, &captured)) && record,
                "window-own-context-create");
            window.state.record = record;
            Require((captured.flags & (W::OwnerMatched | W::SameSession | W::SameDesktop | W::Attached | W::Active | W::ControlPassed)) ==
                (W::OwnerMatched | W::SameSession | W::SameDesktop | W::Attached | W::Active | W::ControlPassed) && captured.controlCount == 1 &&
                captured.controlQpc > 0 && captured.rawCount == 0 && captured.actionCount == 0 && captured.forwardCount == 0,
                "window-control-separate-from-message");
            W::Record* duplicate = nullptr;
            Require(FAILED(WindowPreferenceDiagnosticsCreate(window.value, pid, tid, station, &duplicate, &captured)) && !duplicate &&
                W::recordsAlive == 1, "window-no-subclass-ref-overwrite");
            Phase(4);
            // Только local synthetic messages: ни SPI, ни broadcast, ни профиль.
            for (const WPARAM action : { WPARAM(0), WPARAM(1), W::ClientAreaAnimation })
                Require(SendMessageW(window.value, WM_SETTINGCHANGE, action, LPARAM(0)) == ForwardResult, "window-actual-forward-result");
            Phase(5);
            WindowPreferenceDiagnosticsRead(record, &captured);
            Require(captured.rawCount == 3 && captured.actionCount == 1 && captured.forwardCount == 3 &&
                captured.lastRawQpc > 0 && captured.lastActionQpc > 0 && window.state.settingForwards == 3,
                "window-raw-action-forward-not-control");
            HRESULT wrong = S_OK;
            std::thread other([&]() { W::Snapshot value{}; wrong = WindowPreferenceDiagnosticsClose(record, &value); });
            other.join();
            Phase(6);
            captured = W::Read(record);
            Require(wrong == E_ACCESSDENIED && (captured.flags & W::Attached) && !(captured.flags & (W::Active | W::RemoveAttempted)),
                "window-wrong-thread-no-remove");
            Require(SUCCEEDED(WindowPreferenceDiagnosticsClose(record, &captured)) && !(captured.flags & (W::Attached | W::Active)) &&
                captured.removeResult == S_OK, "window-owner-remove");
            Require(SUCCEEDED(WindowPreferenceDiagnosticsClose(record, &captured)), "window-owner-remove-once");
            Phase(7);
            Require(SendMessageW(window.value, WM_SETTINGCHANGE, W::ClientAreaAnimation, LPARAM(0)) == ForwardResult &&
                W::Read(record).rawCount == 3, "window-success-remove-no-recorder");
            window.state.record = nullptr;
            WindowPreferenceDiagnosticsRelease(record);
            Require(W::recordsAlive == 0, "window-success-record-reclaimed");
            Phase(8);
        }
        {
            Phase(10);
            Window window;
            Require(SUCCEEDED(WindowPreferenceDiagnosticsCreate(window.value, pid, tid, station, &record, &captured)), "window-failed-remove-create");
            window.state.record = record;
            W::failRemove = true;
            Require(FAILED(WindowPreferenceDiagnosticsClose(record, &captured)) && (captured.flags & W::Attached) &&
                (captured.flags & W::Faulted) && !(captured.flags & W::Active), "window-failed-remove-retains-record");
            W::failRemove = false;
            Require(FAILED(WindowPreferenceDiagnosticsClose(record, &captured)), "window-failed-remove-not-retried");
            Phase(11);
            WindowPreferenceDiagnosticsRelease(record);
            Phase(12);
            Require(W::recordsAlive == 1 && SendMessageW(window.value, WM_SETTINGCHANGE, W::ClientAreaAnimation, LPARAM(0)) == ForwardResult &&
                W::Read(record).actionCount == 1, "window-owner-release-late-callback-safe");
            Phase(13);
            window.Destroy();
            Phase(14);
            Require(window.state.revokedBeforeDestroyForward && W::recordsAlive == 0, "window-destroy-revoke-forward-reclaim");
        }
        {
            Phase(20);
            Window window;
            Require(SUCCEEDED(WindowPreferenceDiagnosticsCreate(window.value, pid, tid, station, &record, &captured)), "window-overflow-create");
            window.state.record = record;
            record->snapshot.rawCount = W::MaximumSafeInteger;
            SendMessageW(window.value, WM_SETTINGCHANGE, W::ClientAreaAnimation, LPARAM(0));
            Require(W::Read(record).rawCount == W::MaximumSafeInteger && (W::Read(record).flags & W::Faulted), "window-overflow-explicit");
            Phase(21);
            window.Destroy();
            Phase(22);
            captured = W::Read(record);
            Require((captured.flags & W::Destroyed) && !(captured.flags & (W::Active | W::Attached)) &&
                window.state.revokedBeforeDestroyForward, "window-destroy-owner-snapshot");
            WindowPreferenceDiagnosticsRelease(record);
            Phase(23);
        }
        Require(W::recordsAlive == 0 && UnregisterClassW(type.lpszClassName, type.hInstance) != FALSE, "window-fixture-all-reclaimed");
        Phase(24);
    }
}

int main()
{
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    struct Apartment
    {
        bool initialized;
        ~Apartment() { if (initialized) CoUninitialize(); }
    } apartment{ SUCCEEDED(initialized) };
    try
    {
        Require(SUCCEEDED(initialized), "fixture-mta-initialization");
        Snapshot captured;
        Handle* missing = nullptr;
        Require(FAILED(PreferenceDiagnosticsCreate(nullptr, &missing, &captured)) && !missing &&
            (captured.flags & Faulted) && !(captured.flags & Attached), "missing-source-not-zero-success");
        {
            auto source = Microsoft::WRL::Make<Settings>();
            auto* handle = Open(source.Get(), captured);
            Require((captured.flags & (SameSource | ControlPassed | Attached | Active)) == (SameSource | ControlPassed | Attached | Active)
                && captured.delegateResult == S_OK && captured.marshalResult == S_OK && captured.controlResult == S_OK
                && captured.controlCount == 1 && captured.controlQpc > 0 && captured.count == 0 && captured.lastQpc == 0
                && captured.frequency > 0 && source->adds == 1, "control-separate-reset-before-add-zero-token");
            Require(SUCCEEDED(source->Fire()), "actual-fixture-invoke");
            Require(SUCCEEDED(PreferenceDiagnosticsRead(handle, &captured)) && captured.count == 1 && captured.lastQpc > 0,
                "same-recorder-actual-positive");
            ComPtr<Delegate> inFlight = source->event;
            auto* record = handle->record;
            Require(SUCCEEDED(PreferenceDiagnosticsClose(handle, &captured)) && !(captured.flags & (Attached | Active)), "successful-remove");
            PreferenceDiagnosticsClose(handle, &captured);
            Require(source->removes == 1, "one-only-remove");
            PreferenceDiagnosticsRelease(handle);
            Require(recordsAlive == 1 && SUCCEEDED(inFlight->Invoke(static_cast<View::IUISettings*>(source.Get()), nullptr)), "inflight-record-survives-owner");
            captured = Read(record);
            Require(captured.count == 2 && !(captured.flags & Active), "late-raw-not-active");
            inFlight.Reset();
            Require(recordsAlive == 0, "record-reclaimed-after-last-callback");
        }
        {
            auto source = Microsoft::WRL::Make<Settings>();
            source->removeResult = E_FAIL;
            auto* handle = Open(source.Get(), captured);
            auto* record = handle->record;
            Require(FAILED(PreferenceDiagnosticsClose(handle, &captured)) && (captured.flags & Attached) &&
                (captured.flags & Faulted) && !(captured.flags & Active) && captured.removeResult == E_FAIL, "failed-remove-attached-faulted");
            PreferenceDiagnosticsClose(handle, &captured);
            Require(source->removes == 1, "failed-remove-not-retried");
            PreferenceDiagnosticsRelease(handle);
            Require(recordsAlive == 1 && SUCCEEDED(source->Fire()), "failed-remove-retained-callback-record");
            captured = Read(record);
            Require(captured.count == 1 && !(captured.flags & Active) && (captured.flags & Attached), "failed-remove-late-state");
            source->event.Reset();
            Require(recordsAlive == 0, "failed-remove-no-source-cycle");
        }
        {
            auto source = Microsoft::WRL::Make<Settings>();
            source->addResult = E_ACCESSDENIED;
            Handle* handle = nullptr;
            Require(PreferenceDiagnosticsCreate(static_cast<View::IUISettings*>(source.Get()), &handle, &captured) == E_ACCESSDENIED
                && !handle && (captured.flags & ControlPassed) && (captured.flags & Faulted) && !(captured.flags & (Attached | Active))
                && captured.addResult == E_ACCESSDENIED && recordsAlive == 0, "add-failure-not-source-zero");
        }
        {
            auto source = Microsoft::WRL::Make<Settings>();
            source->synchronous = true;
            auto* handle = Open(source.Get(), captured);
            Require(captured.count == 1 && captured.controlCount == 1, "synchronous-add-entry-after-reset");
            std::vector<std::thread> workers;
            for (int worker = 0; worker < 4; ++worker) workers.emplace_back([source]() {
                for (int index = 0; index < 500; ++index) source->Fire();
            });
            for (auto& worker : workers) worker.join();
            Require(SUCCEEDED(PreferenceDiagnosticsRead(handle, &captured)) && captured.count == 2001 && captured.lastQpc > 0
                && !(captured.flags & Faulted), "concurrent-counter-qpc-coherent");
            AcquireSRWLockExclusive(&handle->record->lock);
            handle->record->snapshot.count = MaximumSafeInteger;
            ReleaseSRWLockExclusive(&handle->record->lock);
            source->Fire();
            PreferenceDiagnosticsRead(handle, &captured);
            Require(captured.count == MaximumSafeInteger && (captured.flags & Faulted), "overflow-explicit-fault");
            PreferenceDiagnosticsClose(handle, &captured);
            PreferenceDiagnosticsRelease(handle);
        }
        Require(recordsAlive == 0, "all-records-reclaimed");
        WindowControls::Run();
        std::cout << "native preference controls: typed ABI/FTM/control-reset/lifetime/faults/concurrency PASS\n";
        return 0;
    }
    catch (const char* failure) { std::cerr << failure << '\n'; return 1; }
    catch (...) { std::cerr << "native-control-unexpected-failure\n"; return 1; }
}
